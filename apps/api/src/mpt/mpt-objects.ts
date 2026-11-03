import { LSF_MPT_LOCKED, mptIssuerOf, MptTransferKind } from '@gatehub/data-api-shared';
import { CsvRow, csvSafeText, toCsvRow } from '../common/csv.interceptor';
import { fmtTime } from '../common/format';

/**
 * The objects of the MPT routes (spec 7), with the keys in the order the tasks pin (`*_KEYS`, `Object.keys` tests, and the "Keys of
 * …, in order:" lines of `docs/api-reference.md`). A key with no value is left out, and `null` is never served. Amounts are the
 * ledger's integer units, as exact strings beside the issuance ID, never scaled (ruling C25); counts are numbers.
 */

// -- the keys ------------------------------------------------------------------------------------------------------------

export const MPT_FLAGS_KEYS = [
  'locked',
  'can_lock',
  'require_auth',
  'can_escrow',
  'can_trade',
  'can_transfer',
  'can_clawback',
] as const;

export const MPT_ISSUANCE_BODY_KEYS = ['result', 'coverage', 'issuance'] as const;

export const MPT_ISSUANCE_KEYS = [
  'mpt_issuance_id',
  'issuer',
  'sequence',
  'ticker',
  'name',
  'asset_scale',
  'maximum_amount',
  'outstanding_amount',
  'escrowed_amount',
  'locked_amount',
  'locked_holders',
  'holders',
  'transfer_fee',
  'flags',
  'metadata',
  'metadata_hex',
  'metadata_conforms',
  'created_ledger',
  'created_time',
  'created_tx_hash',
  'last_ledger',
  'destroyed',
] as const;

export const MPT_LOOKUP_BODY_KEYS = ['result', 'count', 'issuances'] as const;

export const MPT_SUMMARY_KEYS = [
  'mpt_issuance_id',
  'issuer',
  'ticker',
  'name',
  'asset_scale',
  'maximum_amount',
  'outstanding_amount',
  'holders',
  'transfer_fee',
  'flags',
  'destroyed',
] as const;

export const MPT_HOLDERS_BODY_KEYS = ['result', 'coverage', 'count', 'marker', 'holders'] as const;

export const MPT_HOLDER_KEYS = ['holder', 'amount', 'escrowed_amount', 'locked', 'authorized'] as const;

export const MPT_TRANSFERS_BODY_KEYS = ['result', 'coverage', 'count', 'marker', 'transfers'] as const;

export const MPT_TRANSFER_KEYS = [
  'ledger_index',
  'tx_index',
  'tx_hash',
  'executed_time',
  'tx_type',
  'kind',
  'source',
  'destination',
  'amount',
  'fee',
] as const;

/** The kinds of a transfer, in the order the message of `kind` lists them. */
export const MPT_TRANSFER_KINDS: readonly MptTransferKind[] = [
  'payment',
  'clawback',
  'lock',
  'unlock',
  'escrow_create',
  'escrow_finish',
  'escrow_cancel',
];

export const MPT_TOKEN_ROW_KEYS = [
  'rank',
  'mpt_issuance_id',
  'issuer',
  'ticker',
  'name',
  'asset_scale',
  'maximum_amount',
  'outstanding_amount',
  'holders',
  'transfer_fee',
  'flags',
  'transfers_24h',
] as const;

export const MPT_TOKENS_TOTALS_KEYS = ['issuances', 'holders', 'transfers_24h'] as const;

/** The columns of the CSV of `kind=mpt`: the keys of a row, the flags flattened. A key with no value is an empty cell, not a moved column. */
export const MPT_TOKEN_CSV_COLUMNS = MPT_TOKEN_ROW_KEYS.flatMap((key) =>
  key === 'flags' ? MPT_FLAGS_KEYS.map((flag) => `flags.${flag}`) : [key],
);

export const ACCOUNT_MPT_BODY_KEYS = [
  'result',
  'coverage',
  'ledger_index',
  'close_time',
  'count',
  'marker',
  'mpt',
] as const;

