import { amendmentId, NetworkSupplyRow, PARSER_VERSION, Table } from '@gatehub/data-api-shared';
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
