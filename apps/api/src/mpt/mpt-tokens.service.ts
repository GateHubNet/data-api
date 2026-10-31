import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import type { CsvRow } from '../common/csv.interceptor';
import { Coverage, FeatureCoverageService } from '../common/feature-coverage.service';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import {
  decodeTokenListMarker,
  encodeTokenListMarker,
  TokenListPage,
  TokenListQuery,
  TokenListService,
} from '../tokens/token-list';
import { MptTokenRowObject, MptTotalsObject, StoredMptTokenRow, toMptTokenCsvRow, toMptTokenRow } from './mpt-objects';
import { MptSearch, mptSearchOf } from './mpt-search';

/** The day before the head, in seconds: the window of `transfers_24h` is the ledgers that closed in `(headClose - DAY, headClose]`. */
const DAY = 86_400;

/** The newest row of each issuance, whichever version it is: a list keeps what its newest row says, never `FINAL`. */
const NEWEST_ISSUANCES = `(SELECT mpt_issuance_id, issuer, ticker, name, asset_scale, maximum_amount, outstanding_amount, holders,
              transfer_fee, flags, state_known, destroyed
         FROM ${Table.MptIssuances}
        ORDER BY mpt_issuance_id, version DESC
        LIMIT 1 BY mpt_issuance_id)`;

/** What the list counts: an issuance whose state is known and that is not destroyed. */
const KNOWN_AND_LIVE = 'state_known = 1 AND destroyed = 0';

/** The condition of a search on the columns of an issuance, and the parameters it binds. `q` itself is always a parameter. */
interface SearchSql {
  sql: string;
  params: Record<string, string>;
}

function searchSql(search: MptSearch | undefined): SearchSql {
  if (search === undefined) return { sql: '1', params: {} };
  if (search.by === 'issuer') return { sql: 'issuer = {q:String}', params: { q: search.issuer } };
  if (search.by === 'id') return { sql: 'mpt_issuance_id = {q:String}', params: { q: search.id } };
  const prefix = search.idPrefix === undefined ? '' : ' OR startsWith(mpt_issuance_id, {prefix:String})';
  return {
    sql: `(positionCaseInsensitiveUTF8(ticker, {q:String}) > 0
        OR positionCaseInsensitiveUTF8(name, {q:String}) > 0
        OR startsWith(issuer, {q:String})${prefix})`,
    params: { q: search.text, ...(search.idPrefix !== undefined && { prefix: search.idPrefix }) },
  };
}

/** The counts of the list, as ClickHouse returns them (a `UInt64` is text). */
interface CountsRead {
  n_issuances: number | string;
  n_total: number | string;
  n_below: number | string;
}

/** The counts of the list. */
interface MptCounts {
  issuances: number;
  total: number;
  below: number;
}

/** The payments of the window: of each issuance, and of all of them. */
interface WindowCounts {
  byId: Map<string, number>;
  total: number;
}

/**
 * `GET /v2/tokens?kind=mpt` (spec 7.1), reached through D6's `TOKEN_LIST_SERVICES`: the issuances whose state is known and that are
 * not destroyed, ranked by holders, then issuer, then ID, with the counts of the whole kind.
 *
 * It answers as of the newest committed ledger (the aggregates trail it by at most a tick). Each page reads the newest rows of
 * `mpt_issuances` three times, for the list, its counts and the IDs of the distinct holders, the newest rows of `mpt_holders` of those
 * IDs, and the ledgers of the day before the head of `mpt_transfers` (spec 8). A network without MPT reads none of them: the list is
 * the zero page, D6's whole envelope, as it is for a database with no issuance; only with no committed ledger does it answer `undefined`,
 * D6's no-generation answer.
 */
@Injectable()
export class MptTokensService implements TokenListService<MptTokenRowObject, MptTotalsObject> {
  readonly kind = 'mpt';

  constructor(
    private readonly ch: ClickHouseService,
    private readonly features: FeatureCoverageService,
    private readonly ranges: LedgerRangeResolver,
  ) {}

  /** The coverage of the feature `mpt`. */
  coverage(): Promise<Coverage> {
    return this.features.coverage('mpt');
  }

  /** The row of an issuance of the list for the CSV: the fixed columns, the flags flattened, an empty cell where it has no value. */
  csvRow(row: MptTokenRowObject): CsvRow {
    return toMptTokenCsvRow(row);
  }

  /**
   * One page, with the counts of the whole kind. The marker is checked first and throws before the promise is made: the controller
   * starts the list first, so a bad one is a 400 before any read (ruling C23).
   */
  list(q: TokenListQuery): Promise<TokenListPage<MptTokenRowObject, MptTotalsObject> | undefined> {
    const after = decodeTokenListMarker(q.marker, 'mpt');
    return this.page(q, after);
  }

