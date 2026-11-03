import {
  accountFlagsOf,
  namedAccountFlags,
  NetworkProfile,
  servedTomlFields,
  TokensRow,
  tomlUrlOf,
} from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { CsvRow, toCsvRow } from '../nft/nft-objects';
import { PaymentObject } from '../payments/payment-object';
import type { TokenMarketFacts } from './token-markets';

/**
 * The objects of the token routes (spec 5.1 to 5.4), written down here once and pinned by the tests: each is built by a function
 * that writes its keys in the order of its `*_KEYS` constant and leaves out the keys it has no value for (an absent string is `''`
 * in the tables, and a fact that is not known is `undefined`: neither is written, and `null` is never served). Times are
 * `fmtTime`, amounts the exact decimal text, counts and ranks numbers, every decimal this module writes by `toFixed()`.
 */

// -- the list ------------------------------------------------------------------------------------------------------

/** The totals of the list, whatever the filters: `holders` is left out while the generation has not counted them (see `issuedTotals`). */
export interface IssuedTotals {
  tokens: number;
  tokens_with_10_holders: number;
  holders?: number;
  native_volume?: string;
}

export const ISSUED_TOTALS_KEYS = ['tokens', 'tokens_with_10_holders', 'holders', 'native_volume'] as const;

/** A token of the list. */
export interface IssuedTokenRow {
  rank: number;
  currency: string;
  code?: string;
  issuer: string;
  holders: number;
  trust_lines: number;
  supply: string;
  price?: string;
  price_change?: string;
  price_time?: string;
  native_volume?: string;
  trades?: number;
  domain?: string;
  listed: boolean;
  name?: string;
}

export const ISSUED_TOKEN_ROW_KEYS = [
  'rank',
  'currency',
  'code',
  'issuer',
  'holders',
  'trust_lines',
  'supply',
  'price',
  'price_change',
  'price_time',
  'native_volume',
  'trades',
  'domain',
  'listed',
  'name',
] as const;

// -- the detail ----------------------------------------------------------------------------------------------------

export const TOKEN_ANSWER_KEYS = ['result', 'coverage', 'ledger_index', 'close_time', 'token'] as const;

/** The settings of the issuer's account that matter to a holder; `transfer_fee` is a percent. */
export interface IssuerSettings {
  transfer_fee: string;
  global_freeze: boolean;
  no_freeze: boolean;
  allow_trust_line_clawback: boolean;
  require_auth: boolean;
  default_ripple: boolean;
}

export const ISSUER_SETTINGS_KEYS = [
  'transfer_fee',
  'global_freeze',
  'no_freeze',
  'allow_trust_line_clawback',
  'require_auth',
  'default_ripple',
] as const;

/** A market of a token, turned so that the token is the base (spec 5.5). */
export interface TokenMarket {
  counter_currency: string;
  counter_issuer?: string;
  count: number;
  volume: string;
  counter_volume: string;
  native_volume?: string;
  last: string;
  change?: string;
  last_time: string;
  amm_pool?: boolean;
}

export const TOKEN_MARKET_KEYS = [
  'counter_currency',
  'counter_issuer',
  'count',
  'volume',
  'counter_volume',
  'native_volume',
  'last',
  'change',
  'last_time',
  'amm_pool',
] as const;

/** The served fields of the toml entry that lists a token, in the order of `TOKEN_TOML_KEYS`. */
export type TokenToml = Record<string, string | number>;

export interface TokenObject {
  currency: string;
  code?: string;
  issuer: string;
  holders: number;
  trust_lines: number;
  supply: string;
  price?: string;
  price_change?: string;
  price_time?: string;
  native_volume?: string;
  trades?: number;
  domain?: string;
  toml_url?: string;
  listed: boolean;
  toml?: TokenToml;
  issuer_settings?: IssuerSettings;
  markets: TokenMarket[];
  last_ledger: number;
}

export const TOKEN_KEYS = [
  'currency',
  'code',
  'issuer',
  'holders',
  'trust_lines',
  'supply',
  'price',
  'price_change',
  'price_time',
  'native_volume',
  'trades',
  'domain',
  'toml_url',
  'listed',
  'toml',
  'issuer_settings',
  'markets',
  'last_ledger',
] as const;

// -- the holders and the transfers ---------------------------------------------------------------------------------

