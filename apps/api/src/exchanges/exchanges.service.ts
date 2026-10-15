import { ClickHouseService, isoTimeToUnixSeconds, Table, toClickHouseDateTime, View } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { INTERVAL_TO_CH, Interval } from '../common/enums';
import { keysetClause, nextMarker, orderByClause, SortKey } from '../common/pagination';
import { listResponse, toIso } from '../common/response';
import { ExchangeRatesQueryDto, ExchangesQueryDto, NormalizeQueryDto, parseAsset } from './exchanges.dto';

const SORT_KEYS: SortKey[] = [
  { column: 'date', type: 'DateTime' },
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt16' },
];

interface Asset {
  currency: string;
  issuer: string;
}

@Injectable()
export class ExchangesService {
  constructor(private readonly ch: ClickHouseService) {}

  /** Canonical ordering used by the syncer (ExchangeParser.orderPair). */
  private isCanonical(base: Asset, counter: Asset): boolean {
    const c1 = (base.currency + base.issuer).toLowerCase();
    const c2 = (counter.currency + counter.issuer).toLowerCase();
    return c2 >= c1;
  }

  async getAllExchanges(options: ExchangesQueryDto) {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit };
    this.applyTimeWindow(where, params, options.start, options.end);

    const keyset = keysetClause(SORT_KEYS, options.descending, options.marker);
    if (keyset.clause) {
      where.push(keyset.clause);
      Object.assign(params, keyset.params);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await this.ch.query<Record<string, unknown>>(
      `SELECT base_currency, base_issuer, base_amount, counter_currency, counter_issuer, counter_amount,
              rate, buyer, seller, taker, provider, sequence, date, tx_type, tx_index, ledger_index, tx_hash
       FROM ${Table.Exchanges} ${whereSql}
       ORDER BY ${orderByClause(SORT_KEYS, options.descending)} LIMIT {limit:UInt32}`,
      params,
    );
    const marker = nextMarker(rows, SORT_KEYS, options.limit);
    return listResponse('exchanges', rows.map((r) => ({ ...r, date: toIso(r.date as string) })), marker);
  }

  async getExchanges(baseRaw: string, counterRaw: string, options: ExchangesQueryDto) {
    const reqBase = parseAsset(baseRaw);
    const reqCounter = parseAsset(counterRaw);
    const canonical = this.isCanonical(reqBase, reqCounter);
    const base = canonical ? reqBase : reqCounter;
    const counter = canonical ? reqCounter : reqBase;
    const inverted = !canonical;

    // Raw trades when no interval requested.
    if (!options.interval) {
      return this.rawPairTrades(base, counter, inverted, options);
    }

    const bucket = INTERVAL_TO_CH[options.interval](`minute`);
    const params: Record<string, unknown> = {
      bc: base.currency,
      bi: base.issuer,
      cc: counter.currency,
      ci: counter.issuer,
      limit: options.limit,
    };
    const timeWhere: string[] = [];
    this.applyTimeWindow(timeWhere, params, options.start, options.end, 'minute');

    const rows = await this.ch.query<Record<string, string>>(
      `SELECT ${bucket} AS bucket,
              argMinMerge(open) AS open,
              argMaxMerge(close) AS close,
              max(high) AS high,
              min(low)  AS low,
              sum(base_volume)    AS base_volume,
              sum(counter_volume) AS counter_volume,
              sum(trade_count)    AS trade_count
       FROM ${View.ExchangeCandles1m}
       WHERE base_currency = {bc:String} AND base_issuer = {bi:String}
         AND counter_currency = {cc:String} AND counter_issuer = {ci:String}
         ${timeWhere.length ? 'AND ' + timeWhere.join(' AND ') : ''}
       GROUP BY bucket
       ORDER BY bucket ${options.descending ? 'DESC' : 'ASC'}
       LIMIT {limit:UInt32}`,
      params,
    );

    const candles = rows.map((r) => this.formatCandle(r, inverted));
    return { result: 'success', count: candles.length, base: reqBase, counter: reqCounter, interval: options.interval, exchanges: candles };
  }