export const ACCOUNT_MPT_KEYS = [
  'mpt_issuance_id',
  'issuer',
  'ticker',
  'name',
  'asset_scale',
  'amount',
  'escrowed_amount',
  'locked',
  'authorized',
] as const;

// -- the objects ---------------------------------------------------------------------------------------------------------

/** The flags of an issuance, the bits of its raw `UInt32` by name (spec 2). A new flag is a new key. */
export type MptFlagsObject = Record<(typeof MPT_FLAGS_KEYS)[number], boolean>;

/** The newest row of an issuance in `mpt_issuances`: its columns, each `UInt64` as its digits, the creation time as unix seconds. */
export interface StoredMptIssuance {
  mpt_issuance_id: string;
  issuer: string;
  sequence: number;
  state_known: number;
  flags: number;
  asset_scale: number;
  maximum_amount: string | null;
  outstanding_amount: string;
  escrowed_amount: string;
  locked_amount: string;
  locked_holders: number;
  holders: number;
  transfer_fee: number;
  metadata_hex: string;
  /** The decoded object as JSON, `''` when the hex is none. */
  metadata: string;
  metadata_conforms: number;
  ticker: string;
  name: string;
  created_ledger: number | null;
  created_time: number | null;
  created_tx_hash: string | null;
  last_ledger: number;
  destroyed: number;
}

export interface MptIssuanceObject {
  mpt_issuance_id: string;
  issuer: string;
  sequence: number;
  ticker?: string;
  name?: string;
  asset_scale: number;
  maximum_amount?: string;
  outstanding_amount: string;
  escrowed_amount: string;
  locked_amount: string;
  locked_holders: number;
  holders: number;
  transfer_fee: number;
  flags: MptFlagsObject;
  metadata?: unknown;
  metadata_hex?: string;
  metadata_conforms?: boolean;
  created_ledger?: number;
  created_time?: string;
  created_tx_hash?: string;
  last_ledger: number;
  destroyed: boolean;
}

export interface MptSummaryObject {
  mpt_issuance_id: string;
  issuer: string;
  ticker?: string;
  name?: string;
  asset_scale: number;
  maximum_amount?: string;
  outstanding_amount: string;
  holders: number;
  transfer_fee: number;
  flags: MptFlagsObject;
  destroyed: boolean;
}

/** A holder's balance as a list reads it: the newest row of `mpt_holders`, each `UInt64` as its digits. */
export interface StoredMptHolder {
  holder: string;
  amount_text: string;
  escrowed_text: string;
  flags: number;
}

export interface MptHolderObject {
  holder: string;
  amount: string;
  escrowed_amount: string;
  locked: boolean;
  authorized: boolean;
}

/** A row of `mpt_issuance_transfers` as the list reads it: each `UInt64` as its digits, the close time as unix seconds. */
export interface StoredMptTransfer {
  ledger_index: number;
  tx_index: number;
  tx_hash: string;
  close_unix: number;
  tx_type: string;
  kind: MptTransferKind;
  source: string;
  destination: string;
  amount_text: string;
  fee_text: string;
}

export interface MptTransferObject {
  ledger_index: number;
  tx_index: number;
  tx_hash: string;
  executed_time: string;
  tx_type: string;
  kind: MptTransferKind;
  source?: string;
  destination?: string;
  amount: string;
  fee?: string;
}

/** The named bits of an issuance's flags: `0x01` locked, then in the order of `MPT_FLAGS_KEYS`, up to `0x40` can_clawback. */
export function mptFlags(flags: number): MptFlagsObject {
  return Object.fromEntries(MPT_FLAGS_KEYS.map((key, bit) => [key, (flags & (1 << bit)) !== 0])) as MptFlagsObject;
}

