import { ClickHouseService, STATE_PARSER_VERSION, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { DATE_TOO_OLD, LedgerSelector } from '../accounts/account-ledger';
import { CacheService } from './cache.service';
import { badRequest } from './errors';
import { LedgerRangeResolver } from './ledger-range.service';

/** A stored ledger a historical read is answered at. */
export interface StateLedger {
  ledger_index: number;
  /** Unix seconds. */
  close_time: number;
}

/**
 * How long the coverage of the state tables is kept. It moves only when ledgers are written or rewritten by an older
 * parser (a reprocess, a backfill), never with the live ingest, which writes the current version.
 */
export const STATE_COVERAGE_CACHE_MS = 60_000;

const COVERAGE_KEY = 'state-coverage';

/**
 * The ledger of a historical read from the state tables (`account_states`; ADR-0015): `/v2/accounts/:address?flags=true`
 * with a ledger named, and the trust line and balance reads that follow it.
 *
 * `resolve` turns the selector of the request (`ledgerSelector`) into a stored ledger, in ClickHouse and never on the node,
 * with the precedence of `/balances`: a hash wins, then a date, then a ledger number.
 *  - A hash is the stored ledger with that hash.
 *  - A date is the last stored ledger closed at or before it.
 *  - A number is the stored ledger with that index.
 *
 * A selector that names no ledger, or names one with a word (`validated`, `closed`, `current`), is not historical:
 * `resolve` answers `undefined` and the caller reads the live node.
 *
 * A ledger that is not stored, or that the state tables do not cover, answers 400 `the date provided is too old`, the
 * original's message for a ledger the node did not have. The state tables cover ledger L when every stored ledger from L
 * up was written by a parser that records state (`STATE_PARSER_VERSION` or later); gaps in the ledger numbers do not
 * matter. So the coverage starts above the newest ledger an older parser wrote, or at the first ledger when there is none.
 * It relies on the stored ledgers being complete above its start (a missing ledger's changes would be missing from the
 * state, unseen here), which gap repair keeps (docs/backfill.md).
 */
@Injectable()
export class StateLedgerService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
    private readonly cache: CacheService,
  ) {}

  async resolve(selector: LedgerSelector): Promise<StateLedger | undefined> {
    let found: StateLedger | undefined;
    if (selector.hash !== undefined) {
      found = await this.byHash(selector.hash);
    } else if (selector.date !== undefined) {
      const index = await this.ranges.ledgerAtOrBefore(selector.date);
      found = index === undefined ? undefined : await this.byIndex(index);
    } else if (typeof selector.index === 'number') {
      found = await this.byIndex(selector.index);
    } else {
      return undefined;
    }
    if (found === undefined || !(await this.covers(found.ledger_index))) throw badRequest(DATE_TOO_OLD);
    return found;
  }

  /**
   * The newest stored ledger, for a read from the state tables that names no ledger (`/trustlines`). 400 `the date
   * provided is too old` when there is none, or when the state tables do not cover it (an older parser wrote it).
   */
  async latest(): Promise<StateLedger> {
    const index = await this.ranges.latest();
    const found = index === undefined ? undefined : await this.byIndex(index);
    if (found === undefined || !(await this.covers(found.ledger_index))) throw badRequest(DATE_TOO_OLD);
    return found;
  }

  /** Whether the state tables hold the state of `ledgerIndex`. */
  async covers(ledgerIndex: number): Promise<boolean> {
    const newestOlder = await this.cache.wrap(COVERAGE_KEY, STATE_COVERAGE_CACHE_MS, () => this.newestOlderLedger());
    return newestOlder === null || ledgerIndex > newestOlder;
  }

  /** The newest stored ledger a parser older than `STATE_PARSER_VERSION` wrote, `null` when there is none. */
  private async newestOlderLedger(): Promise<number | null> {
    const [row] = await this.ch.query<{ ledger_index: number | null }>(
      `SELECT maxOrNull(ledger_index) AS ledger_index FROM ${Table.Ledgers} WHERE parser_version < {version:UInt16}`,
      { version: STATE_PARSER_VERSION },
    );
    return row?.ledger_index ?? null;
  }

  private async byHash(hash: string): Promise<StateLedger | undefined> {
    // Both lookups must agree: the lookup table is written before the commit marker and names the index.
    const [row] = await this.ch.query<StateLedger>(
      `SELECT ledger_index, toUnixTimestamp(close_time) AS close_time FROM ${Table.Ledgers}
        WHERE ledger_index IN (SELECT ledger_index FROM ${Table.LedgerByHash} WHERE ledger_hash = {hash:String})
          AND ledger_hash = {hash:String}
        LIMIT 1`,
      { hash },
    );
    return row;
  }

  private async byIndex(ledgerIndex: number): Promise<StateLedger | undefined> {
    const [row] = await this.ch.query<StateLedger>(
      `SELECT ledger_index, toUnixTimestamp(close_time) AS close_time FROM ${Table.Ledgers}
        WHERE ledger_index = {ledgerIndex:UInt32} LIMIT 1`,
      { ledgerIndex },
    );
    return row;
  }
}
