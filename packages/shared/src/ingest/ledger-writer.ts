import { randomUUID } from 'node:crypto';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { ParseContext } from '../parsers/parser.interface';
import { allSettledOrThrow, chunk } from '../util/helpers';
import { buildLedgerRows, CHILD_TABLES } from './build-rows';
import { RawLedger } from './raw-ledger';

/** Rows per INSERT unless the caller says otherwise. */
export const DEFAULT_MAX_ROWS_PER_INSERT = 50_000;

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
 * at most child rows of ledgers that have none. Nothing reads those; recovery removes them with
 * `deleteLedgersAbove(committedCheckpoint())` (see `ingest-state.ts`).
 *
 * Every insert carries a dedup token `${runId}:${table}:${firstLedger}-${lastLedger}:${chunkNo}`, so retrying the same
 * batch with the same writer after a failure re-sends only what did not go in; the server drops the rest as replays.
 *
 * **Recovery needs a new writer.** The tables remember the tokens of their last 1000 inserts, and that memory survives
 * a DELETE. Once rows of a `runId` have been deleted, inserting them again under that `runId` is silently dropped, while
 * the commit marker (a token that was never used) goes in: the ledger would look committed with its rows gone. So after
 * a failure, delete what is above the checkpoint and carry on with `new LedgerWriter(...)`, which has a new `runId`. A
 * retry with the same writer is only safe without a delete in between, and only for the same batch of ledgers: other
 * batch bounds give other tokens, which do not deduplicate.
 *
 * `write()` does not reject while an insert of its own is still running, so by the time the caller sees the error no
 * insert of that attempt can still land behind a recovery. (A request the client gave up on may still be running
 * server-side; callers with a request timeout should let it pass before they delete.)
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
   * Write the ledgers as one batch: the rows of all of them are concatenated per table. Throws on the first failure
   * (after every running insert has finished); the caller decides how to recover, see the class description.
   */
  async write(ledgers: RawLedger[]): Promise<void> {
    if (ledgers.length === 0) return;

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
  }

  /** Insert `rows` in chunks of at most `maxRowsPerInsert`, one after the other; no rows, no insert. */
  private async insertChunks(table: Table, span: string, rows: unknown[]): Promise<void> {
    const chunks = chunk(rows, this.maxRowsPerInsert);
    for (const [chunkNo, part] of chunks.entries()) {
      await this.ch.insert(table, part, { dedupToken: `${this.runId}:${table}:${span}:${chunkNo}` });
    }
  }
}
