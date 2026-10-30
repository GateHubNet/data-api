import {
  getNetworkProfile,
  NetworkName,
  STATE_PARSER_VERSION,
  Table,
  TokenGenerationsRow,
  TokenLinesRow,
  TokensRow,
} from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import type { Harness } from '../harness';
import { accountAt, insertParts } from './amm';
import { MARKETS_ISSUER, MARKETS_ISSUER2, MARKETS_NOW, seedMarketsWorld } from './markets-world';
import { ledgerRow } from './validators-seed';

/**
 * The world of the suites of the token routes (D6): the rows the tokens job writes, put in the tables directly (`token_generations`,
 * `tokens`, `token_lines`), with the ledgers and the markets sets the answers name.
 *
 * **The generations.** Three of them sit side by side, as the job leaves them: 6 is retired (the tokens of an older build, with
 * other numbers, and a bulk of rows to read past, see `RETIRED_BULK`), 7 is live and 8 is building (a token no list shows). A reader that
 * does not name its generation would serve the other two. Each generation has the rows of its history in `token_generations`
 * (the older ones are other versions of the same row); the newest row of the live one has `through_ledger` `THROUGH`,
 * `holders` `HOLDERS` counted at `HOLDERS_LEDGER`.
 *
 * **The live tokens** (`LIVE_TOKENS`, all newest versions, one part of the table). Each has `holders` lines of a balance of
 * `1.5`, `2.5`, … (the supply is their exact sum), and `trust_lines - holders` lines of a balance of 0 and a limit above 0,
 * all in `token_lines`; the tokens of `MARKETS_ISSUER` are those of the markets world (`markets-world.ts`: read its header for the
 * trades), so that their price and volume are worked out from its numbers. Beside them, in older versions and other parts:
 *  - `OLD`, whose first version has 900 holders (the newest, 8, is the one that counts);
 *  - `DED`, 500 holders in its first version and deleted in the newest: no list shows it.
 *
 * **The ledgers**: the first ledger of the network (its profile's, parser `STATE_PARSER_VERSION`: the state coverage is whole
 * from there) and the ledger `THROUGH`, whose close time the answers name.
 */

export const RETIRED = 6;
export const LIVE = 7;
export const BUILDING = 8;

/** The ledger the live generation is through, and when it closed (unix seconds). */
export const THROUGH = 107_900_000;
export const THROUGH_CLOSE = 1_793_245_841;
/** The distinct holders of all tokens of the live generation, and the ledger they were counted at. */
export const HOLDERS = 4_321;
export const HOLDERS_LEDGER = THROUGH - 5;

/** The issuers: the first two issue the tokens of the markets world, the others have no market. */
export const ISSUER_A = MARKETS_ISSUER;
export const ISSUER_B = MARKETS_ISSUER2;
export const ISSUER_C = accountAt(0x3001);
export const ISSUER_D = accountAt(0x4001);

/** The standard hex of the currency code `NPUSD` (the example of the spec), and a demurrage code, which has no code of its own. */
export const NPUSD_HEX = '4E50555344000000000000000000000000000000';
export const DEMURRAGE_HEX = '0158415500000000C1F76FF6ECB0BAC600000000';

/** `AccountRoot` flags the issuers of the world have (the detail reads them, Task 11). */
export const FLAGS = {
  defaultRipple: 0x00800000,
  requireAuth: 0x00040000,
  noFreeze: 0x00200000,
  globalFreeze: 0x00400000,
} as const;

/** A token of the live generation as the world declares it. */
export interface SeedToken {
  /** The name the tests give it. */
  key: string;
  issuer: string;
  /** The currency as the ledger holds it: 3 characters, or 40 hex digits. */
  currency: string;
  /** The currency as text; `''` for a currency with none. */
  code: string;
  holders: number;
  /** The lines that count: `holders` of them have a balance. */
  trustLines: number;
  domain?: string;
  listed?: boolean;
  /** The name the toml gives the token. */
  name?: string;
  issuerFlags: number;
  transferRate: number;
  /** 0: the issuer has no row in the state tables, its settings are not known. */
  issuerLedger: number;
}

const token = (
  t: Partial<SeedToken> & Pick<SeedToken, 'key' | 'issuer' | 'currency' | 'holders' | 'trustLines'>,
): SeedToken => ({
  code: t.currency.length === 3 ? t.currency : '',
  issuerFlags: FLAGS.defaultRipple,
  transferRate: 0,
  issuerLedger: THROUGH - 100,
  ...t,
});

