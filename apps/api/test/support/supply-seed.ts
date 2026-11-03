import {
  amendmentId,
  GenesisMintsRow,
  ImportsRow,
  LedgersRow,
  NetworkSupplyRow,
  PARSER_VERSION,
  RewardClaimsRow,
  Table,
} from '@gatehub/data-api-shared';
import type { Coverage } from '../../src/common/feature-coverage.service';
import type { Harness } from '../harness';
import { insertState, ledgerRow } from './validators-seed';

/**
 * The worlds of `supply.e2e-spec.ts`: the snapshots the syncer's `supply` job would have written (the figures are those of the
 * examples of spec 5.1, in drops), and the ledgers and ledger states the coverage of a part is read from.
 *
 * A snapshot is put in `network_supply` as the job writes it, in one insert. The coverage of a part depends only on `ledgers`
 * (the oldest ledger stored, or the newest one an older parser wrote) and, for a part that starts with an amendment, on the
 * ledger state `network_state` lists the amendments in: `Escrow` is retired, and gets its enable ledger (28,685,313, from the
 * metadata of the network) only once the ledger state lists it; `AMM` likewise (86,795,265).
 */

const unix = (iso: string): number => Date.parse(iso) / 1000;

/** The ledger Escrow was enabled in on the XRP Ledger, and the one AMM was (the metadata of the network, `amendments/xrpl.json`). */
export const ESCROW_ENABLED = 28_685_313;
export const AMM_ENABLED = 86_795_265;
/** The first ledger of the XRP Ledger (`NetworkProfile.firstLedger`), and of Xahau. */
export const XRPL_FIRST_LEDGER = 32_570;
export const XAHAU_FIRST_LEDGER = 1;

/** XRPL: 99,985,312,374.716318 XRP in existence, 35,212,847,105.402318 of them in 12,879 escrows, 14,594 pools holding 46,218,377.402915. */
export const XRPL_SNAPSHOT: NetworkSupplyRow = {
  ledger_index: 107_747_456,
  close_time: unix('2026-10-24T21:00:00Z'),
  started_at: unix('2026-10-24T20:59:12Z'),
  computed_at: unix('2026-10-24T21:01:47Z'),
  total_coins: '99985312374716318',
  burned: '14687625283682',
  escrowed: '35212847105402318',
  escrow_count: '12879',
  amm: '46218377402915',
  amm_pools: 14_594,
  reserve_base: '1000000',
  reserve_inc: '200000',
  accounts: '6410280',
  owner_count: '16998620',
  minted_rewards: null,
  minted_import: null,
  minted_genesis: null,
  version: '1761339707000',
};

/** Xahau: 613,401,782.117306 XAH in existence, 18,406,227.318004 in 2,140 escrows, 49,425,551.616207 minted, no AMM. */
export const XAHAU_SNAPSHOT: NetworkSupplyRow = {
  ledger_index: 26_603_520,
  close_time: unix('2026-10-24T21:00:02Z'),
  started_at: unix('2026-10-24T21:00:00Z'),
  computed_at: unix('2026-10-24T21:00:31Z'),
  total_coins: '613401782117306',
  burned: '2318640227',
  escrowed: '18406227318004',
  escrow_count: '2140',
  amm: null,
  amm_pools: 0,
  reserve_base: '1000000',
  reserve_inc: '200000',
  accounts: '186412',
  owner_count: '412806',
  minted_rewards: '41203318512207',
  minted_import: '8102233104000',
  minted_genesis: '120000000000',
  version: '1761339631000',
};

/** The coverage of each part of the XRPL answer. */
export interface XrplCoverages {
  escrows: Coverage;
  amm: Coverage;
  reserves: Coverage;
}

/** The answer for `XRPL_SNAPSHOT`, written out: the figures of the spec as text, the keys in the order of spec 5.1. */
export function xrplAnswer(c: XrplCoverages, currency: 'XRP' | 'XAH' = 'XRP'): Record<string, unknown> {
  return {
    result: 'success',
    ledger_index: 107_747_456,
    close_time: '2026-10-24T21:00:00Z',
    computed_at: '2026-10-24T21:01:47Z',
    currency,
    total: '99985312374.716318',
    burned: { amount: '14687625.283682' },
    escrowed: { amount: '35212847105.402318', escrows: 12_879, coverage: c.escrows },
    circulating: { amount: '64772465269.314', coverage: c.escrows },
    amm: { amount: '46218377.402915', pools: 14_594, coverage: c.amm },
    reserves: {
      amount: '9810004',
      accounts: 6_410_280,
      owner_count: 16_998_620,
      base: '1',
      increment: '0.2',
      coverage: c.reserves,
    },
  };
}

