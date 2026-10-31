import { ClickHouseService, MintSums, mintSums, NetworkProfile, newestSnapshot, Table } from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { notFound } from '../common/errors';
import { Coverage, FeatureCoverageService } from '../common/feature-coverage.service';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { decodeMarker, KeyValue, paginate } from '../common/pagination';
import { NETWORK_PROFILE } from '../config/api.config';
import { ceilTo, floorTo } from './bucket-windows';
import {
  MINTED_DAY_KEYSET,
  MintedRow,
  mintedRow,
  SupplyAnswer,
  SupplyCoverages,
  supplyFeaturesOf,
  supplyObject,
} from './supply-object';

/** What `GET /v2/network/supply/minted` is asked for; the values are already validated. */
export interface MintedQuery {
  /** Inclusive: a day is a row when it STARTS at or after this. */
  start?: Date;
  /** Exclusive: a day is a row when it starts before this. */
  endExclusive?: Date;
  descending: boolean;
  limit: number;
  /** As the client got it from the last page; `decodeMarker` checks it before anything is read. */
  marker?: string;
}

/** The size of a UTC day in seconds; every day starts on a multiple of it since the epoch. */
const DAY = 86_400;

/** Unix seconds of a date, up to the second after it (`ledgers.close_time` is whole seconds). */
const seconds = (date: Date): number => Math.ceil(date.getTime() / 1000);

/** The sums of a day with no mint. */
const noMints = (): MintSums => ({ rewards: 0n, import: 0n, genesis_mint: 0n });

/** `YYYY-MM-DD` of the day that starts at `dayStart` (unix seconds): the key `mintSums` groups by. */
const dayKey = (dayStart: number): string => new Date(dayStart * 1000).toISOString().slice(0, 10);

/**
 * The supply of the network (spec 5.1): the newest snapshot the syncer's `supply` job wrote (`newestSnapshot`, two reads of the end
 * of the key of `network_supply`), and the coverage of each part of it that is read from history. A request with no snapshot yet
 * is 404 `supply not computed yet`, before any coverage is read. The coverage of every part the snapshot has is asked at once
 * (`FeatureCoverageService` keeps each 60 s, and a failed read fails the route with its 500); a part the snapshot does not have,
 * the reserves of a snapshot with no reserve values, say, is not asked.
 *
 * `minted` (spec 5.2) is the other route's list: the native currency minted per UTC day, which the service works out from the mint
 * tables at the time of the request (no snapshot).
 */