/** The object of an issuance (spec 7.2). The `created_*` keys say whether its creation is in the coverage. */
export function toMptIssuance(row: StoredMptIssuance): MptIssuanceObject {
  return {
    mpt_issuance_id: row.mpt_issuance_id,
    issuer: row.issuer,
    sequence: row.sequence,
    ...(row.ticker !== '' && { ticker: row.ticker }),
    ...(row.name !== '' && { name: row.name }),
    asset_scale: row.asset_scale,
    ...(row.maximum_amount !== null && { maximum_amount: row.maximum_amount }),
    outstanding_amount: row.outstanding_amount,
    escrowed_amount: row.escrowed_amount,
    locked_amount: row.locked_amount,
    locked_holders: row.locked_holders,
    holders: row.holders,
    transfer_fee: row.transfer_fee,
    flags: mptFlags(row.flags),
    ...(row.metadata !== '' && { metadata: JSON.parse(row.metadata) as unknown }),
    ...(row.metadata_hex !== '' && {
      metadata_hex: row.metadata_hex,
      metadata_conforms: row.metadata_conforms !== 0,
    }),
    ...(row.created_ledger !== null && {
      created_ledger: row.created_ledger,
      ...(row.created_time !== null && { created_time: fmtTime(row.created_time) }),
      ...(row.created_tx_hash !== null && { created_tx_hash: row.created_tx_hash }),
    }),
    last_ledger: row.last_ledger,
    destroyed: row.destroyed !== 0,
  };
}

/** The summary of an issuance, an entry of `GET /v2/mpt?ids=` (spec 7.5). */
export function toMptSummary(row: StoredMptIssuance): MptSummaryObject {
  return {
    mpt_issuance_id: row.mpt_issuance_id,
    issuer: row.issuer,
    ...(row.ticker !== '' && { ticker: row.ticker }),
    ...(row.name !== '' && { name: row.name }),
    asset_scale: row.asset_scale,
    ...(row.maximum_amount !== null && { maximum_amount: row.maximum_amount }),
    outstanding_amount: row.outstanding_amount,
    holders: row.holders,
    transfer_fee: row.transfer_fee,
    flags: mptFlags(row.flags),
    destroyed: row.destroyed !== 0,
  };
}

/** A row of the list of `kind=mpt` as it is read: the newest row of an issuance with its place, each `UInt64` as its digits. */
export interface StoredMptTokenRow {
  rank: number;
  mpt_issuance_id: string;
  issuer: string;
  ticker: string;
  name: string;
  asset_scale: number;
  maximum_text: string | null;
  outstanding_text: string;
  holders: number;
  transfer_fee: number;
  flags: number;
}

/** A row of the list of `kind=mpt`, in the order of `MPT_TOKEN_ROW_KEYS`; a key with no value is left out. */
export type MptTokenRowObject = Record<(typeof MPT_TOKEN_ROW_KEYS)[number], unknown>;

/** The totals of the list of `kind=mpt`. */
export type MptTotalsObject = Record<(typeof MPT_TOKENS_TOTALS_KEYS)[number], number>;

/** A row of `kind=mpt` (spec 7.1) and how many payments its issuance had in the day before the head. */
export function toMptTokenRow(row: StoredMptTokenRow, transfers24h: number): MptTokenRowObject {
  return {
    rank: row.rank,
    mpt_issuance_id: row.mpt_issuance_id,
    issuer: row.issuer,
    ...(row.ticker !== '' && { ticker: row.ticker }),
    ...(row.name !== '' && { name: row.name }),
    asset_scale: row.asset_scale,
    ...(row.maximum_text !== null && { maximum_amount: row.maximum_text }),
    outstanding_amount: row.outstanding_text,
    holders: row.holders,
    transfer_fee: row.transfer_fee,
    flags: mptFlags(row.flags),
    transfers_24h: transfers24h,
  } as MptTokenRowObject;
}

/** A row as a row of a CSV, with `ticker` and `name`, which an issuer wrote, safe in a spreadsheet. */
function toIssuerTextCsvRow(row: object, columns: readonly string[]): CsvRow {
  const cells = toCsvRow(row, columns);
  for (const column of ['ticker', 'name']) {
    const text = cells[column];
    if (typeof text === 'string') cells[column] = csvSafeText(text);
  }
  return cells;
}