/**
 * The tokens of the live generation. The issuers' settings: A has DefaultRipple; B requires auth, has no freeze and charges 0.2
 * percent; C has frozen all its lines; D has no row in the state tables.
 */
export const LIVE_TOKENS: SeedToken[] = [
  token({
    key: 'usd',
    issuer: ISSUER_A,
    currency: 'USD',
    holders: 120,
    trustLines: 150,
    domain: 'northpeak.example',
    listed: true,
    name: 'Northpeak USD',
  }),
  token({ key: 'zzz', issuer: ISSUER_A, currency: 'ZZZ', holders: 60, trustLines: 64, domain: 'zedcoin.example' }),
  token({ key: 'eur', issuer: ISSUER_A, currency: 'EUR', holders: 60, trustLines: 60 }),
  token({
    key: 'usd2',
    issuer: ISSUER_B,
    currency: 'USD',
    holders: 60,
    trustLines: 61,
    domain: 'bluewave.example',
    listed: true,
    name: 'Bluewave Dollar',
    issuerFlags: FLAGS.requireAuth | FLAGS.noFreeze,
    transferRate: 1_002_000_000,
  }),
  token({
    key: 'npusd',
    issuer: ISSUER_B,
    currency: NPUSD_HEX,
    code: 'NPUSD',
    holders: 40,
    trustLines: 41,
    domain: 'northpeak.example',
    listed: true,
    name: 'Northpeak Dollar',
    issuerFlags: FLAGS.requireAuth | FLAGS.noFreeze,
    transferRate: 1_002_000_000,
  }),
  token({
    key: 'hex',
    issuer: ISSUER_C,
    currency: DEMURRAGE_HEX,
    holders: 25,
    trustLines: 30,
    issuerFlags: FLAGS.globalFreeze,
  }),
  token({
    key: 'xyz',
    issuer: ISSUER_C,
    currency: 'XYZ',
    holders: 15,
    trustLines: 15,
    issuerFlags: FLAGS.globalFreeze,
  }),
  token({ key: 'btc', issuer: ISSUER_A, currency: 'BTC', holders: 12, trustLines: 14 }),
  token({ key: 'jpy', issuer: ISSUER_A, currency: 'JPY', holders: 10, trustLines: 10 }),
  token({ key: 'aud', issuer: ISSUER_A, currency: 'AUD', holders: 9, trustLines: 12 }),
  token({ key: 'old', issuer: ISSUER_D, currency: 'OLD', holders: 8, trustLines: 9, issuerFlags: 0, issuerLedger: 0 }),
  token({ key: 'cad', issuer: ISSUER_A, currency: 'CAD', holders: 5, trustLines: 5 }),
  token({ key: 'nzd', issuer: ISSUER_A, currency: 'NZD', holders: 3, trustLines: 4 }),
  token({ key: 'gbp', issuer: ISSUER_A, currency: 'GBP', holders: 1, trustLines: 1 }),
  token({ key: 'chf', issuer: ISSUER_A, currency: 'CHF', holders: 0, trustLines: 2 }),
];

/** The order of `LIVE_TOKENS` the list serves, by key: holders descending, then issuer and currency (worked out by hand in the suites). */
export const LIST_ORDER = [
  'usd',
  'usd2', // 60 holders, the issuer B before A
  'eur', // and A's currencies in order
  'zzz',
  'npusd',
  'hex',
  'xyz',
  'btc',
  'jpy',
  'aud',
  'old',
  'cad',
  'nzd',
  'gbp',
  'chf',
];

/** The tokens only a hidden generation or version has. */
export const DEAD = { issuer: ISSUER_C, currency: 'DED' } as const;
export const RETIRED_ONLY = { issuer: ISSUER_D, currency: 'RET' } as const;
export const BUILDING_ONLY = { issuer: ISSUER_D, currency: 'BLD' } as const;

/** The balance of the `i`-th holder (1-based) of a token: `1.5`, `2.5`, … */
export const balanceOf = (i: number): string => `${i}.5`;

/** The supply of a token: the exact sum of the balances of its holders. */
export const supplyOf = (holders: number): string =>
  Array.from({ length: holders }, (_, i) => new BigNumber(balanceOf(i + 1)))
    .reduce((s, b) => s.plus(b), new BigNumber(0))
    .toFixed();

/** The holder account of the `i`-th line (1-based) of the `n`-th token. */
export const holderAt = (n: number, i: number): string => accountAt(0x100000 + n * 1000 + i);

const OLD_VERSION = 1_000;
const NEW_VERSION = 2_000;

