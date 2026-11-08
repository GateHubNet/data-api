import {
  ClickHouseService,
  currencyCode,
  dexOfWindow,
  distributionAt,
  flowsPeriods,
  holdersAt,
  holdersPage,
  isLpCurrency,
  issuerTokensAt,
  NetworkProfile,
  PeriodInterval,
  periodStart,
  SeriesInterval,
  snapshotDigestAt,
  snapshotPage,
  supplySeries,
  Table,
  TOKEN_HISTORY_FLOWS_HOURLY_MAX_DAYS,
  TOKEN_HISTORY_FLOWS_MAX_DAYS,
  TOKEN_HISTORY_LEDGER_WINDOW_MAX,
  topCounterparties,
  totalsAt,
  windowFlows,
} from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import BigNumber from 'bignumber.js';
import { CacheService } from '../common/cache.service';
import { badRequest, notFound } from '../common/errors';
import { Coverage } from '../common/feature-coverage.service';
import { fmtTime } from '../common/format';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { encodeMarker } from '../common/pagination';
import { NETWORK_PROFILE } from '../config/api.config';
import { shareOf } from '../tokens/token-objects';
import { AmendmentsService } from '../validators/amendments.service';
import { tokenHistoryCoverage } from './token-history-coverage';
import { LiveTokenHistory } from './token-history-ledger';
import {
  counterpartyRow,
  DistributionAnswer,
  distributionAnswer,
  distributionBucket,
  DistributionTop,
  FlowsAnswer,
  flowsAnswer,
  flowsPeriod,
  flowsTotals,
  issuerTokenRow,
  IssuerTokenRow,
  SnapshotAnswer,
  snapshotAnswer,
  snapshotRow,
  SummaryAnswer,
  summaryAnswer,
  summaryToken,
  SummaryWindow,
  summaryWindow,
  SupplyAnswer,
  supplyAnswer,
  supplyRow,
  WithoutExcluded,
  withoutExcluded,
} from './token-history-objects';
import { AnyToken } from './token-history-param';
import { TokenHistoryService } from './token-history.service';

const HOUR = 3_600;
const DAY = 86_400;
/** The summary's windows (spec 5.2), ending at the close time of the answer's ledger. */
const WINDOWS = [
  ['24h', DAY],
  ['7d', 7 * DAY],
  ['30d', 30 * DAY],
] as const;

/**
 * The reads of the token history's routes, over the live generation (spec 5): the checks that need no read (an LP currency, an MPT on
 * a network without), the generation (404 `token history is not built yet`), the token (404 `token not found`), the coverage and the
 * close times, and the answers themselves, from the shared reads.
 */
