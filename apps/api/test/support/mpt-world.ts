import {
  decodeMptMetadata,
  LedgersRow,
  MPT_PARSER_VERSION,
  MptHoldersRow,
  MptHolderStatesRow,
  mptIssuanceId,
  MptIssuancesRow,
  MptIssuanceTransfersRow,
  mptMetadataConforms,
  MptTransferKind,
  MptTransfersRow,
  Table,
} from '@gatehub/data-api-shared';
import type { Harness } from '../harness';
import { accountAt, hashOf, insertParts } from './amm';
import { readsOf } from './read-rows';
import { listAmendments } from './supply-seed';
import { ledgerRow } from './validators-seed';

/**
 * The world of the MPT suites (D9): the rows the ingest and the `mpt_state` job write, put in the tables directly, each table in
 * parts of its own with its merges stopped, as the job leaves them between merges.
 *
 * **The ledgers.** MPTokensV1's enable ledger (`ENABLE_LEDGER`, listed in the ledger state, so the coverage is complete), the ledgers
 * of the rows below and the three newest: `head - 2` closed at `headClose - 86400`, just outside the day before the head, `head - 1`
 * at `headClose - 86399`, just inside, and `head`. All are written by `MPT_PARSER_VERSION`. No ledger stands above the head, whose
 * rows are therefore those of a ledger still being written: one transfer and one holder state, which no read may serve.
 *
 * **The issuances**, one `issuer`, each with an older version in another part of `mpt_issuances`, whose numbers would show:
 *  - `htf`: metadata that conforms, a maximum, three holders (`HTF_HOLDERS`: one locked, one with an escrow), every kind of transfer;
 *  - `bare`: no metadata, no maximum, no creation in the coverage; the holders are the balances that test an order (`BARE_HOLDERS`:
 *    2^53 + 1 and 2^53, which a double cannot tell apart, 10 and 9, ties, one partly in escrow) and one with nothing;
 *  - `unknownState`: `state_known = 0`, with two holders, one of them no other issuance's (`holders[9]`), and two transfers;
 *  - `destroyed`: destroyed, and its one holder's token deleted;
 *  - `lockedAll`: `lsfMPTLocked`, two holders of which neither locked on its own, and a lock of every balance;
 *  - `escrow`: `escrowed_amount` above 0, its one holder's balance all in escrow;
 *  - `nowhere` has no row.
 *
 * **The holdings of `holders[0]`** (`mpt_holder_states`, what `/v2/accounts/{a}/mpt` reads): `htf`, `unknownState`, `lockedAll`, `bare`
 * emptied by its newest state, `destroyed` deleted by its newest; each older state another row, in another part.
 */

const at = (text: string): number => Date.parse(text) / 1000;

const HEAD = 107_795_512;
const HEAD_CLOSE = at('2026-10-24T14:20:01Z');
const ENABLE_LEDGER = 99_226_369;
const ISSUER = accountAt(0xa001);

/** The accounts of the world, for the balances. */
const HOLDERS = Array.from({ length: 10 }, (_, i) => accountAt(0xb001 + i));

const IDS = {
  htf: mptIssuanceId(298, ISSUER),
  bare: mptIssuanceId(299, ISSUER),
  unknownState: mptIssuanceId(300, ISSUER),
  destroyed: mptIssuanceId(301, ISSUER),
  lockedAll: mptIssuanceId(302, ISSUER),
  escrow: mptIssuanceId(303, ISSUER),
  nowhere: mptIssuanceId(304, ISSUER),
};

export const MPT_WORLD = {
  head: HEAD,
  headClose: HEAD_CLOSE,
  issuer: ISSUER,
  holders: HOLDERS,
  ids: IDS,
};

/** The flags of an issuance, the raw `UInt32`. */
const CAN_LOCK = 0x02;
const REQUIRE_AUTH = 0x04;
const CAN_ESCROW = 0x08;
const CAN_TRADE = 0x10;
const CAN_TRANSFER = 0x20;
const CAN_CLAWBACK = 0x40;
const LOCKED = 0x01;

/** The flags of a holder: `lsfMPTLocked`, `lsfMPTAuthorized`. */
const HOLDER_LOCKED = 0x01;
const HOLDER_AUTHORIZED = 0x02;