/** A row of `tokens` with the quiet values of a token nobody lists. */
export function tokensRow(over: Partial<TokensRow> & Pick<TokensRow, 'generation' | 'issuer' | 'currency'>): TokensRow {
  return {
    code: over.currency.length === 3 ? over.currency : '',
    holders: 0,
    trust_lines: 0,
    supply: '0',
    supply_f: 0,
    last_ledger: THROUGH - 10,
    issuer_ledger: THROUGH - 100,
    issuer_flags: 0,
    transfer_rate: 0,
    domain: '',
    listed: 0,
    name: '',
    toml: '',
    deleted: 0,
    version: NEW_VERSION,
    ...over,
  };
}

/** The row of `tokens` of a token of `LIVE_TOKENS` (the newest version, in the live generation). */
export function liveRow(t: SeedToken): TokensRow {
  const supply = supplyOf(t.holders);
  return tokensRow({
    generation: LIVE,
    issuer: t.issuer,
    currency: t.currency,
    code: t.code,
    holders: t.holders,
    trust_lines: t.trustLines,
    supply,
    supply_f: Number(supply),
    issuer_ledger: t.issuerLedger,
    issuer_flags: t.issuerFlags,
    transfer_rate: t.transferRate,
    domain: t.domain ?? '',
    listed: t.listed ? 1 : 0,
    name: t.name ?? '',
    toml: t.listed ? JSON.stringify({ code: t.code, issuer: t.issuer, name: t.name ?? '' }) : '',
  });
}

/** A row of `token_lines`: a holder with a balance of the token, in the live generation unless said. */
export function lineRow(
  t: Pick<SeedToken, 'issuer' | 'currency'>,
  holder: string,
  balance: string,
  over: Partial<TokenLinesRow> = {},
): TokenLinesRow {
  return {
    generation: LIVE,
    issuer: t.issuer,
    currency: t.currency,
    holder,
    balance,
    balance_f: Number(balance),
    limit: '1000000',
    frozen: 0,
    authorized: 0,
    ledger_index: THROUGH - 10,
    deleted: 0,
    version: NEW_VERSION,
    ...over,
  };
}

/** The lines of a token of `LIVE_TOKENS` (the `n`-th): `holders` with a balance, then the rest with none. */
export function linesOf(t: SeedToken, n: number): TokenLinesRow[] {
  return Array.from({ length: t.trustLines }, (_, i) =>
    lineRow(t, holderAt(n, i + 1), i < t.holders ? balanceOf(i + 1) : '0'),
  );
}

/** A row of `token_generations`: the state of a generation as of one version. */
export function generationRow(
  generation: number,
  state: TokenGenerationsRow['state'],
  version: number,
  over: Partial<TokenGenerationsRow> = {},
): TokenGenerationsRow {
  return {
    generation,
    state,
    config_version: 1,
    coverage_from: 32_570,
    head_ledger: THROUGH - 1_000,
    account_cursor: '',
    pass_done: 1,
    through_ledger: THROUGH,
    repair_from: 0,
    holders: 0,
    holders_ledger: 0,
    started_at: THROUGH_CLOSE - 3_600,
    changed_at: THROUGH_CLOSE - 5,
    version,
    ...over,
  };
}

/**
 * The generations of the world. The live generation has been through `building` (version 300, its pass not finished), a first `live` (400,
 * holders not counted yet) and the `live` row of now (500); generation 6 was live and is retired; generation 8 builds.
 */
export const GENERATION_PARTS: TokenGenerationsRow[][] = [
  [generationRow(RETIRED, 'building', 100, { pass_done: 0, through_ledger: THROUGH - 9_000 })],
  [generationRow(RETIRED, 'live', 200, { through_ledger: THROUGH - 8_000 })],
  [generationRow(LIVE, 'building', 300, { pass_done: 0, through_ledger: THROUGH - 500 })],
  [generationRow(RETIRED, 'retired', 350, { through_ledger: THROUGH - 100 })],
  [generationRow(LIVE, 'live', 400, { through_ledger: THROUGH - 10 })],
  [generationRow(LIVE, 'live', 500, { holders: HOLDERS, holders_ledger: HOLDERS_LEDGER })],
  [generationRow(BUILDING, 'building', 600, { pass_done: 0, through_ledger: THROUGH - 700 })],
];

/** The rows of `tokens` in the live generation (older versions come first, in a part of their own) and what the tests count. */
export const LIVE_OLD_ROWS = 2;
export const LIVE_NEW_ROWS = LIVE_TOKENS.length + 1;
/** The parts of the live partition: the older versions, and the newest. */
export const LIVE_PARTS = 2;

