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