  private async page(
    q: TokenListQuery,
    after: [number, string, string] | undefined,
  ): Promise<TokenListPage<MptTokenRowObject, MptTotalsObject> | undefined> {
    const head = await this.ranges.latestWithTime();
    if (head === undefined) return undefined;
    const asOf = { ledgerIndex: head.ledger_index, closeTime: head.close_time };
    const zero = {
      ...asOf,
      totals: { issuances: 0, holders: 0, transfers_24h: 0 },
      total: 0,
      ...(q.minHolders > 0 && { totalBelow: 0 }),
      rows: [],
    };
    if (!this.features.isAvailable('mpt')) return zero;

    const search = searchSql(q.q === undefined ? undefined : mptSearchOf(q.q));
    const [stored, counts, holders] = await Promise.all([
      this.rows(q, search, after),
      this.counts(q, search),
      this.distinctHolders(),
    ]);
    if (counts.issuances === 0) return zero;
    const window = await this.payments(head.close_time);

    // one row more than the page was asked for tells that there is a next page; the marker is the last row that is served
    const page = stored.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      ...asOf,
      totals: { issuances: counts.issuances, holders, transfers_24h: window.total },
      total: counts.total,
      ...(q.minHolders > 0 && { totalBelow: counts.below }),
      rows: page.map((row) => toMptTokenRow(row, window.byId.get(row.mpt_issuance_id) ?? 0)),
      ...(stored.length > q.limit && {
        marker: encodeTokenListMarker('mpt', last.holders, last.issuer, last.mpt_issuance_id),
      }),
    };
  }

  /**
   * The rows after the marker, `limit + 1` of them, each with its place (`rank`) among all the issuances the filters select: the rank is
   * worked out before the marker narrows the rows, so a page far into the list has the ranks of the whole list.
   */
  private rows(
    q: TokenListQuery,
    search: SearchSql,
    after: [number, string, string] | undefined,
  ): Promise<StoredMptTokenRow[]> {
    return this.ch.query<StoredMptTokenRow>(
      `SELECT *
         FROM (SELECT mpt_issuance_id, issuer, ticker, name, asset_scale, toString(maximum_amount) AS maximum_text,
                      toString(outstanding_amount) AS outstanding_text, holders, transfer_fee, flags,
                      toUInt32(row_number() OVER (ORDER BY holders DESC, issuer ASC, mpt_issuance_id ASC)) AS rank
                 FROM ${NEWEST_ISSUANCES}
                WHERE ${KNOWN_AND_LIVE} AND holders >= {min:UInt32} AND ${search.sql})
        ${after ? 'WHERE holders < {h:UInt32} OR (holders = {h:UInt32} AND (issuer, mpt_issuance_id) > ({i:String}, {m:String}))' : ''}
        ORDER BY holders DESC, issuer, mpt_issuance_id
        LIMIT {fetch:UInt32}`,
      {
        min: q.minHolders,
        fetch: q.limit + 1,
        ...search.params,
        ...(after && { h: after[0], i: after[1], m: after[2] }),
      },
    );
  }

  /**
   * The counts over the newest rows: the issuances of the kind, those the filters select (`total`) and those that match the search with
   * fewer holders (`below`).
   */
  private async counts(q: TokenListQuery, search: SearchSql): Promise<MptCounts> {
    const [row] = await this.ch.query<CountsRead>(
      `SELECT count() AS n_issuances,
              countIf(${search.sql} AND holders >= {min:UInt32}) AS n_total,
              countIf(${search.sql} AND holders < {min:UInt32}) AS n_below
         FROM ${NEWEST_ISSUANCES}
        WHERE ${KNOWN_AND_LIVE}`,
      { min: q.minHolders, ...search.params },
    );
    return { issuances: Number(row.n_issuances), total: Number(row.n_total), below: Number(row.n_below) };
  }

  /**
   * The distinct accounts with a balance of an issuance of the kind: the newest row of each holder of those issuances, then its balance.
   * A row of `mpt_holders` does not say whether its issuance is known and live, so the IDs are a subquery of `mpt_issuances`, and the
   * primary key of `mpt_holders` narrows to them. A scalar array of the IDs would save that read, but with 100,000 IDs and 800,000
   * holders it did not end in 30 s.
   */
  private async distinctHolders(): Promise<number> {
    const [row] = await this.ch.query<{ n: number | string }>(
      `SELECT uniqExact(holder) AS n
         FROM (SELECT holder, amount, escrowed_amount, deleted
                 FROM ${Table.MptHolders}
                WHERE mpt_issuance_id IN (SELECT mpt_issuance_id FROM ${NEWEST_ISSUANCES} WHERE ${KNOWN_AND_LIVE})
                ORDER BY mpt_issuance_id, holder, version DESC
                LIMIT 1 BY mpt_issuance_id, holder)
        WHERE deleted = 0 AND amount + escrowed_amount > 0`,
    );
    return Number(row.n);
  }

  /**
   * The payments of the ledgers that closed in `(headClose - 86400, headClose]`, by the range of those ledgers: `mpt_transfers` is ordered
   * by ledger. A row written twice counts once, a lock or an escrow not at all. Of every issuance, as the totals count them all.
   */
  private async payments(headClose: number): Promise<WindowCounts> {
    const range = await this.ranges.resolve(new Date((headClose - DAY + 1) * 1000), new Date((headClose + 1) * 1000));
    if (range === null) return { byId: new Map(), total: 0 };
    const rows = await this.ch.query<{ mpt_issuance_id: string; payments: number | string }>(
      `SELECT mpt_issuance_id, uniqExact(ledger_index, tx_index) AS payments
         FROM ${Table.MptTransfers}
        WHERE ledger_index BETWEEN {min:UInt32} AND {max:UInt32} AND kind = 'payment'
        GROUP BY mpt_issuance_id`,
      { min: range.min, max: range.max },
    );
    const byId = new Map(rows.map((row) => [row.mpt_issuance_id, Number(row.payments)]));
    return { byId, total: rows.reduce((sum, row) => sum + Number(row.payments), 0) };
  }
}