@Injectable()
export class SupplyService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly coverage: FeatureCoverageService,
    private readonly ranges: LedgerRangeResolver,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  /** The answer for the newest snapshot; throws 404 `supply not computed yet` before the first. */
  async snapshot(): Promise<SupplyAnswer> {
    const row = await newestSnapshot(this.ch);
    if (row === undefined) throw notFound('supply not computed yet');
    const features = supplyFeaturesOf(row, this.profile.hasMinting);
    // `escrows` is always among the features, so the object is whole once they are all in
    const coverages: Partial<SupplyCoverages> = {};
    await Promise.all(
      features.map(async (feature) => {
        coverages[feature] = await this.coverage.coverage(feature);
      }),
    );
    return supplyObject(row, this.profile.nativeCurrency, coverages as SupplyCoverages);
  }

  /**
   * One page of the days of `GET /v2/network/supply/minted`, in the order asked for, with the marker of the next page when there is
   * one, and the coverage of the mints.
   *
   * A day is a row when its every ledger is covered: from the day after the one `coverage.from_ledger_index` closed in (that
   * day has ledgers before it that no mint was written for), or from that very day when the coverage starts at the first ledger of
   * the network, to the day of the newest ledger, the running day, summed so far. A covered day with no mint is a row of zeros. The
   * ledger that gives the first day is the first one stored at or after `from_ledger_index` that has a close time: Xahau's ledger 1
   * has none (0, 1970-01-01), and days from there would be 19,700 rows of zeros before the network's first real day.
   *
   * The days of the page, `limit` of them and one more, are worked out from the bounds of the span, never listed whole. Their
   * ledgers are one range (from the oldest day of the page to the end of the newest, whatever the order), so `mintSums` reads the
   * key ranges of those ledgers and no more. A network that cannot mint answers the coverage and no rows, and reads no mint table.
   */
  async minted(q: MintedQuery): Promise<{ coverage: Coverage; rows: MintedRow[]; marker?: string }> {
    // before any read, the coverage included: a marker that is none of ours is the client's mistake, whatever the history holds
    const after = decodeMarker(q.marker, MINTED_DAY_KEYSET);
    const coverage = await this.coverage.coverage('mints');
    const nothing = { coverage, rows: [] };
    const from = coverage.from_ledger_index;
    if (!this.profile.hasMinting || from === undefined) return nothing;

    const span = await this.coveredDays(from);
    if (span === undefined) return nothing;
    const days = this.pageDays(span, q, after);
    if (days.length === 0) return nothing;

    // the days are consecutive and the page is one range of ledgers: those that closed from the oldest day to the end of the newest
    const oldest = q.descending ? days[days.length - 1] : days[0];
    const newest = q.descending ? days[0] : days[days.length - 1];
    const range = await this.ranges.resolve(new Date(oldest * 1000), new Date((newest + DAY) * 1000));
    const sums = range === null ? new Map<string, MintSums>() : await mintSums(this.ch, range.min, range.max, true);

    const page = paginate(
      days.map((dayStart) => ({ dayStart, sums: sums.get(dayKey(dayStart)) ?? noMints() })),
      q.limit,
      (day): KeyValue[] => [day.dayStart],
    );
    return {
      coverage,
      rows: page.rows.map((day) => mintedRow(day.dayStart, day.sums)),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }

  /**
   * The first and the last day of the span the mints are covered for, as the unix seconds of their starts: `undefined` when there
   * is none (no ledger with a close time is stored, or the coverage starts in the running day).
   */
  private async coveredDays(from: number): Promise<{ firstDay: number; lastDay: number } | undefined> {
    const [closed, head] = await Promise.all([this.firstClosedFrom(from), this.ranges.latestWithTime()]);
    if (closed === undefined || head === undefined) return undefined;
    // the day the coverage starts in has ledgers before `from`, written without their mints, unless `from` is the network's first ledger
    const firstDay = floorTo(closed, DAY) + (from === this.profile.firstLedger ? 0 : DAY);
    const lastDay = floorTo(head.close_time, DAY);
    return firstDay <= lastDay ? { firstDay, lastDay } : undefined;
  }

  /**
   * When the first stored ledger at or after `from` that has a close time closed, unix seconds; `undefined` when none is stored. A
   * read by the key from `from` that stops after the first ledgers: Xahau's ledger 1 is stored with the close time 0, and a ledger
   * without a close time belongs to no day.
   */
  private async firstClosedFrom(from: number): Promise<number | undefined> {
    const [row] = await this.ch.query<{ closed: number | string }>(
      `SELECT toUnixTimestamp(close_time) AS closed
         FROM ${Table.Ledgers}
        WHERE ledger_index >= {from:UInt32} AND close_time > toDateTime(0, 'UTC')
        ORDER BY ledger_index ASC
        LIMIT 2`,
      { from },
    );
    return row === undefined ? undefined : Number(row.closed);
  }

  /**
   * The starts of the days of the page, in the order asked for: the days of the span that start inside `start` and `end`, after
   * the marker, `limit + 1` of them at most (the one more only tells that there is a next page). Worked out from the bounds, so a
   * span of years costs the page, not the years.
   */
  private pageDays(
    span: { firstDay: number; lastDay: number },
    q: MintedQuery,
    after: KeyValue[] | undefined,
  ): number[] {
    // [from, until): both on a day boundary
    let from = span.firstDay;
    let until = span.lastDay + DAY;
    if (q.start !== undefined) from = Math.max(from, ceilTo(seconds(q.start), DAY));
    if (q.endExclusive !== undefined) until = Math.min(until, ceilTo(seconds(q.endExclusive), DAY));
    if (after !== undefined) {
      // strictly after the marker (before it, descending), whether or not it is the start of a day
      const marker = Number(after[0]);
      if (q.descending) until = Math.min(until, ceilTo(marker, DAY));
      else from = Math.max(from, floorTo(marker, DAY) + DAY);
    }
    const count = Math.max(0, Math.min(q.limit + 1, (until - from) / DAY));
    return Array.from({ length: count }, (_, i) => (q.descending ? until - DAY - i * DAY : from + i * DAY));
  }
}