/** The metadata of `htf`, as the issuer wrote it: XLS-89's long keys. */
export const HTF_METADATA = {
  ticker: 'HTF',
  name: 'Harborline Treasury Fund',
  desc: 'A tokenized treasury fund.',
  icon: 'harborline.example/htf/icon.png',
  asset_class: 'rwa',
  asset_subclass: 'treasury',
  issuer_name: 'Harborline Capital',
  uris: [{ uri: 'harborline.example/htf', category: 'website', title: 'Fund page' }],
};
const HTF_HEX = Buffer.from(JSON.stringify(HTF_METADATA), 'utf8').toString('hex').toUpperCase();

/** Where a holder stands in the lists of `htf`: `[holder, amount, escrowed, flags]`, the largest balance first. */
export const HTF_HOLDERS: readonly [string, string, string, number][] = [
  [HOLDERS[2], '1000000000', '84411120', HOLDER_AUTHORIZED],
  [HOLDERS[0], '612040000', '0', HOLDER_AUTHORIZED],
  [HOLDERS[1], '124000000', '0', HOLDER_LOCKED | HOLDER_AUTHORIZED],
];

/** The close time of each ledger of the world (`seedMptWorld` writes a row for each). */
const CLOSES = new Map<number, number>([
  [ENABLE_LEDGER, at('2025-10-01T12:00:00Z')],
  [99_412_004, at('2025-10-09T11:20:31Z')],
  ...Array.from({ length: 12 }, (_, i): [number, number] => [107_000_001 + i, at('2026-09-01T00:00:00Z') + i * 86_400]),
  [HEAD - 2, HEAD_CLOSE - 86_400],
  [HEAD - 1, HEAD_CLOSE - 86_399],
  [HEAD, HEAD_CLOSE],
]);

/** The close time of a ledger of the world; a ledger above the head closes a few seconds after it. */
export const closeOfMpt = (ledger: number): number => CLOSES.get(ledger) ?? HEAD_CLOSE + (ledger - HEAD) * 4;

/** A row of `mpt_issuances`: an empty, known, live issuance of the world's issuer. `sequence` is the ID's. */
export function mptIssuanceRow(id: string, fields: Partial<MptIssuancesRow> = {}): MptIssuancesRow {
  return {
    mpt_issuance_id: id,
    issuer: ISSUER,
    sequence: Number.parseInt(id.slice(0, 8), 16),
    state_known: 1,
    flags: 0,
    asset_scale: 0,
    maximum_amount: null,
    outstanding_amount: '0',
    escrowed_amount: '0',
    locked_amount: '0',
    locked_holders: 0,
    holders: 0,
    transfer_fee: 0,
    metadata_hex: '',
    metadata: '',
    metadata_conforms: 0,
    ticker: '',
    name: '',
    created_ledger: null,
    created_time: null,
    created_tx_hash: null,
    last_ledger: HEAD,
    destroyed: 0,
    version: '200',
    ...fields,
  };
}

/** A row of `mpt_holders`. */
export function mptHolderRow(
  id: string,
  holder: string,
  amount: string,
  fields: Partial<MptHoldersRow> = {},
): MptHoldersRow {
  return {
    mpt_issuance_id: id,
    holder,
    amount,
    escrowed_amount: '0',
    flags: 0,
    last_ledger: HEAD,
    deleted: 0,
    version: '200',
    ...fields,
  };
}

/** A row of `mpt_holder_states`. */
export function mptHolderStateRow(
  holder: string,
  id: string,
  ledger: number,
  amount: string,
  fields: Partial<MptHolderStatesRow> = {},
): MptHolderStatesRow {
  return {
    holder,
    mpt_issuance_id: id,
    ledger_index: ledger,
    tx_index: 1,
    node_index: 0,
    tx_hash: hashOf(ledger),
    tx_type: 'Payment',
    close_time: closeOfMpt(ledger),
    amount,
    escrowed_amount: '0',
    flags: 0,
    deleted: 0,
    ...fields,
  };
}

