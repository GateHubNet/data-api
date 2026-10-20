import { Asset, ClickHouseService, MarketsPeriod, RatesService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import {
  MarketsAnswer,
  marketsAnswer,
  NoMarketsAnswer,
  noMarketsAnswer,
  StoredMarket,
  StoredMarketsSet,
} from './markets-object';

/** What `GET /v2/network/markets` is asked for; the values are already validated. */
export interface MarketsQuery {
  period: MarketsPeriod;
  minTrades: number;
  limit: number;
  /** Show the volumes in this currency as well; never the native one. */
  display?: Asset;
}

/** A row of a set as the read gives it: the pair's statistics, and the window and the totals every row of the set carries. */
interface SetRow extends StoredMarket {
  start_time: number | string;
  end_time: number | string;
  pairs_traded: number | string;
  total_count: number | string;
  total_native_volume: string;
}

/**
 * The markets of the API (spec 7), read from the sets the syncer's `markets_live` job writes.
 *
 * A set (the pairs of one period and filter, and a sentinel row, the empty pair, that carries the window and the totals) is
 * written whole in one insert under one version, so a set is the rows of the NEWEST version there is of it: no FINAL, and a pair
 * that is gone is not read from an older version. A row that was stored twice is read once (`LIMIT 1 BY` the pair). The read
 * is a range of the primary key `(period, amm, pair)`: the rows of one period of the filter `include`, in the order of the key.
 * D2 has that one filter and serves no AMM field (spec 8); the filter, the sort and the limit are done on the set
 * (`marketsAnswer`).
 */
@Injectable()
export class MarketsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly rates: RatesService,
  ) {}

  private get native(): string {
    return this.rates.nativeCurrency;
  }

  /** The answer for a period: its newest set, or the answer of no set while the syncer has not written one. */
  async markets(q: MarketsQuery): Promise<MarketsAnswer | NoMarketsAnswer> {
    const set = await this.set(q.period);
    if (!set) return noMarketsAnswer(q.period);
    // as the live volumes: the latest rate, not the daily one (`live: true`); a missing rate is 0
    const display = q.display
      ? { asset: q.display, rate: await this.rates.exchangeRate({ currency: this.native }, q.display, { live: true }) }
      : undefined;
    return marketsAnswer({
      period: q.period,
      set,
      minTrades: q.minTrades,
      limit: q.limit,
      ...(display && { display }),
    });
  }

  /** The newest `include` set of a period, or `undefined` when there is none. */
  private async set(period: MarketsPeriod): Promise<StoredMarketsSet | undefined> {
    const rows = await this.ch.query<SetRow>(
      `SELECT base_currency, base_issuer, counter_currency, counter_issuer,
              toUInt64(count) AS count, base_volume, counter_volume, native_volume,
              open, high, low, last,
              toUnixTimestamp(open_time) AS open_time, toUnixTimestamp(last_time) AS last_time, closes,
              toUnixTimestamp(start_time) AS start_time, toUnixTimestamp(end_time) AS end_time,
              pairs_traded, toUInt64(total_count) AS total_count, total_native_volume
         FROM ${Table.MarketsLive}
        WHERE period = {period:String} AND amm = 'include'
          AND version = (SELECT max(version) FROM ${Table.MarketsLive} WHERE period = {period:String} AND amm = 'include')
        ORDER BY period, amm, base_currency, base_issuer, counter_currency, counter_issuer
        LIMIT 1 BY base_currency, base_issuer, counter_currency, counter_issuer`,
      { period },
    );
    if (rows.length === 0) return undefined;
    // the sentinel is the empty pair: it sorts first
    const [sentinel, ...pairs] = rows;
    if (
      sentinel.base_currency !== '' ||
      sentinel.base_issuer !== '' ||
      sentinel.counter_currency !== '' ||
      sentinel.counter_issuer !== ''
    ) {
      throw new Error(`The newest set of ${period} in ${Table.MarketsLive} has no sentinel`);
    }
    return {
      start_time: sentinel.start_time,
      end_time: sentinel.end_time,
      pairs_traded: sentinel.pairs_traded,
      total_count: sentinel.total_count,
      total_native_volume: sentinel.total_native_volume,
      markets: pairs,
    };
  }
}