export const HOLDERS_ANSWER_KEYS = [
  'result',
  'coverage',
  'ledger_index',
  'close_time',
  'supply',
  'count',
  'marker',
  'holders',
] as const;

export interface HolderRow {
  rank: number;
  holder: string;
  balance: string;
  share: string;
  limit: string;
  frozen: boolean;
  authorized: boolean;
}

export const HOLDER_ROW_KEYS = ['rank', 'holder', 'balance', 'share', 'limit', 'frozen', 'authorized'] as const;

export const TRANSFERS_ANSWER_KEYS = ['result', 'coverage', 'count', 'marker', 'transfers'] as const;

export interface TransferRow {
  hash: string;
  ledger_index: number;
  executed_time: string;
  source: string;
  destination: string;
  /** The delivered amount. */
  amount: string;
  source_tag?: number;
  destination_tag?: number;
}

export const TRANSFER_ROW_KEYS = [
  'hash',
  'ledger_index',
  'executed_time',
  'source',
  'destination',
  'amount',
  'source_tag',
  'destination_tag',
] as const;

// -- the builders --------------------------------------------------------------------------------------------------

/**
 * A row of `tokens` as the api reads it: the columns the objects are made of. A token with no code has `code` `''`; one with no
 * `issuer_ledger` (0) has no known settings; `listed` is 0 or 1 and `toml` is JSON text, `''` when not listed.
 */
export type StoredToken = Pick<
  TokensRow,
  | 'issuer'
  | 'currency'
  | 'code'
  | 'holders'
  | 'trust_lines'
  | 'supply'
  | 'last_ledger'
  | 'issuer_ledger'
  | 'issuer_flags'
  | 'transfer_rate'
  | 'domain'
  | 'listed'
  | 'name'
  | 'toml'
>;

/**
 * The totals of the list. `holders` is the distinct holders of the live generation, counted by its housekeeping: a generation that
 * was just promoted has `holders_ledger` 0 until the next housekeeping, and its `holders` of 0 means "not counted yet", so the
 * count is left out and a 0 is never served for it. `native_volume` is the `day` set's total, `undefined` while there is no set.
 */
export function issuedTotals(
  counts: { tokens: number; tokens_with_10_holders: number },
  generation: { holders: number; holders_ledger: number },
  nativeVolume: string | undefined,
): IssuedTotals {
  return {
    tokens: counts.tokens,
    tokens_with_10_holders: counts.tokens_with_10_holders,
    ...(generation.holders_ledger !== 0 && { holders: generation.holders }),
    ...(nativeVolume !== undefined && { native_volume: nativeVolume }),
  };
}

/** The facts of the market that are known, in the order of the keys. */
function marketFields(m: TokenMarketFacts): Partial<TokenMarketFacts> {
  return {
    ...(m.price !== undefined && { price: m.price }),
    ...(m.price_change !== undefined && { price_change: m.price_change }),
    ...(m.price_time !== undefined && { price_time: m.price_time }),
    ...(m.native_volume !== undefined && { native_volume: m.native_volume }),
    ...(m.trades !== undefined && { trades: m.trades }),
  };
}

/** A token of the list, from its row and the price and volume of the market (`rank` is its place in the list). */
export function issuedTokenRow(t: StoredToken & { rank: number }, m: TokenMarketFacts): IssuedTokenRow {
  return {
    rank: t.rank,
    currency: t.currency,
    ...(t.code !== '' && { code: t.code }),
    issuer: t.issuer,
    holders: t.holders,
    trust_lines: t.trust_lines,
    supply: t.supply,
    ...marketFields(m),
    ...(t.domain !== '' && { domain: t.domain }),
    listed: t.listed === 1,
    ...(t.name !== '' && { name: t.name }),
  };
}

/**
 * A token of the detail: the row's facts, the `toml_url` of its domain (listed or not), the served fields of its toml (left out
 * when it has none, which a listed token whose entry has no served field also is: `'{}'`), the issuer's settings (left out while
 * the issuer has no row in the state tables, `issuer_ledger` 0) and its markets.
 */
