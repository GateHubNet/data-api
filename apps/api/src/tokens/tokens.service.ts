import {
  ClickHouseService,
  liveGenerationOf,
  NetworkProfile,
  readTokenGenerations,
  Table,
} from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { isValidClassicAddress } from 'ripple-address-codec';
import { CacheService } from '../common/cache.service';
import { Coverage, FeatureCoverageService } from '../common/feature-coverage.service';
import { NETWORK_PROFILE } from '../config/api.config';
import type { CsvRow } from '../nft/nft-objects';
import {
  decodeTokenListMarker,
  encodeTokenListMarker,
  TokenListPage,
  TokenListQuery,
  TokenListService,
} from './token-list';
import { tokenMarketFacts, TokenMarkets } from './token-markets';
import {
  IssuedTokenRow,
  issuedTokenRow,
  IssuedTotals,
  issuedTotals,
  StoredToken,
  toIssuedTokenCsvRow,
} from './token-objects';

/** How long the live generation is kept (spec 5): one read of `token_generations` serves the requests of five seconds. */
export const TOKENS_GENERATION_CACHE_MS = 5_000;
/** The one key of it in `CacheService`; no request chooses a key. */
export const TOKENS_GENERATION_CACHE_KEY = 'tokens:generation';

/**
 * The live generation of the tokens, as the answers name it: the generation whose partitions are read, the ledger it is
 * through (`through_ledger`) and when that ledger closed (unix seconds), and its distinct holders. `holdersLedger` is the ledger
 * `holders` was counted at, 0 while the generation has not counted them (see `issuedTotals`).
 */
export interface LiveTokens {
  generation: number;
  ledgerIndex: number;
  closeTime: number;
  holders: number;
  holdersLedger: number;
}

/** The columns of a token the list serves (and the detail, Task 11, is made from). */
const TOKEN_COLUMNS =
  'issuer, currency, code, holders, trust_lines, supply, last_ledger, issuer_ledger, issuer_flags, transfer_rate, domain, listed, name, toml';

/**
 * The newest row of each token of one generation, `deleted` rows still in: `ORDER BY issuer, currency, version DESC LIMIT 1 BY
 * issuer, currency` over the generation's partition (the aggregates' rule: never `FINAL`). The rows a reader keeps are those with
 * `deleted = 0` after that.
 */
const newestTokens = (columns: string): string =>
  `(SELECT ${columns}, deleted
      FROM ${Table.Tokens}
     WHERE generation = {g:UInt32}
     ORDER BY issuer, currency, version DESC
     LIMIT 1 BY issuer, currency)`;

/** The condition of a search on the columns of a token, and the parameters it binds. `q` itself is always a parameter. */
interface Search {
  sql: string;
  params: Record<string, string>;
}

const NO_SEARCH: Search = { sql: '1', params: {} };
/** A currency is 3 characters or 40 hex digits: the empty text is none. */
const NO_CURRENCY = '';

/**
 * The search `q` of the list (spec 5.1). A classic address is the tokens of that issuer. Anything else matches a token when its
 * `code`, `name` or `domain` contains `q` (case-insensitive), its currency is `q` (40 hex digits in any case: the upper-case form
 * is what the ledger and the tables hold) or its issuer starts with `q`.
 */
function searchOf(q: string | undefined): Search {
  if (q === undefined) return NO_SEARCH;
  if (isValidClassicAddress(q)) return { sql: 'issuer = {q:String}', params: { q } };
  return {
    sql: `(positionCaseInsensitiveUTF8(code, {q:String}) > 0
        OR positionCaseInsensitiveUTF8(name, {q:String}) > 0
        OR positionCaseInsensitiveUTF8(domain, {q:String}) > 0
        OR currency = {qhex:String}
        OR startsWith(issuer, {q:String}))`,
    params: { q, qhex: /^[0-9A-Fa-f]{40}$/.test(q) ? q.toUpperCase() : NO_CURRENCY },
  };
}

type RankedToken = StoredToken & { rank: number };

/** The counts of the generation, as ClickHouse returns them (a `UInt64` is text). */
interface CountsRead {
  n_tokens: number | string;
  n_ten: number | string;
  n_total: number | string;
  n_below?: number | string;
}

/**
 * The issued tokens (spec 5.1 and 6): the live generation, the list of its tokens ranked by holders, and the coverage of the
 * feature. Every read of `tokens` names the generation (`generation = {g}`), so one partition is read, and keeps the newest row of
 * each token. The price and volume of the page come from `TokenMarkets`. The detail and the holders are Task 11's.
 */
@Injectable()
export class TokensService implements TokenListService<IssuedTokenRow, IssuedTotals> {
  readonly kind = 'issued';