  async getExchangeRate(baseRaw: string, counterRaw: string, options: ExchangeRatesQueryDto) {
    const reqBase = parseAsset(baseRaw);
    const reqCounter = parseAsset(counterRaw);
    const canonical = this.isCanonical(reqBase, reqCounter);
    const base = canonical ? reqBase : reqCounter;
    const counter = canonical ? reqCounter : reqBase;

    const params: Record<string, unknown> = { bc: base.currency, bi: base.issuer, cc: counter.currency, ci: counter.issuer };
    const where: string[] = [
      'base_currency = {bc:String}',
      'base_issuer = {bi:String}',
      'counter_currency = {cc:String}',
      'counter_issuer = {ci:String}',
    ];
    this.applyTimeWindow(where, params, options.start, options.end);

    let rate: number;
    if (options.start || options.end) {
      // Volume-weighted average price over the window.
      const row = await this.ch.queryOne<{ vwap: string }>(
        `SELECT sum(counter_amount) / nullIf(sum(base_amount), 0) AS vwap
         FROM ${Table.Exchanges} WHERE ${where.join(' AND ')}`,
        params,
      );
      rate = Number(row?.vwap ?? 0);
    } else {
      // Most recent trade rate.
      const row = await this.ch.queryOne<{ rate: string }>(
        `SELECT rate FROM ${Table.Exchanges} WHERE ${where.join(' AND ')} ORDER BY date DESC, ledger_index DESC LIMIT 1`,
        params,
      );
      rate = Number(row?.rate ?? 0);
    }

    if (!canonical && rate !== 0) rate = 1 / rate;
    return { result: 'success', rate };
  }

  async normalize(options: NormalizeQueryDto) {
    const amount = Number(options.amount ?? 1);
    if (!options.base || !options.counter) {
      return { result: 'success', amount, converted: amount, rate: 1 };
    }
    const { rate } = await this.getExchangeRate(options.base, options.counter, {});
    return { result: 'success', amount, rate, converted: amount * rate };
  }

  private async rawPairTrades(base: Asset, counter: Asset, inverted: boolean, options: ExchangesQueryDto) {
    const params: Record<string, unknown> = {
      bc: base.currency,
      bi: base.issuer,
      cc: counter.currency,
      ci: counter.issuer,
      limit: options.limit,
    };
    const where = ['base_currency = {bc:String}', 'base_issuer = {bi:String}', 'counter_currency = {cc:String}', 'counter_issuer = {ci:String}'];
    this.applyTimeWindow(where, params, options.start, options.end);
    const keyset = keysetClause(SORT_KEYS, options.descending, options.marker);
    if (keyset.clause) {
      where.push(keyset.clause);
      Object.assign(params, keyset.params);
    }
    const rows = await this.ch.query<Record<string, unknown>>(
      `SELECT base_currency, base_issuer, base_amount, counter_currency, counter_issuer, counter_amount,
              rate, buyer, seller, taker, provider, sequence, date, tx_type, tx_index, ledger_index, tx_hash
       FROM ${Table.Exchanges} WHERE ${where.join(' AND ')}
       ORDER BY ${orderByClause(SORT_KEYS, options.descending)} LIMIT {limit:UInt32}`,
      params,
    );
    const marker = nextMarker(rows, SORT_KEYS, options.limit);
    const exchanges = rows.map((r) => ({
      ...r,
      rate: inverted && Number(r.rate) !== 0 ? 1 / Number(r.rate) : Number(r.rate),
      date: toIso(r.date as string),
    }));
    return listResponse('exchanges', exchanges, marker);
  }

  private formatCandle(r: Record<string, string>, inverted: boolean) {
    const open = Number(r.open);
    const close = Number(r.close);
    const high = Number(r.high);
    const low = Number(r.low);
    const baseVol = Number(r.base_volume);
    const counterVol = Number(r.counter_volume);
    const inv = (x: number) => (x !== 0 ? 1 / x : 0);
    return {
      start: toIso(r.bucket),
      open: inverted ? inv(open) : open,
      close: inverted ? inv(close) : close,
      high: inverted ? inv(low) : high,
      low: inverted ? inv(high) : low,
      base_volume: inverted ? counterVol : baseVol,
      counter_volume: inverted ? baseVol : counterVol,
      vwap: inverted ? (counterVol !== 0 ? baseVol / counterVol : 0) : baseVol !== 0 ? counterVol / baseVol : 0,
      count: Number(r.trade_count),
    };
  }

  private applyTimeWindow(
    where: string[],
    params: Record<string, unknown>,
    start?: string,
    end?: string,
    column = 'date',
  ): void {
    const s = isoTimeToUnixSeconds(start);
    const e = isoTimeToUnixSeconds(end);
    if (s !== undefined) {
      where.push(`${column} >= {start:DateTime}`);
      params.start = toClickHouseDateTime(s);
    }
    if (e !== undefined) {
      where.push(`${column} <= {end:DateTime}`);
      params.end = toClickHouseDateTime(e);
    }
  }
}