export function tokenObject(
  t: StoredToken,
  m: TokenMarketFacts,
  markets: TokenMarket[],
  profile: NetworkProfile,
): TokenObject {
  const toml = servedTomlFields(t.toml);
  return {
    currency: t.currency,
    ...(t.code !== '' && { code: t.code }),
    issuer: t.issuer,
    holders: t.holders,
    trust_lines: t.trust_lines,
    supply: t.supply,
    ...marketFields(m),
    ...(t.domain !== '' && { domain: t.domain, toml_url: tomlUrlOf(t.domain, profile) }),
    listed: t.listed === 1,
    ...(Object.keys(toml).length > 0 && { toml }),
    ...(t.issuer_ledger !== 0 && { issuer_settings: issuerSettingsOf(t.issuer_flags, t.transfer_rate, profile) }),
    markets,
    last_ledger: t.last_ledger,
  };
}

/**
 * The settings of an issuer from the `Flags` and the `TransferRate` of its account. The flags are read by name from the network's
 * own list (`accountFlagsOf`): `0x80000000` is `AllowTrustLineClawback` on the XRP Ledger and `DisallowIncomingRemit` on Xahau,
 * whose clawback flag is `0x1000`. A flag the network does not name is off.
 */
export function issuerSettingsOf(flags: number, transferRate: number, profile: NetworkProfile): IssuerSettings {
  const named = namedAccountFlags(flags, accountFlagsOf(profile));
  return {
    transfer_fee: transferFeeOf(transferRate),
    global_freeze: named.GlobalFreeze === true,
    no_freeze: named.NoFreeze === true,
    allow_trust_line_clawback: named.AllowTrustLineClawback === true,
    require_auth: named.RequireAuth === true,
    default_ripple: named.DefaultRipple === true,
  };
}

/** A transfer rate of 1.0, the ledger's `QUOTIENT_ONE`: no fee. */
const RATE_ONE = 1_000_000_000;

/**
 * The fee a `TransferRate` charges, in percent: `(rate - 1e9) / 1e7`, exact, as plain digits (`1002000000` is `0.2`, `1000000001`
 * is `0.0000001`). `0` (no rate) and `1e9` are `"0"`; a rate below 1.0, which the ledger does not allow, is no fee either.
 */
export function transferFeeOf(rate: number): string {
  if (rate <= RATE_ONE) return '0';
  return new BigNumber(rate).minus(RATE_ONE).shiftedBy(-7).toFixed();
}

// A quotient rounded once, half up (a tie goes away from zero), at the 6th decimal: a quotient cut at the default 20 places first
// could round twice.
const Share = BigNumber.clone({ DECIMAL_PLACES: 6, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });

/** The share of the supply a balance is, exact, rounded half up to 6 decimals: `0.117300`. A supply of 0 gives `0.000000`. */
export function shareOf(balance: string, supply: string): string {
  const total = new Share(supply);
  if (!total.gt(0)) return new Share(0).toFixed(6);
  return new Share(balance).dividedBy(total).toFixed(6);
}

/** A holder of the token's list (`rank` is its place by balance), with its share of `supply`. */
export function holderRow(
  h: { rank: number; holder: string; balance: string; limit: string; frozen: number; authorized: number },
  supply: string,
): HolderRow {
  return {
    rank: h.rank,
    holder: h.holder,
    balance: h.balance,
    share: shareOf(h.balance, supply),
    limit: h.limit,
    frozen: h.frozen === 1,
    authorized: h.authorized === 1,
  };
}

/** A transfer of the token: the payment's hash and delivered amount; the tags are there when the payment has them (0 is a tag). */
export function transferRow(p: PaymentObject): TransferRow {
  return {
    hash: p.tx_hash,
    ledger_index: p.ledger_index,
    executed_time: p.executed_time,
    source: p.source,
    destination: p.destination,
    amount: p.delivered_amount,
    ...(p.source_tag !== undefined && { source_tag: p.source_tag }),
    ...(p.destination_tag !== undefined && { destination_tag: p.destination_tag }),
  };
}

/**
 * The CSV rows have fixed columns, the keys of the row in their order, an empty cell where the row has none: the CSV of a page
 * must not get other headers than the next page's (`flattenJSON` takes its columns from the keys a row has).
 */
export function toIssuedTokenCsvRow(row: IssuedTokenRow): CsvRow {
  return toCsvRow(row, ISSUED_TOKEN_ROW_KEYS);
}

export function toTransferCsvRow(row: TransferRow): CsvRow {
  return toCsvRow(row, TRANSFER_ROW_KEYS);
}