/** The coverage of each part of the Xahau answer. */
export interface XahauCoverages {
  burned: Coverage;
  minted: Coverage;
  escrows: Coverage;
  reserves: Coverage;
}

/** The answer for `XAHAU_SNAPSHOT`, written out. */
export function xahauAnswer(c: XahauCoverages): Record<string, unknown> {
  return {
    result: 'success',
    ledger_index: 26_603_520,
    close_time: '2026-10-24T21:00:02Z',
    computed_at: '2026-10-24T21:00:31Z',
    currency: 'XAH',
    total: '613401782.117306',
    burned: { amount: '2318.640227', coverage: c.burned },
    minted: {
      amount: '49425551.616207',
      rewards: '41203318.512207',
      import: '8102233.104',
      genesis_mint: '120000',
      coverage: c.minted,
    },
    escrowed: { amount: '18406227.318004', escrows: 2140, coverage: c.escrows },
    circulating: { amount: '594995554.799302', coverage: c.escrows },
    reserves: {
      amount: '268973.2',
      accounts: 186_412,
      owner_count: 412_806,
      base: '1',
      increment: '0.2',
      coverage: c.reserves,
    },
  };
}

/** Puts snapshots in `network_supply`, one insert. */
export async function seedSnapshots(h: Harness, rows: NetworkSupplyRow[]): Promise<void> {
  await h.ch.insert(Table.NetworkSupply, rows);
}

/**
 * Puts ledgers in `ledgers`, each `[ledger_index, parser_version]` (the default is the current parser): what the coverage of a
 * feature is read from. The oldest of them is where the coverage of a feature starts, unless a ledger of an older parser is above
 * it.
 */
export async function seedLedgers(h: Harness, ledgers: [number, number?][]): Promise<void> {
  await h.ch.insert(
    Table.Ledgers,
    ledgers.map(([index, parserVersion]) => ({
      ...ledgerRow(index, 1_700_000_000 + index),
      parser_version: parserVersion ?? PARSER_VERSION,
    })),
  );
}

/** Writes the ids of the amendments to the ledger state the api reads them from (`ledgerIndex` is the ledger it was polled at). */
export async function listAmendments(h: Harness, names: string[], ledgerIndex: number): Promise<void> {
  await insertState(h.ch, [
    { ledger_index: ledgerIndex, polled_at: Date.now() / 1000 - 5, amendments: names.map((name) => amendmentId(name)) },
  ]);
}

/**
 * `rows` and, below them, `count` older snapshots (ledgers 1 to `count`), merged into one part: the newest snapshot is in the last
 * granule of a part that holds many more rows, as it is after the table has been written for a while. Merges are stopped
 * afterwards, so the part stays one (and the harness drops the database). The read of the newest snapshot has to skip the others.
 */
