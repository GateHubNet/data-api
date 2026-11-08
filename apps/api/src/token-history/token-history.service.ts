import { ClickHouseService, liveTokenHistory, readTokenHistoryStates, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { Query } from '../common/params';
import { LedgerLookups, LiveTokenHistory, resolveTokenHistoryLedger } from './token-history-ledger';

/** How long the live generation is kept: a window moves it about every 4 s, and an answer may be that much behind (spec 5.0). */
export const TOKEN_HISTORY_LIVE_CACHE_MS = 5_000;

const LIVE_KEY = 'token-history:live';

/**
 * The live generation of the token history (spec 4.6, 5.0), and the ledger of a request against it. The routes answer as of the
 * generation's `levels_through`: the worker writes it last in every window, and a generation promoted a few ledgers short of its
 * `through_ledger` answers at its `levels_through` until the catch-up closes the gap.
 */
@Injectable()
export class TokenHistoryService implements LedgerLookups {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly cache: CacheService,
    private readonly ranges: LedgerRangeResolver,
  ) {}

  /** The live generation, kept 5 s under one key; `undefined` before the first is live. */
  live(): Promise<LiveTokenHistory | undefined> {
    return this.cache.wrap(LIVE_KEY, TOKEN_HISTORY_LIVE_CACHE_MS, async () => {
      const live = liveTokenHistory(await readTokenHistoryStates(this.ch));
      if (live === undefined) return undefined;
      const [row] = await this.ch.query<{ close_time: number | string }>(
        `SELECT toUnixTimestamp(close_time) AS close_time FROM ${Table.Ledgers} WHERE ledger_index = {n:UInt32} LIMIT 1`,
        { n: live.levels_through },
      );
      return {
        generation: live.generation,
        through: live.levels_through,
        close_time: Number(row?.close_time ?? 0),
        coverage_from: live.coverage_from,
      };
    });
  }

  /** The ledger of a request (`resolveTokenHistoryLedger`), with this service's reads. */
  resolveLedger(q: Query, live: LiveTokenHistory, opts: { required?: boolean } = {}): Promise<number> {
    return resolveTokenHistoryLedger(q, live, this, opts);
  }

  atOrBefore(date: Date): Promise<number | undefined> {
    return this.ranges.ledgerAtOrBefore(date);
  }

  /** The stored ledger of a hash: both lookups must agree, as `StateLedgerService` reads it. */
  async byHash(hash: string): Promise<number | undefined> {
    const [row] = await this.ch.query<{ ledger_index: number | string }>(
      `SELECT ledger_index FROM ${Table.Ledgers}
        WHERE ledger_index IN (SELECT ledger_index FROM ${Table.LedgerByHash} WHERE ledger_hash = {hash:String})
          AND ledger_hash = {hash:String}
        LIMIT 1`,
      { hash },
    );
    return row === undefined ? undefined : Number(row.ledger_index);
  }
}