@Injectable()
export class TokenHistoryReadsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly history: TokenHistoryService,
    private readonly ranges: LedgerRangeResolver,
    private readonly amendments: AmendmentsService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
    private readonly cache: CacheService,
  ) {}

  /** 404 `token not found` for a token no generation can have, before any read: an LP currency, an MPT on a network without MPT. */
  assertPossible(token: AnyToken): void {
    if (token.kind === 'mpt' ? !this.profile.hasMpt : isLpCurrency(token.currency)) throw notFound('token not found');
  }

  /** The live generation, or 404 `token history is not built yet`. */
  async live(): Promise<LiveTokenHistory> {
    const live = await this.history.live();
    if (live === undefined) throw notFound('token history is not built yet');
    return live;
  }

  /** 404 `token not found` when the token has no change in the generation (a prefix read of the change log). */
  async assertToken(live: LiveTokenHistory, token: AnyToken): Promise<void> {
    const [row] = await this.ch.query<{ one: number }>(
      `SELECT 1 AS one FROM ${Table.TokenHolderChanges}
        WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String} LIMIT 1`,
      { g: live.generation, issuer: token.issuer, currency: token.currency },
    );
    if (row === undefined) throw notFound('token not found');
  }

  /** The coverage of an answer of `kind` (spec 6): the MPT rule needs the ledger `MPTokensV1` was enabled in. */
  async coverage(live: LiveTokenHistory, kind: AnyToken['kind']): Promise<Coverage> {
    let mptStart: number | undefined;
    if (kind === 'mpt') {
      const assembly = await this.amendments.get();
      mptStart = this.amendments.find(assembly, 'MPTokensV1')?.enabled?.ledgerIndex;
    }
    return tokenHistoryCoverage(live, this.profile, mptStart, kind);
  }

  /** The close times (unix seconds) of stored ledgers, in one read; a ledger that is not stored has none. */
  async closeTimes(ledgers: readonly number[]): Promise<Map<number, number>> {
    const wanted = [...new Set(ledgers)];
    if (wanted.length === 0) return new Map();
    const rows = await this.ch.query<{ ledger_index: number | string; close_time: number | string }>(
      `SELECT ledger_index, toUnixTimestamp(close_time) AS close_time FROM ${Table.Ledgers}
        WHERE ledger_index IN {ledgers:Array(UInt32)}
        LIMIT 1 BY ledger_index`,
      { ledgers: wanted },
    );
    return new Map(rows.map((r) => [Number(r.ledger_index), Number(r.close_time)]));
  }

  /** The close time of `n`: the generation's own when it is `through`, else read. */
  async closeTimeOf(live: LiveTokenHistory, n: number): Promise<number> {
    if (n === live.through) return live.close_time;
    return (await this.closeTimes([n])).get(n) ?? 0;
  }

  /** A page of the issuer's tokens at `n` (spec 5.1), `limit + 1` rows so the caller can tell there is more. */
  async issuerTokens(
    live: LiveTokenHistory,
    issuer: string,
    n: number,
    page: { after?: string; limit: number },
  ): Promise<IssuerTokenRow[]> {
    const rows = await issuerTokensAt(this.ch, live.generation, issuer, n, {
      after: page.after,
      limit: page.limit + 1,
    });
    return rows.map((t) =>
      issuerTokenRow({
        currency: t.currency,
        ...(t.kind === 'issued' && { code: currencyCode(t.currency) }),
        kind: t.kind,
        supply: t.supply,
        holders: t.holders,
        trust_lines: t.trust_lines,
        first_ledger: t.first_ledger,
        last_ledger: t.last_ledger,
      }),
    );
  }

  /** The excluded holders' part of the figures at `n`, from the fold of their own lines (spec 5.0), taken off the totals. */
  async withoutExcluded(
    live: LiveTokenHistory,
    token: AnyToken,
    n: number,
    totals: { supply: string; holders: number; trust_lines: number },
    exclude: string[],
  ): Promise<WithoutExcluded> {
    const lines = (await holdersAt(this.ch, live.generation, token, n, { holders: exclude })).filter((l) => l.counted);
    const held = lines.filter((l) => new BigNumber(l.amount).gt(0));
    const supply = held.reduce((s, l) => s.minus(l.amount), new BigNumber(totals.supply));
    return withoutExcluded({
      supply: supply.isZero() ? '0' : supply.toFixed(),
      holders: totals.holders - held.length,
      trust_lines: totals.trust_lines - lines.length,
    });
  }

  /** The summary of a token at `n` (spec 5.2). */
  async summary(
    live: LiveTokenHistory,
    token: AnyToken,
    n: number,
    exclude: string[] | undefined,
  ): Promise<SummaryAnswer> {
    const key = { issuer: token.issuer, currency: token.currency };
    const g = live.generation;
    const [coverage, closeN, totals] = await Promise.all([
      this.coverage(live, token.kind),
      this.closeTimeOf(live, n),
      totalsAt(this.ch, g, key, n),
    ]);
    const windows = await Promise.all(
      WINDOWS.map(async ([name, span]): Promise<[string, SummaryWindow]> => {
        const start = closeN - span;
        const range = await this.ranges.resolve(new Date(start * 1000), new Date((closeN + 1) * 1000));
        const from = Math.max(range?.min ?? n + 1, live.coverage_from);
        const [flows, dex] = await Promise.all([
          windowFlows(this.ch, g, key, from, n),
          dexOfWindow(this.ch, key, Math.ceil(start / HOUR) * HOUR, Math.floor(closeN / HOUR) * HOUR),
        ]);
        return [
          name,
          summaryWindow({
            start: fmtTime(start),
            end: fmtTime(closeN),
            issued: flows.issued,
            redeemed: flows.redeemed,
            clawed_back: flows.clawed_back,
            transferred: flows.transferred,
            transfers: flows.transfers,
            changes: flows.changes,
            unknown_before: flows.unknown_before,
            ...(dex !== undefined && {
              exchanged: dex.exchanged,
              trades: dex.trades,
              exchanged_through: fmtTime(dex.through),
            }),
          }),
        ];
      }),
    );
    const edges = await this.closeTimes(
      [totals.first_ledger, totals.last_ledger].filter((l): l is number => l !== undefined),
    );
    const timeOf = (l: number | undefined) => (l === undefined || !edges.has(l) ? undefined : fmtTime(edges.get(l)!));
    return summaryAnswer({
      result: 'success',
      coverage,
      ledger_index: n,
      close_time: fmtTime(closeN),
      token: summaryToken({
        currency: token.currency,
        issuer: token.issuer,
        kind: token.kind,
        ...(token.kind === 'issued' && { code: currencyCode(token.currency) }),
      }),
      supply: totals.supply,
      holders: totals.holders,
      trust_lines: totals.trust_lines,
      ...(exclude !== undefined && {
        without_excluded: await this.withoutExcluded(live, token, n, totals, exclude),
        excluded: exclude,
      }),
      first_ledger: totals.first_ledger,
      first_time: timeOf(totals.first_ledger),
      last_ledger: totals.last_ledger,
      last_time: timeOf(totals.last_ledger),
      windows: Object.fromEntries(windows) as SummaryAnswer['windows'],
    });
  }

  /** The token's first change at or before `n` and its close time (unix seconds), `undefined` when it has none. */
  async firstChange(live: LiveTokenHistory, token: AnyToken): Promise<{ ledger: number; time: number } | undefined> {
    const [row] = await this.ch.query<{ ledger_index: number | string; close_time: number | string }>(
      `SELECT ledger_index, toUnixTimestamp(close_time) AS close_time FROM ${Table.TokenHolderChanges}
        WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
        ORDER BY ledger_index LIMIT 1`,
      { g: live.generation, issuer: token.issuer, currency: token.currency },
    );
    return row === undefined ? undefined : { ledger: Number(row.ledger_index), time: Number(row.close_time) };
  }

  /**
   * The supply series of a token (spec 5.3) over `[start, end)` (unix seconds; `start` no earlier than the token's first change, `end`
   * no later than the close of the answer's ledger), a page of `limit` rows after the marker's bucket or ledger.
   */
  async supply(
    live: LiveTokenHistory,
    token: AnyToken,
    o: {
      interval: SeriesInterval;
      start?: number;
      end?: number;
      descending: boolean;
      after?: number;
      limit: number;
      exclude?: string[];
    },
  ): Promise<{ answer: SupplyAnswer; marker?: string }> {
    const key = { issuer: token.issuer, currency: token.currency };
    const [coverage, first] = await Promise.all([this.coverage(live, token.kind), this.firstChange(live, token)]);
    const throughClose = live.close_time;
    const start = Math.max(o.start ?? 0, first?.time ?? 0);
    const end = Math.min(o.end ?? throughClose + 1, throughClose + 1);
    let rows: Awaited<ReturnType<typeof supplySeries>> = [];
    if (first !== undefined && start < end) {
      if (o.interval === 'ledger') {
        // the window as asked (from its start, or the token's first change), at most 100,000 stored ledgers
        const asked = await this.ranges.resolve(new Date((o.start ?? first.time) * 1000), new Date(end * 1000));
        if (asked !== null && asked.max - asked.min + 1 > TOKEN_HISTORY_LEDGER_WINDOW_MAX) {
          throw badRequest('window too large for interval ledger');
        }
        if (asked !== null) {
          const from = Math.max(asked.min, live.coverage_from, first.ledger);
          const to = Math.min(asked.max, live.through);
          rows = await supplySeries(this.ch, live.generation, key, { ...o, from, to, toLedger: live.through });
        }
      } else {
        rows = await supplySeries(this.ch, live.generation, key, {
          ...o,
          from: periodStart(start, o.interval),
          to: periodStart(end - 1, o.interval),
          toLedger: live.through,
        });
      }
    }
    const more = rows.length > o.limit;
    const page = rows.slice(0, o.limit);
    const last = page[page.length - 1];
    const marker = more ? encodeMarker([o.interval === 'ledger' ? last.ledger_index : last.time]) : undefined;
    return {
      marker,
      answer: supplyAnswer({
        result: 'success',
        coverage,
        ledger_index: live.through,
        close_time: fmtTime(throughClose),
        interval: o.interval,
        excluded: o.exclude,
        count: page.length,
        marker,
        rows: page.map((r) =>
          supplyRow({
            time: fmtTime(r.time),
            ledger_index: r.ledger_index,
            supply: r.supply,
            holders: r.holders,
            trust_lines: r.trust_lines,
            issued: r.issued,
            redeemed: r.redeemed,
            clawed_back: r.clawed_back,
            net: r.net,
            unknown_before: r.unknown_before,
            ...(r.without_excluded !== undefined && { without_excluded: withoutExcluded(r.without_excluded) }),
          }),
        ),
      }),
    };
  }

  /** The flows of a token (spec 5.6) over `[start, end)` (unix seconds), its periods of `interval`, and its top counterparties. */
  async flows(
    live: LiveTokenHistory,
    token: AnyToken,
    o: { start: number; end: number; interval: PeriodInterval; counterparties: number },
  ): Promise<FlowsAnswer> {
    const key = { issuer: token.issuer, currency: token.currency };
    const [coverage, range] = await Promise.all([
      this.coverage(live, token.kind),
      this.ranges.resolve(new Date(o.start * 1000), new Date(o.end * 1000)),
    ]);
    const from = Math.max(range?.min ?? Number.MAX_SAFE_INTEGER, live.coverage_from);
    const to = Math.min(range?.max ?? 0, live.through);
    const [flows, counterparties] = await Promise.all([
      flowsPeriods(this.ch, live.generation, key, {
        fromLedger: from,
        toLedger: to,
        start: o.start,
        end: o.end,
        interval: o.interval,
      }),
      topCounterparties(this.ch, live.generation, key, from, to, o.counterparties),
    ]);
    const dex = flows.dex;
    return flowsAnswer({
      result: 'success',
      coverage,
      ledger_index: live.through,
      close_time: fmtTime(live.close_time),
      start: fmtTime(o.start),
      end: fmtTime(o.end),
      interval: o.interval,
      totals: flowsTotals({
        ...flows.totals,
        ...(dex !== undefined && {
          exchanged: dex.exchanged,
          trades: dex.trades,
          exchanged_through: fmtTime(dex.through),
        }),
      }),
      periods: flows.periods.map((p) =>
        flowsPeriod({
          ...p,
          start: fmtTime(p.start),
          ...(p.dex !== undefined && { exchanged: p.dex.exchanged, trades: p.dex.trades }),
        }),
      ),
      counterparties: counterparties.map(counterpartyRow),
    });
  }

  /** The distribution of a token at `n` (spec 5.4), and without the excluded holders, with their own buckets and top. */
  async distribution(
    live: LiveTokenHistory,
    token: AnyToken,
    n: number,
    exclude: string[] | undefined,
  ): Promise<DistributionAnswer> {
    const key = { issuer: token.issuer, currency: token.currency, kind: token.kind };
    const [coverage, close, whole, without] = await Promise.all([
      this.coverage(live, token.kind),
      this.closeTimeOf(live, n),
      distributionAt(this.ch, live.generation, key, n),
      exclude === undefined ? Promise.resolve(undefined) : distributionAt(this.ch, live.generation, key, n, exclude),
    ]);
    const top = (d: { supply: string; top10: string; top100: string }): DistributionTop => ({
      '10': { balance: d.top10, share: shareOf(d.top10, d.supply) },
      '100': { balance: d.top100, share: shareOf(d.top100, d.supply) },
    });
    const buckets = (d: typeof whole) =>
      d.buckets.map((b) => distributionBucket({ min: b.min, max: b.max, holders: b.holders, balance: b.balance }));
    return distributionAnswer({
      result: 'success',
      coverage,
      ledger_index: n,
      close_time: fmtTime(close),
      supply: whole.supply,
      holders: whole.holders,
      buckets: buckets(whole),
      top: top(whole),
      excluded: exclude,
      without_excluded:
        without === undefined
          ? undefined
          : {
              supply: without.supply,
              holders: without.holders,
              trust_lines: without.trust_lines,
              buckets: buckets(without),
              top: top(without),
            },
    });
  }

  /**
   * A page of a token's snapshot at `n` (spec 5.7), by holder, after `after`. The digest of the whole set is kept 60 s per generation,
   * token and ledger: every page of a walk carries the same one.
   */
  async snapshot(
    live: LiveTokenHistory,
    token: AnyToken,
    n: number,
    o: { after?: string; limit: number; exclude?: string[] },
  ): Promise<{ answer: SnapshotAnswer; marker?: string }> {
    const key = { issuer: token.issuer, currency: token.currency };
    const g = live.generation;
    const [coverage, close, hash, totals, rows, digest] = await Promise.all([
      this.coverage(live, token.kind),
      this.closeTimeOf(live, n),
      this.ch.query<{ ledger_hash: string }>(
        `SELECT ledger_hash FROM ${Table.Ledgers} WHERE ledger_index = {n:UInt32} LIMIT 1`,
        { n },
      ),
      totalsAt(this.ch, g, key, n),
      snapshotPage(this.ch, g, key, n, o.after, o.limit),
      this.cache.wrap(`token-history:digest:${g}:${token.issuer}:${token.currency}:${n}`, 60_000, () =>
        snapshotDigestAt(this.ch, g, key, n),
      ),
    ]);
    const page = rows.slice(0, o.limit);
    const marker = rows.length > o.limit ? encodeMarker([page[page.length - 1].holder]) : undefined;
    return {
      marker,
      answer: snapshotAnswer({
        result: 'success',
        coverage,
        ledger_index: n,
        ledger_hash: hash[0]?.ledger_hash ?? '',
        close_time: fmtTime(close),
        token: summaryToken({
          currency: token.currency,
          issuer: token.issuer,
          kind: token.kind,
          ...(token.kind === 'issued' && { code: currencyCode(token.currency) }),
        }),
        supply: totals.supply,
        holders: totals.holders,
        trust_lines: totals.trust_lines,
        digest,
        ...(o.exclude !== undefined && {
          without_excluded: await this.withoutExcluded(live, token, n, totals, o.exclude),
          excluded: o.exclude,
        }),
        count: page.length,
        marker,
        balances: page.map((r) =>
          snapshotRow({
            holder: r.holder,
            balance: r.balance,
            ...(token.kind === 'mpt' && { escrowed: r.escrowed }),
            limit: r.limit,
            frozen: r.frozen,
            authorized: r.authorized,
          }),
        ),
      }),
    };
  }

  /**
   * A page of the holders of `/v2/tokens/{token}/holders` from the token history (spec 5.5): D6's keys, then `first_ledger`,
   * `last_ledger` and an MPT's `escrowed`; the shares of the supply at `n`; the marker the holder and the balance text of the last row.
   */
  async holders(
    live: LiveTokenHistory,
    token: AnyToken,
    n: number,
    o: { descending: boolean; after?: { balance: string; holder: string }; limit: number },
  ): Promise<Record<string, unknown>> {
    const key = { issuer: token.issuer, currency: token.currency, kind: token.kind };
    const [coverage, close, totals, rows] = await Promise.all([
      this.coverage(live, token.kind),
      this.closeTimeOf(live, n),
      totalsAt(this.ch, live.generation, key, n),
      holdersPage(this.ch, live.generation, key, n, o),
    ]);
    const page = rows.slice(0, o.limit);
    const last = page[page.length - 1];
    const marker = rows.length > o.limit ? encodeMarker([last.holder, last.balance]) : undefined;
    return {
      result: 'success',
      coverage,
      ledger_index: n,
      close_time: fmtTime(close),
      supply: totals.supply,
      count: page.length,
      ...(marker !== undefined && { marker }),
      holders: page.map((r) => ({
        rank: r.rank,
        holder: r.holder,
        balance: r.balance,
        share: shareOf(r.balance, totals.supply),
        limit: r.limit,
        frozen: r.frozen,
        authorized: r.authorized,
        first_ledger: r.first_ledger,
        last_ledger: r.last_ledger,
        ...(token.kind === 'mpt' && { escrowed: r.escrowed }),
      })),
    };
  }
}

/** The limits of `/flows` (spec 5.6): at most 366 days, at most 31 by the hour; else 400 `window too large`. */
export function checkFlowsWindow(start: number, end: number, interval: PeriodInterval): void {
  const days = (end - start) / DAY;
  if (days > TOKEN_HISTORY_FLOWS_MAX_DAYS || (interval === 'hour' && days > TOKEN_HISTORY_FLOWS_HOURLY_MAX_DAYS)) {
    throw badRequest('window too large');
  }
}
