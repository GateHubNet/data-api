import { randomUUID } from 'node:crypto';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { ParseContext } from '../parsers/parser.interface';
import { allSettledOrThrow, chunk } from '../util/helpers';
import { buildLedgerRows, CHILD_TABLES } from './build-rows';
import { RawLedger } from './raw-ledger';

/** Rows per INSERT unless the caller says otherwise. */
export const DEFAULT_MAX_ROWS_PER_INSERT = 50_000;

/** What a successful `LedgerWriter.write()` reports besides the rows: the ledgers' diagnostics, summed over the batch. */
export interface LedgerWriteResult {
  /**
   * Pools of AMM transactions the parser could make no swap, liquidity or governance row for (`LedgerRows.diagnostics`).
   * Counted once a batch is written, not when the write fails and is retried: the caller adds it to
   * `syncer_amm_unclassified_total`.
   */
  ammUnclassified: number;
}

export interface LedgerWriterOptions {
  /** Identifies this writer in the dedup tokens. Default: a random UUID. */
  runId?: string;
  /** Upper bound on the rows of one INSERT. Default: `DEFAULT_MAX_ROWS_PER_INSERT`. */
  maxRowsPerInsert?: number;
}

/**
 * Writes ledgers to ClickHouse so that a ledger either is fully there or counts as absent.
 *
 * `write()` inserts, in this order:
 *  1. the rows of every child table (transactions, payments, ...), all tables in parallel,
 *  2. `ledger_by_hash`,
 *  3. `ledgers`.
 * The `ledgers` row is the commit marker: a ledger is committed exactly when it has one, and a failed `write()` leaves
 * at most child rows of ledgers that have none. Nothing reads those; recovery removes them.
 *
 * Every insert carries a dedup token `${runId}:${table}:${firstLedger}-${lastLedger}:${chunkNo}` and the same string as
 * its `query_id`, so retrying the same batch with the same writer after a failure re-sends only what did not go in
 * (the server drops the rest as replays), and everything a run has in flight can be found, and killed, by `runId`.
 *
 * **Recovery contract.** When `write()` throws:
 *  1. `await awaitQuiescence(ch, writer.runId)`: a request the client gave up on (a timeout) may still be running on the
 *     server, and its rows would land behind the delete. `write()` itself never rejects while one of its own client
 *     calls is pending, but that says nothing about what the server is still doing.
 *  2. Re-read `committedCheckpoint(ch)`.
 *  3. `await deleteLedgersAbove(ch, checkpoint, { queryIdPrefix })`, then `await awaitQuiescence(ch, queryIdPrefix)` for
 *     the same reason (a DELETE the client timed out on is a mutation that may still be running).
 *  4. Carry on with `writer.withNewRunId()`, never with `writer`. The tables remember the tokens of their last 1000
 *     inserts and that memory survives a DELETE: once rows of a `runId` have been deleted, inserting them again under
 *     that `runId` is silently dropped, while the commit marker (a token that was never used) goes in. The ledger would
 *     look committed with its rows gone.
 *
 * A retry with the same writer is only safe without a delete in between, and only for the same batch of ledgers: other
 * batch bounds give other tokens, which do not deduplicate.
 */
export class LedgerWriter {
  readonly runId: string;
  private readonly maxRowsPerInsert: number;

  constructor(
    private readonly ch: ClickHouseService,
    private readonly ctx: ParseContext,
    opts: LedgerWriterOptions = {},
  ) {
    this.runId = opts.runId ?? randomUUID();
    this.maxRowsPerInsert = opts.maxRowsPerInsert ?? DEFAULT_MAX_ROWS_PER_INSERT;
    if (!Number.isInteger(this.maxRowsPerInsert) || this.maxRowsPerInsert < 1) {
      throw new RangeError(`maxRowsPerInsert must be a positive integer, got ${this.maxRowsPerInsert}`);
    }
  }

  /**
   * A writer for the same connection, parse context and limits under a new `runId` (random unless given): the one to
   * carry on with after a failure and a delete, see the recovery contract above. Passing the current `runId` defeats
   * the purpose.
   */
  withNewRunId(runId?: string): LedgerWriter {
    return new LedgerWriter(this.ch, this.ctx, { runId, maxRowsPerInsert: this.maxRowsPerInsert });
  }

  /**
   * Write the ledgers as one batch: the rows of all of them are concatenated per table. Throws on the first failure
   * (after every insert of this call has settled on the client); the caller recovers as the class description says.
   *
   * Every ledger is parsed before the first insert: a ledger the parser rejects throws a `LedgerParseError` (naming the
   * ledger) with nothing of the batch written, so the caller may write the ledgers before it with this same writer.
   *
   * Resolves to the diagnostics of the batch once it is committed; a failure throws and reports nothing.
   */
  async write(ledgers: RawLedger[]): Promise<LedgerWriteResult> {
    if (ledgers.length === 0) return { ammUnclassified: 0 };

    // Parsing is pure and throws before anything has been written.
    const built = ledgers.map((raw) => buildLedgerRows(raw, this.ctx));
    const byIndex = [...built].sort((a, b) => a.ledger.ledger_index - b.ledger.ledger_index);
    const span = `${byIndex[0].ledger.ledger_index}-${byIndex[byIndex.length - 1].ledger.ledger_index}`;

    await allSettledOrThrow(
      CHILD_TABLES.map(([table, key]) =>
        this.insertChunks(
          table,
          span,
          byIndex.flatMap((rows) => rows[key] as unknown[]),
        ),
      ),
    );
    await this.insertChunks(
      Table.LedgerByHash,
      span,
      byIndex.map((rows) => rows.ledgerByHash),
    );
    // The commit. In ascending order, so that if the batch ever takes more than one insert the lower ledgers commit first
    // and the checkpoint never skips over an uncommitted ledger.
    await this.insertChunks(
      Table.Ledgers,
      span,
      byIndex.map((rows) => rows.ledger),
    );
    return { ammUnclassified: byIndex.reduce((sum, rows) => sum + rows.diagnostics.ammUnclassified, 0) };
  }

  /** Insert `rows` in chunks of at most `maxRowsPerInsert`, one after the other; no rows, no insert. */
  private async insertChunks(table: Table, span: string, rows: unknown[]): Promise<void> {
    const chunks = chunk(rows, this.maxRowsPerInsert);
    for (const [chunkNo, part] of chunks.entries()) {
      const id = `${this.runId}:${table}:${span}:${chunkNo}`;
      await this.ch.insert(table, part, { dedupToken: id, queryId: id });
    }
  }
}