  constructor(
    private readonly ch: ClickHouseService,
    private readonly cache: CacheService,
    private readonly features: FeatureCoverageService,
    private readonly markets: TokenMarkets,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  /** The coverage of the feature `issued_tokens`: the list, the detail and the holders state it. */
  coverage(): Promise<Coverage> {
    return this.features.coverage('issued_tokens');
  }

  /** The row of a token of the list for the CSV: `ISSUED_TOKEN_ROW_KEYS`, an empty cell where the token has no value. */
  csvRow(row: IssuedTokenRow): CsvRow {
    return toIssuedTokenCsvRow(row);
  }

  /**
   * The live generation, `undefined` before the job has promoted one. Kept 5 s under one fixed key. A live generation whose
   * `through_ledger` is not a stored ledger (the ledger is being written again) has no `close_time` to name: the read fails and
   * the route answers its 500, and nothing is kept.
   */
  live(): Promise<LiveTokens | undefined> {
    return this.cache.wrap(TOKENS_GENERATION_CACHE_KEY, TOKENS_GENERATION_CACHE_MS, () => this.readLive());
  }

  private async readLive(): Promise<LiveTokens | undefined> {
    const generation = liveGenerationOf(await readTokenGenerations(this.ch));
    if (generation === undefined) return undefined;
    const [ledger] = await this.ch.query<{ close_time: number | string }>(
      `SELECT toUnixTimestamp(close_time) AS close_time FROM ${Table.Ledgers} WHERE ledger_index = {ledger:UInt32} LIMIT 1`,
      { ledger: generation.through_ledger },
    );
    if (ledger === undefined) {
      throw new Error(
        `The live generation ${generation.generation} of the tokens is through ledger ${generation.through_ledger}, which is not stored`,
      );
    }
    return {
      generation: generation.generation,
      ledgerIndex: generation.through_ledger,
      closeTime: Number(ledger.close_time),
      holders: generation.holders,
      holdersLedger: generation.holders_ledger,
    };
  }

  /**
   * One page of the tokens by holders (descending), then issuer, then currency, with the counts of the whole kind. The marker is
   * checked first and throws before the promise is made, so a bad one is a 400 before any read, with or without a generation.
   * `undefined` while there is no live generation.
   */
  list(q: TokenListQuery): Promise<TokenListPage<IssuedTokenRow, IssuedTotals> | undefined> {
    const after = decodeTokenListMarker(q.marker, q.kind);
    return this.page(q, after);
  }

  private async page(
    q: TokenListQuery,
    after: [number, string, string] | undefined,
  ): Promise<TokenListPage<IssuedTokenRow, IssuedTotals> | undefined> {
    const live = await this.live();
    if (live === undefined) return undefined;

    const search = searchOf(q.q);
    const [stored, counts, snapshot] = await Promise.all([
      this.rows(live.generation, q, search, after),
      this.counts(live.generation, q, search),
      this.markets.snapshot(),
    ]);

    // one row more than the page was asked for tells that there is a next page; the marker is the last row that is served
    const page = stored.slice(0, q.limit);
    const last = page[page.length - 1];
    const rows = page.map((t) =>
      issuedTokenRow(
        t,
        tokenMarketFacts(snapshot, { currency: t.currency, issuer: t.issuer }, this.profile.nativeCurrency),
      ),
    );
    return {
      ledgerIndex: live.ledgerIndex,
      closeTime: live.closeTime,
      totals: issuedTotals(
        { tokens: counts.tokens, tokens_with_10_holders: counts.withTenHolders },
        { holders: live.holders, holders_ledger: live.holdersLedger },
        snapshot.day?.total_native_volume,
      ),
      total: counts.total,
      ...(counts.totalBelow !== undefined && { totalBelow: counts.totalBelow }),
      rows,
      ...(stored.length > q.limit && {
        marker: encodeTokenListMarker(q.kind, last.holders, last.issuer, last.currency),
      }),
    };
  }

  /**
   * The rows after the marker, `limit + 1` of them, each with its place (`rank`) among all the tokens the filters select: the rank
   * is worked out before the marker narrows the rows, so a page far into the list has the ranks of the whole list. The read is the
   * generation's partition, once.
   */
  private async rows(
    generation: number,
    q: TokenListQuery,
    search: Search,
    after: [number, string, string] | undefined,
  ): Promise<RankedToken[]> {
    const rows = await this.ch.query<RankedToken>(
      `SELECT *
         FROM (SELECT ${TOKEN_COLUMNS},
                      toUInt32(row_number() OVER (ORDER BY holders DESC, issuer ASC, currency ASC)) AS rank
                 FROM ${newestTokens(TOKEN_COLUMNS)}
                WHERE deleted = 0 AND holders >= {min:UInt32} AND ${search.sql})
        ${after ? 'WHERE holders < {h:UInt32} OR (holders = {h:UInt32} AND (issuer, currency) > ({i:String}, {c:String}))' : ''}
        ORDER BY holders DESC, issuer, currency
        LIMIT {fetch:UInt32}`,
      {
        g: generation,
        min: q.minHolders,
        fetch: q.limit + 1,
        ...search.params,
        ...(after && { h: after[0], i: after[1], c: after[2] }),
      },
    );
    return rows;
  }

  /**
   * The counts over the same newest rows: every token, those with 10 holders, those the filters select (`total`) and, with
   * `min_holders` above 0, those that match the search but have fewer holders (`total_below`). One read of the partition.
   */
  private async counts(
    generation: number,
    q: TokenListQuery,
    search: Search,
  ): Promise<{ tokens: number; withTenHolders: number; total: number; totalBelow?: number }> {
    const withBelow = q.minHolders > 0;
    const [row] = await this.ch.query<CountsRead>(
      `SELECT count() AS n_tokens,
              countIf(holders >= 10) AS n_ten,
              countIf(${search.sql} AND holders >= {min:UInt32}) AS n_total
              ${withBelow ? `, countIf(${search.sql} AND holders < {min:UInt32}) AS n_below` : ''}
         FROM ${newestTokens('issuer, currency, code, name, domain, holders')}
        WHERE deleted = 0`,
      { g: generation, min: q.minHolders, ...search.params },
    );
    return {
      tokens: Number(row.n_tokens),
      withTenHolders: Number(row.n_ten),
      total: Number(row.n_total),
      ...(withBelow && { totalBelow: Number(row.n_below) }),
    };
  }
}