/** The type of the transaction each kind of transfer comes from. */
const KIND_TYPES: Record<MptTransferKind, string> = {
  payment: 'Payment',
  clawback: 'Clawback',
  lock: 'MPTokenIssuanceSet',
  unlock: 'MPTokenIssuanceSet',
  escrow_create: 'EscrowCreate',
  escrow_finish: 'EscrowFinish',
  escrow_cancel: 'EscrowCancel',
};

/** A transfer, as `mpt_transfers` and `mpt_issuance_transfers` hold it (the columns are the same). */
export function mptTransferRow(
  id: string,
  ledger: number,
  tx: number,
  kind: MptTransferKind,
  source: string,
  destination: string,
  amount: string,
  fee = '0',
): MptTransfersRow & MptIssuanceTransfersRow {
  return {
    mpt_issuance_id: id,
    ledger_index: ledger,
    tx_index: tx,
    tx_hash: hashOf(ledger * 1000 + tx),
    tx_type: KIND_TYPES[kind],
    close_time: closeOfMpt(ledger),
    kind,
    source,
    destination,
    amount,
    fee,
  };
}

/** The newest row of each issuance. */
export const MPT_ISSUANCES: readonly MptIssuancesRow[] = [
  mptIssuanceRow(IDS.htf, {
    flags: CAN_LOCK | REQUIRE_AUTH | CAN_TRADE | CAN_TRANSFER | CAN_CLAWBACK,
    asset_scale: 2,
    maximum_amount: '5000000000',
    outstanding_amount: '1820451120',
    escrowed_amount: '84411120',
    locked_amount: '124000000',
    locked_holders: 1,
    holders: 3,
    transfer_fee: 100,
    metadata_hex: HTF_HEX,
    metadata: JSON.stringify(decodeMptMetadata(HTF_HEX)),
    metadata_conforms: mptMetadataConforms(decodeMptMetadata(HTF_HEX)!) ? 1 : 0,
    ticker: 'HTF',
    name: 'Harborline Treasury Fund',
    created_ledger: 99_412_004,
    created_time: closeOfMpt(99_412_004),
    created_tx_hash: hashOf(99_412_004),
  }),
  mptIssuanceRow(IDS.bare, { outstanding_amount: '18014398509482023', holders: 6 }),
  mptIssuanceRow(IDS.unknownState, { state_known: 0, holders: 2, last_ledger: 107_000_012 }),
  mptIssuanceRow(IDS.destroyed, { destroyed: 1, last_ledger: 107_000_009 }),
  mptIssuanceRow(IDS.lockedAll, {
    flags: LOCKED | CAN_LOCK,
    asset_scale: 6,
    outstanding_amount: '1300',
    locked_amount: '1300',
    locked_holders: 2,
    holders: 2,
  }),
  mptIssuanceRow(IDS.escrow, {
    flags: CAN_ESCROW | CAN_TRANSFER,
    outstanding_amount: '700',
    escrowed_amount: '700',
    holders: 1,
  }),
];

/** The balances of `bare`: `[holder, amount, escrowed]`. `holders[0]` has nothing left. */
export const BARE_HOLDERS: readonly [string, string, string][] = [
  [HOLDERS[3], '9007199254740993', '0'],
  [HOLDERS[8], '9007199254740992', '0'],
  [HOLDERS[4], '10', '0'],
  [HOLDERS[5], '4', '6'],
  [HOLDERS[6], '9', '0'],
  [HOLDERS[7], '9', '0'],
  [HOLDERS[0], '0', '0'],
];

/** The newest row of each holder. */
export const MPT_HOLDERS: readonly MptHoldersRow[] = [
  ...HTF_HOLDERS.map(([holder, amount, escrowed, flags]) =>
    mptHolderRow(IDS.htf, holder, amount, { escrowed_amount: escrowed, flags }),
  ),
  ...BARE_HOLDERS.map(([holder, amount, escrowed]) =>
    mptHolderRow(IDS.bare, holder, amount, { escrowed_amount: escrowed }),
  ),
  mptHolderRow(IDS.unknownState, HOLDERS[0], '500', { flags: HOLDER_AUTHORIZED }),
  mptHolderRow(IDS.unknownState, HOLDERS[9], '300'),
  mptHolderRow(IDS.destroyed, HOLDERS[0], '0', { deleted: 1 }),
  mptHolderRow(IDS.lockedAll, HOLDERS[0], '1000', { flags: HOLDER_AUTHORIZED }),
  mptHolderRow(IDS.lockedAll, HOLDERS[1], '300'),
  mptHolderRow(IDS.escrow, HOLDERS[1], '0', { escrowed_amount: '700' }),
];