/** A row of `kind=mpt` as a row of the CSV. */
export function toMptTokenCsvRow(row: MptTokenRowObject): CsvRow {
  return toIssuerTextCsvRow(row, MPT_TOKEN_CSV_COLUMNS);
}

/** A holding as a row of the CSV. */
export function toAccountMptCsvRow(row: object): CsvRow {
  return toIssuerTextCsvRow(row, ACCOUNT_MPT_KEYS);
}

/** `lsfMPTAuthorized` of an `MPToken`, what `authorized` says. */
const LSF_MPT_AUTHORIZED = 0x02;

/** Whether a balance cannot move: the holder's own `lsfMPTLocked`, or the issuance's. */
export function mptBalanceLocked(holderFlags: number, issuanceFlags: number): boolean {
  return ((holderFlags | issuanceFlags) & LSF_MPT_LOCKED) !== 0;
}

/** Whether a holder has `lsfMPTAuthorized`, which means something when the issuance requires it. */
export function mptBalanceAuthorized(holderFlags: number): boolean {
  return (holderFlags & LSF_MPT_AUTHORIZED) !== 0;
}

/** A holder of an issuance (spec 7.3), with the raw flags of the issuance. */
export function toMptHolder(row: StoredMptHolder, issuanceFlags: number): MptHolderObject {
  return {
    holder: row.holder,
    amount: row.amount_text,
    escrowed_amount: row.escrowed_text,
    locked: mptBalanceLocked(row.flags, issuanceFlags),
    authorized: mptBalanceAuthorized(row.flags),
  };
}

/** A transfer of an issuance (spec 7.4): `source` and `destination` are left out when `''`, `fee` when 0. */
export function toMptTransfer(row: StoredMptTransfer): MptTransferObject {
  return {
    ledger_index: row.ledger_index,
    tx_index: row.tx_index,
    tx_hash: row.tx_hash,
    executed_time: fmtTime(row.close_unix),
    tx_type: row.tx_type,
    kind: row.kind,
    ...(row.source !== '' && { source: row.source }),
    ...(row.destination !== '' && { destination: row.destination }),
    amount: row.amount_text,
    ...(row.fee_text !== '0' && { fee: row.fee_text }),
  };
}

/** A holding as `/v2/accounts/{address}/mpt` reads it: the newest state of an account's token, each `UInt64` as its digits. */
export interface StoredAccountMpt {
  mpt_issuance_id: string;
  amount_text: string;
  escrowed_text: string;
  flags: number;
}

export interface AccountMptObject {
  mpt_issuance_id: string;
  issuer: string;
  ticker?: string;
  name?: string;
  asset_scale?: number;
  amount: string;
  escrowed_amount: string;
  locked: boolean;
  authorized: boolean;
}

/**
 * A holding of an account (spec 7.6). The issuer is the one the ID holds; `ticker`, `name` and `asset_scale` come from the issuance's
 * row when its state is known, and with no such row a holding has what the ledger's token said.
 */
export function toAccountMpt(row: StoredAccountMpt, issuance: StoredMptIssuance | undefined): AccountMptObject {
  const known = issuance !== undefined && issuance.state_known !== 0 ? issuance : undefined;
  return {
    mpt_issuance_id: row.mpt_issuance_id,
    issuer: mptIssuerOf(row.mpt_issuance_id),
    ...(known !== undefined && known.ticker !== '' && { ticker: known.ticker }),
    ...(known !== undefined && known.name !== '' && { name: known.name }),
    ...(known !== undefined && { asset_scale: known.asset_scale }),
    amount: row.amount_text,
    escrowed_amount: row.escrowed_text,
    locked: mptBalanceLocked(row.flags, issuance?.flags ?? 0),
    authorized: mptBalanceAuthorized(row.flags),
  };
}
