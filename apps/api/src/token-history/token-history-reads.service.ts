import {
  ClickHouseService,
  currencyCode,
  dexOfWindow,
  holdersAt,
  isLpCurrency,
  issuerTokensAt,
  NetworkProfile,
  Table,
  totalsAt,
  windowFlows,
} from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import BigNumber from 'bignumber.js';
import { notFound } from '../common/errors';
import { Coverage } from '../common/feature-coverage.service';
import { fmtTime } from '../common/format';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { NETWORK_PROFILE } from '../config/api.config';
import { AmendmentsService } from '../validators/amendments.service';
import { tokenHistoryCoverage } from './token-history-coverage';
import { LiveTokenHistory } from './token-history-ledger';
import {
  issuerTokenRow,
  IssuerTokenRow,
  SummaryAnswer,
  summaryAnswer,
  summaryToken,
  SummaryWindow,
  summaryWindow,
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
}