/** Every transfer of the world, in ledger order. The last is above the head. */
export const MPT_TRANSFERS: readonly (MptTransfersRow & MptIssuanceTransfersRow)[] = [
  mptTransferRow(IDS.htf, 107_000_001, 3, 'payment', ISSUER, HOLDERS[0], '1000000000'),
  mptTransferRow(IDS.htf, 107_000_002, 1, 'payment', HOLDERS[1], HOLDERS[2], '2500000', '2500'),
  mptTransferRow(IDS.htf, 107_000_003, 7, 'clawback', HOLDERS[1], ISSUER, '1000'),
  mptTransferRow(IDS.htf, 107_000_004, 2, 'lock', ISSUER, HOLDERS[1], '124000000'),
  mptTransferRow(IDS.htf, 107_000_005, 2, 'unlock', ISSUER, HOLDERS[1], '124000000'),
  mptTransferRow(IDS.htf, 107_000_006, 4, 'escrow_create', HOLDERS[2], HOLDERS[0], '84411120'),
  mptTransferRow(IDS.htf, 107_000_007, 9, 'escrow_finish', HOLDERS[2], HOLDERS[0], '1000', '1'),
  mptTransferRow(IDS.htf, 107_000_008, 0, 'escrow_cancel', HOLDERS[2], HOLDERS[2], '2000'),
  mptTransferRow(IDS.htf, 107_000_008, 5, 'payment', HOLDERS[0], ISSUER, '3000'),
  mptTransferRow(IDS.lockedAll, 107_000_010, 1, 'lock', ISSUER, '', '1300'),
  mptTransferRow(IDS.unknownState, 107_000_011, 1, 'payment', HOLDERS[9], HOLDERS[0], '500'),
  mptTransferRow(IDS.unknownState, 107_000_012, 1, 'payment', HOLDERS[0], HOLDERS[9], '300'),
  mptTransferRow(IDS.htf, HEAD - 2, 0, 'payment', HOLDERS[0], HOLDERS[1], '1'),
  mptTransferRow(IDS.htf, HEAD - 1, 0, 'payment', HOLDERS[0], HOLDERS[1], '2'),
  mptTransferRow(IDS.htf, HEAD - 1, 1, 'lock', ISSUER, HOLDERS[1], '124000000'),
  mptTransferRow(IDS.htf, HEAD, 0, 'payment', HOLDERS[1], HOLDERS[0], '3'),
  mptTransferRow(IDS.bare, HEAD, 2, 'payment', HOLDERS[3], HOLDERS[4], '4'),
  mptTransferRow(IDS.htf, HEAD + 1, 0, 'payment', HOLDERS[0], HOLDERS[1], '5'),
];

/** The holdings of `holders[0]`: the state of each, newest last; the last one is above the head. */
export const MPT_HOLDER_STATES: readonly MptHolderStatesRow[] = [
  mptHolderStateRow(HOLDERS[0], IDS.htf, 107_000_001, '1000000000', { flags: HOLDER_AUTHORIZED }),
  mptHolderStateRow(HOLDERS[0], IDS.htf, HEAD, '612040000', { flags: HOLDER_AUTHORIZED }),
  mptHolderStateRow(HOLDERS[0], IDS.unknownState, 107_000_012, '500', { flags: HOLDER_AUTHORIZED }),
  mptHolderStateRow(HOLDERS[0], IDS.lockedAll, 107_000_010, '1000', { flags: HOLDER_AUTHORIZED }),
  mptHolderStateRow(HOLDERS[0], IDS.bare, 107_000_002, '7'),
  mptHolderStateRow(HOLDERS[0], IDS.bare, 107_000_003, '0'),
  mptHolderStateRow(HOLDERS[0], IDS.destroyed, 107_000_004, '5'),
  mptHolderStateRow(HOLDERS[0], IDS.destroyed, 107_000_005, '0', { deleted: 1 }),
  mptHolderStateRow(HOLDERS[0], IDS.htf, HEAD + 1, '1', { flags: HOLDER_AUTHORIZED }),
];