/** The rows of the retired generation's bulk: this many in each of four parts (more than two granules each), none of them a live token. */
export const RETIRED_BULK_PER_PART = 20_000;
export const RETIRED_BULK_PARTS = 4;

/** The bulk of the retired generation: `perPart` tokens of no one's in each of four parts. A reader that reads past its generation reads them. */
async function seedRetiredBulk(h: Harness, perPart: number): Promise<void> {
  for (let part = 0; part < RETIRED_BULK_PARTS; part++) {
    await h.ch.command(
      `INSERT INTO ${Table.Tokens}
       SELECT toUInt32({generation:UInt32}) AS generation,
              concat('rBulkIssuer', toString({part:UInt32} * 1000000 + number)) AS issuer,
              'BLK' AS currency, 'BLK' AS code,
              toUInt32(number % 5000) AS holders, toUInt32(number % 5000 + 1) AS trust_lines,
              '1' AS supply, toFloat64(1) AS supply_f,
              toUInt32(1) AS last_ledger, toUInt32(1) AS issuer_ledger, toUInt32(0) AS issuer_flags, toUInt32(0) AS transfer_rate,
              '' AS domain, toUInt8(0) AS listed, '' AS name, '' AS toml, toUInt8(0) AS deleted, toUInt64(1) AS version
         FROM numbers({n:UInt32})`,
      { generation: RETIRED, part, n: perPart },
    );
  }
}

export interface TokensWorldOptions {
  /** The network of the harness. Default: `xrpl`. */
  network?: NetworkName;
  /** Write the `day` and `30day` `include` sets of the markets world (`seedMarketsWorld`). Default: yes. */
  markets?: boolean;
  /** Write the bulk of the retired generation. Default: yes. */
  bulk?: boolean;
  /** Write the lines of the live tokens. Default: yes. */
  lines?: boolean;
}

/**
 * Seeds the harness's database with the world of the top of this file. Merges of `tokens` and `token_lines` are stopped first and the
 * older versions come in parts of their own, so that a reader has the versions to choose between that a table keeps until a merge.
 */
export async function seedTokensWorld(h: Harness, options: TokensWorldOptions = {}): Promise<void> {
  const profile = getNetworkProfile(options.network ?? 'xrpl');
  await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.Tokens}`);
  await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.TokenLines}`);
  await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.TokenGenerations}`);

  await h.ch.insert(Table.Ledgers, [
    { ...ledgerRow(profile.firstLedger ?? 1, THROUGH_CLOSE - 400_000_000), parser_version: STATE_PARSER_VERSION },
    { ...ledgerRow(THROUGH, THROUGH_CLOSE), parser_version: STATE_PARSER_VERSION },
  ]);
  await insertParts(h, Table.TokenGenerations, ...GENERATION_PARTS);

  await insertParts(
    h,
    Table.Tokens,
    // the older versions: OLD had 900 holders, DED was listed with 500
    [
      tokensRow({ generation: LIVE, issuer: ISSUER_D, currency: 'OLD', holders: 900, version: OLD_VERSION }),
      tokensRow({ generation: LIVE, issuer: DEAD.issuer, currency: DEAD.currency, holders: 500, version: OLD_VERSION }),
    ],
    // the newest versions, DED deleted among them
    [
      ...LIVE_TOKENS.map(liveRow),
      tokensRow({ generation: LIVE, issuer: DEAD.issuer, currency: DEAD.currency, holders: 500, deleted: 1 }),
    ],
    // the other generations: the same USD with other numbers, a token of each only, and the retired one's bulk (below)
    [
      tokensRow({ generation: RETIRED, issuer: ISSUER_A, currency: 'USD', holders: 777, trust_lines: 800 }),
      tokensRow({ generation: RETIRED, issuer: RETIRED_ONLY.issuer, currency: RETIRED_ONLY.currency, holders: 1_000 }),
      tokensRow({
        generation: BUILDING,
        issuer: BUILDING_ONLY.issuer,
        currency: BUILDING_ONLY.currency,
        holders: 2_000,
      }),
    ],
  );
  if (options.bulk !== false) await seedRetiredBulk(h, RETIRED_BULK_PER_PART);

  if (options.lines !== false) await h.ch.insert(Table.TokenLines, LIVE_TOKENS.flatMap(linesOf));

  if (options.markets !== false) {
    await seedMarketsWorld(h, MARKETS_NOW, { periods: ['day', '30day'], native: profile.nativeCurrency });
  }
}