export async function seedAmongOlderSnapshots(h: Harness, rows: NetworkSupplyRow[], count: number): Promise<void> {
  await seedSnapshots(h, rows);
  await h.ch.command(
    `INSERT INTO ${Table.NetworkSupply}
     SELECT toUInt32(n.number + 1), toDateTime(1700000000, 'UTC'), toDateTime(1700000000, 'UTC'), toDateTime(1700000000, 'UTC'),
            toUInt64(99985312374716318), toUInt64(14687625283682), toUInt64(0), toUInt64(0), NULL, toUInt32(0), NULL, NULL,
            toUInt64(0), toUInt64(0), NULL, NULL, NULL, toUInt64(1)
       FROM numbers({count:UInt32}) AS n`,
    { count },
  );
  await h.ch.command(`OPTIMIZE TABLE ${Table.NetworkSupply} FINAL`);
  await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.NetworkSupply}`);
}

// =====================================================================================================================
// the minted world (Xahau, `supply-minted.e2e-spec.ts`)
// =====================================================================================================================

/**
 * Five UTC days of Xahau, the ledgers that closed in them and the mints of three of them, written by hand: what the ingest of parser
 * 9 would have stored (`genesis_mints`, `imports`, `reward_claims`), in drops. Ledger 1 is Xahau's: its close time is 0
 * (`docs/operations.md`), and the coverage of every feature starts at it (`NetworkProfile.firstLedger`).
 *
 *   day         ledgers      mints (drops)
 *   2026-10-20  2, 3         a reward of 1,500,000 and one of 250,000 (a claim is their parent), an import of 2,000,000
 *   2026-10-21  4, 5         none
 *   2026-10-22  6            a GenesisMint of 5,000,000, and one of 1,000,000 whose parent is no claim
 *   2026-10-23  7, 8         none
 *   2026-10-24  9, 10        a reward of 3,000,000, an import of 7 and a GenesisMint of 2^53 + 1
 *
 * The last day is the running one: the newest ledger, 10, closed in it.
 */

/** The days of the world, as UTC dates. */
export const MINTED_DAYS = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'] as const;

/** 2^53 + 1: the one amount no `number` holds. */
export const BEYOND_2_53 = '9007199254740993';

/** A ledger of the world: its index and when it closed (`0`: no close time, as Xahau's ledger 1). */
export interface WorldLedger {
  index: number;
  closed: string | 0;
}

export const MINTED_LEDGERS: WorldLedger[] = [
  { index: 1, closed: 0 },
  { index: 2, closed: '2026-10-20T00:00:05Z' },
  { index: 3, closed: '2026-10-20T12:00:00Z' },
  { index: 4, closed: '2026-10-21T00:00:00Z' }, // the first second of a day
  { index: 5, closed: '2026-10-21T23:59:59Z' }, // the last second of a day
  { index: 6, closed: '2026-10-22T06:00:00Z' },
  { index: 7, closed: '2026-10-23T00:00:03Z' },
  { index: 8, closed: '2026-10-23T18:30:00Z' },
  { index: 9, closed: '2026-10-24T09:00:00Z' },
  { index: 10, closed: '2026-10-24T09:00:04Z' },
];

/** The unix seconds of an ISO time, `0` for a ledger without one. */
const closeOf = (closed: string | 0): number => (closed === 0 ? 0 : unix(closed));

/** The close time of a ledger of the world (or of one a test adds). */
const closeTimeOfLedger = (index: number, extra: WorldLedger[]): number => {
  const found = [...MINTED_LEDGERS, ...extra].find((ledger) => ledger.index === index);
  if (found === undefined) throw new Error(`the minted world has no ledger ${index}`);
  return closeOf(found.closed);
};

const claim = (ledger: number, hash: string): RewardClaimsRow => ({
  ledger_index: ledger,
  tx_index: 0,
  tx_hash: hash,
  close_time: closeTimeOfLedger(ledger, []),
  account: 'rMintedWorldClaimer',
  issuer: '',
  opt_out: 0,
});

/** A `GenesisMint` entry; a `parent` of `''` has no `EmitDetails`. */
export const genesisMint = (
  ledger: number,
  txIndex: number,
  mintIndex: number,
  amount: string | number,
  parent: string,
  extra: WorldLedger[] = [],
): GenesisMintsRow => ({
  ledger_index: ledger,
  tx_index: txIndex,
  mint_index: mintIndex,
  tx_hash: `MINT-${ledger}-${txIndex}`,
  close_time: closeTimeOfLedger(ledger, extra),
  destination: 'rMintedWorldDestination',
  amount,
  parent_tx_hash: parent,
  emit_hook_hash: parent === '' ? '' : 'AAAA',
});

export const importOf = (
  ledger: number,
  txIndex: number,
  minted: string | number,
  extra: WorldLedger[] = [],
): ImportsRow => ({
  ledger_index: ledger,
  tx_index: txIndex,
  tx_hash: `IMPORT-${ledger}-${txIndex}`,
  close_time: closeTimeOfLedger(ledger, extra),
  account: 'rMintedWorldImporter',
  minted,
  account_created: 0,
});

/** The claims of the world: the parents of its rewards. */
export const MINTED_CLAIMS: RewardClaimsRow[] = [claim(2, 'CLAIM-A'), claim(9, 'CLAIM-B')];

export const MINTED_GENESIS_MINTS: GenesisMintsRow[] = [
  genesisMint(3, 0, 0, 1_500_000, 'CLAIM-A'),
  genesisMint(3, 0, 1, 250_000, 'CLAIM-A'),
  genesisMint(6, 0, 0, 5_000_000, ''),
  genesisMint(6, 1, 0, 1_000_000, 'A-TRANSACTION-THAT-IS-NOT-A-CLAIM'),
  genesisMint(10, 0, 0, 3_000_000, 'CLAIM-B'),
  genesisMint(10, 2, 0, BEYOND_2_53, ''),
];

export const MINTED_IMPORTS: ImportsRow[] = [importOf(3, 1, 2_000_000), importOf(10, 1, 7)];

/** One row of the answer, as the route serves it. */
export interface MintedRowText {
  date: string;
  amount: string;
  rewards: string;
  import: string;
  genesis_mint: string;
}

const dayRow = (date: string, amount: string, rewards: string, imported: string, genesis: string): MintedRowText => ({
  date: `${date}T00:00:00Z`,
  amount,
  rewards,
  import: imported,
  genesis_mint: genesis,
});

/** The rows of the world, oldest day first: every day is there, the days without a mint with zeros. */
export const MINTED_ROWS: MintedRowText[] = [
  dayRow('2026-10-20', '3.75', '1.75', '2', '0'),
  dayRow('2026-10-21', '0', '0', '0', '0'),
  dayRow('2026-10-22', '6', '0', '0', '6'),
  dayRow('2026-10-23', '0', '0', '0', '0'),
  // 3,000,000 + 7 + 9,007,199,254,740,993 drops: past 2^53, the sum is exact
  dayRow('2026-10-24', '9007199257.741', '3', '0.000007', '9007199254.740993'),
];

/** The ledgers as `ledgers` rows: `parser` is the parser that wrote the ledgers up to `olderParserThrough` (8, before the mint tables). */
function ledgerRows(ledgers: WorldLedger[], olderParserThrough: number): LedgersRow[] {
  return ledgers.map((ledger) => ({
    ...ledgerRow(ledger.index, closeOf(ledger.closed)),
    parser_version: ledger.index <= olderParserThrough ? 8 : PARSER_VERSION,
  }));
}

/**
 * Writes the minted world: its ledgers and its mint rows. With `olderParserThrough` the ledgers up to it were written by parser 8, which
 * has no mint tables: they are stored, and have no mint rows, and the coverage of the mints starts above them.
 */
export async function seedMintedWorld(h: Harness, options: { olderParserThrough?: number } = {}): Promise<void> {
  const older = options.olderParserThrough ?? 0;
  await h.ch.insert(Table.Ledgers, ledgerRows(MINTED_LEDGERS, older));
  const written = <T extends { ledger_index: number }>(rows: T[]): T[] =>
    rows.filter((row) => row.ledger_index > older);
  await h.ch.insert(Table.RewardClaims, written(MINTED_CLAIMS));
  await h.ch.insert(Table.GenesisMints, written(MINTED_GENESIS_MINTS));
  await h.ch.insert(Table.Imports, written(MINTED_IMPORTS));
}

/** Writes more ledgers of the current parser (a ledger the live ingest committed after the world was written). */
export async function seedMoreLedgers(h: Harness, ledgers: WorldLedger[]): Promise<void> {
  await h.ch.insert(Table.Ledgers, ledgerRows(ledgers, 0));
}

/**
 * `days` daily ledgers from the day `first` (`YYYY-MM-DD`), one ledger a day at noon, and Xahau's ledger 1 with no close time: the
 * ledgers of a history long enough to fill pages. No mint rows.
 */
export async function seedDailyLedgers(h: Harness, first: string, days: number): Promise<void> {
  const start = unix(`${first}T12:00:00Z`);
  const rows: LedgersRow[] = [{ ...ledgerRow(1, 0), parser_version: PARSER_VERSION }];
  for (let i = 0; i < days; i++) {
    rows.push({ ...ledgerRow(2 + i, start + i * 86_400), parser_version: PARSER_VERSION });
  }
  await h.ch.insert(Table.Ledgers, rows);
}