/** The older rows of the aggregates: numbers a read that takes any row but the newest would serve. */
const OLDER_ISSUANCES: readonly MptIssuancesRow[] = [
  mptIssuanceRow(IDS.htf, { outstanding_amount: '1', holders: 900, ticker: 'OLD', version: '100' }),
  mptIssuanceRow(IDS.bare, { outstanding_amount: '1', holders: 900, version: '100' }),
  mptIssuanceRow(IDS.unknownState, { holders: 900, version: '100' }),
  mptIssuanceRow(IDS.destroyed, { holders: 900, version: '100' }),
  mptIssuanceRow(IDS.lockedAll, { holders: 900, version: '100' }),
];
const OLDER_HOLDERS: readonly MptHoldersRow[] = [
  mptHolderRow(IDS.htf, HOLDERS[1], '9999999999', { version: '100' }),
  mptHolderRow(IDS.htf, HOLDERS[3], '8888888888', { version: '100' }),
  mptHolderRow(IDS.bare, HOLDERS[0], '7', { version: '100' }),
];
/** `holders[3]` held `htf` once: its newest row says the token is gone, whatever the older one held. */
const DELETED_HOLDERS: readonly MptHoldersRow[] = [mptHolderRow(IDS.htf, HOLDERS[3], '0', { deleted: 1 })];

/** What a ledger of the world is. */
const ledgerOf = (ledger: number, close: number): LedgersRow => ({
  ...ledgerRow(ledger, close),
  parser_version: MPT_PARSER_VERSION,
});

/** Writes the world. Merges of the tables stay stopped (the harness drops the database). */
export async function seedMptWorld(h: Harness): Promise<void> {
  const tables = [
    Table.MptIssuances,
    Table.MptHolders,
    Table.MptHolderStates,
    Table.MptTransfers,
    Table.MptIssuanceTransfers,
  ];
  for (const table of tables) await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${table}`);
  await h.ch.insert(
    Table.Ledgers,
    [...CLOSES.entries()].map(([ledger, close]) => ledgerOf(ledger, close)),
  );
  await listAmendments(h, ['MPTokensV1'], HEAD);
  await insertParts(h, Table.MptIssuances, [...OLDER_ISSUANCES], [...MPT_ISSUANCES]);
  await insertParts(h, Table.MptHolders, [...OLDER_HOLDERS], [...MPT_HOLDERS, ...DELETED_HOLDERS]);
  await insertParts(
    h,
    Table.MptHolderStates,
    MPT_HOLDER_STATES.filter((_, i) => i % 2 === 0),
    MPT_HOLDER_STATES.filter((_, i) => i % 2 === 1),
  );
  // the rows of `htf` are there twice, in a part of their own, as a ledger written twice leaves them until a merge
  const again = MPT_TRANSFERS.filter((row) => row.mpt_issuance_id === IDS.htf);
  await insertParts(h, Table.MptTransfers, [...MPT_TRANSFERS], again);
  await insertParts(h, Table.MptIssuanceTransfers, [...MPT_TRANSFERS], again);
}

/** The seven MPT tables, which a route reads none of on a network without MPT. */
const MPT_TABLES = [
  Table.MptIssuanceStates,
  Table.MptHolderStates,
  Table.MptTouches,
  Table.MptTransfers,
  Table.MptIssuanceTransfers,
  Table.MptIssuances,
  Table.MptHolders,
];

/** Runs `request` once, inside the window of a `readsOf` of each MPT table, and expects no read of any of them. */
export async function expectNoMptRead(h: Harness, request: () => Promise<unknown>): Promise<void> {
  const reads = new Map<Table, unknown>();
  const run = MPT_TABLES.reduce<() => Promise<unknown>>(
    (inner, table) => async () => reads.set(table, await readsOf(h, table, inner)),
    request,
  );
  await run();
  expect(MPT_TABLES.map((table) => [table, reads.get(table)])).toEqual(MPT_TABLES.map((table) => [table, []]));
}
