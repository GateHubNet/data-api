import { MptTransferKind } from '../clickhouse/rows';
import { isMptIssuanceId, mptIssuerOf } from '../util/mpt';
import {
  MptDeltas,
  mptAmountIssuance,
  mptDeltas,
  mptEscrowOf,
  mptPaymentIssuance,
  mptUInt,
  mptUnits,
} from './mpt-deltas';
import { ParseContext, ParserTx } from './parser.interface';
import { deliveredAmount, mptPartialDelivered } from './payment.parser';

/** The state of an issuance after a transaction that changed its node, whatever the result. Amounts are integer units. */
export interface ParsedMptIssuanceState {
  mpt_issuance_id: string;
  node_index: number;
  issuer: string;
  sequence: number;
  flags: number;
  asset_scale: number;
  /** `null` when not set. */
  maximum_amount: string | null;
  outstanding_amount: string;
  /** The node's `LockedAmount`. */
  escrowed_amount: string;
  transfer_fee: number;
  /** In upper case; `''` when none. */
  metadata_hex: string;
  deleted: boolean;
}

/** The state of a holder's balance after a transaction that changed its node, whatever the result. */
export interface ParsedMptHolderState {
  holder: string;
  mpt_issuance_id: string;
  node_index: number;
  /** `MPTAmount`. */
  amount: string;
  /** The token's `LockedAmount`. */
  escrowed_amount: string;
  flags: number;
  deleted: boolean;
}

/** What a successful transaction moved, clawed back, locked or unlocked. */
export interface ParsedMptTransfer {
  mpt_issuance_id: string;
  kind: MptTransferKind;
  /** `''` when none. */
  source: string;
  /** `''` when none: a lock of every balance has no destination. */
  destination: string;
  amount: string;
  /** The transfer fee burned. */
  fee: string;
}

export interface ParsedMpt {
  issuanceStates: ParsedMptIssuanceState[];
  holderStates: ParsedMptHolderState[];
  transfers: ParsedMptTransfer[];
  /** What could not be read and a ledger cannot hold, read as a default or skipped (`mptDeltas`), which the build counts. */
  anomalies: number;
}

/** `tfMPTLock` and `tfMPTUnlock` of an `MPTokenIssuanceSet`. */
export const TF_MPT_LOCK = 0x01;
export const TF_MPT_UNLOCK = 0x02;
/** `lsfMPTLocked` of an `MPToken` and of an `MPTokenIssuance`. */
export const LSF_MPT_LOCKED = 0x01;

const UINT8_MAX = 0xff;
const UINT16_MAX = 0xffff;

const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A bigint as a `UInt64` column takes it: never below 0. */
const nonNegative = (value: bigint): bigint => (value < 0n ? 0n : value);

/** A transfer without its issuance. */
type Transfer = Omit<ParsedMptTransfer, 'mpt_issuance_id'>;

export class MptParser {
  /**
   * The issuance and holder states of a transaction, whatever its result (a node `mptDeltas` lists gives one row), and its transfer,
   * for a `tesSUCCESS` (at most one per transaction: spec 4.2):
   * - `payment`: what was delivered (`deliveredAmount`, or `Amount` when that is `'unavailable'`), and as `fee` the sender's fall of
   *   `MPTAmount` less that amount, when the sender is not the issuer. The fee is on top of `Amount` (FINDINGS (6));
   * - `clawback`: the holder's fall of `MPTAmount`, what was taken, which can be less than asked;
   * - `lock` and `unlock`: the holder's `MPTAmount` after it, or the issuance's `OutstandingAmount`, each 0 when its node is not in
   *   the metadata. The flags are a bit test, since an inner transaction of a Batch has `tfInnerBatchTxn` set too (FINDINGS (10));
   * - `escrow_create`: the transaction's `Amount`;
   * - `escrow_finish`: the deleted `Escrow` node's parties and `Amount`, and as `fee` that amount less the destination's rise, when its
   *   `MPToken` node is in the metadata (the issuer holds none). The fee comes out of the locked amount (FINDINGS (7));
   * - `escrow_cancel`: the same node's `Account` as both ends, and its `Amount`.
   *
   * Never throws, since a throw halts the live runner: what cannot be read is a default, counted in `anomalies`, and an ID that is
   * not 48 hex digits gives no transfer. Pure: nothing in `t` is modified, and the result shares no objects with it.
   */
  parse(t: ParserTx, ctx: ParseContext): ParsedMpt {
    const deltas = mptDeltas(t.tx, t.meta);
    const parsed: ParsedMpt = { issuanceStates: [], holderStates: [], transfers: [], anomalies: deltas.anomalies };

    for (const issuance of deltas.issuances) {
      parsed.issuanceStates.push({
        mpt_issuance_id: issuance.mpt_issuance_id,
        node_index: issuance.node_index,
        issuer: issuance.issuer,
        sequence: issuance.sequence,
        flags: this.uint(parsed, issuance.fields.Flags, undefined),
        asset_scale: this.uint(parsed, issuance.fields.AssetScale, UINT8_MAX),
        maximum_amount: this.maximum(parsed, issuance.fields.MaximumAmount),
        outstanding_amount: String(issuance.outstanding_after),
        escrowed_amount: String(issuance.escrowed_after),
        transfer_fee: this.uint(parsed, issuance.fields.TransferFee, UINT16_MAX),
        metadata_hex: this.metadata(parsed, issuance.fields.MPTokenMetadata),
        deleted: issuance.action === 'deleted',
      });
    }
    for (const holder of deltas.holders) {
      parsed.holderStates.push({
        holder: holder.holder,
        mpt_issuance_id: holder.mpt_issuance_id,
        node_index: holder.node_index,
        amount: String(holder.amount_after),
        escrowed_amount: String(holder.escrowed_after),
        flags: holder.flags,
        deleted: holder.action === 'deleted',
      });
    }
    if (t.meta.TransactionResult === 'tesSUCCESS') {
      const transfer = this.transfer(t, ctx, deltas, parsed);
      if (transfer !== undefined) parsed.transfers.push(transfer);
    }
    return parsed;
  }

  private transfer(
    t: ParserTx,
    ctx: ParseContext,
    deltas: MptDeltas,
    parsed: ParsedMpt,
  ): ParsedMptTransfer | undefined {
    const { tx, meta } = t;
    const holderOf = (holder: unknown, id: string) =>
      deltas.holders.find((h) => h.holder === holder && h.mpt_issuance_id === id);

    let id: string | undefined;
    let transfer: Transfer | undefined;
    switch (tx.TransactionType) {
      case 'Payment': {
        id = mptPaymentIssuance(tx, meta);
        if (id === undefined) return undefined;
        const delivered = deliveredAmount(tx, meta, t.ledger_index, ctx) as { value?: unknown } | undefined | string;
        const amount =
          mptPartialDelivered(tx, meta, id, deltas) ??
          this.value(
            parsed,
            (typeof delivered === 'object' && delivered !== null ? delivered : (tx.Amount ?? tx.DeliverMax)).value,
          );
        const sender = holderOf(tx.Account, id);
        const fall = sender === undefined ? 0n : sender.amount_before - sender.amount_after;
        transfer = {
          kind: 'payment',
          source: stringOf(tx.Account),
          destination: stringOf(tx.Destination),
          amount: String(amount),
          // The issuer holds no MPToken, so a mint has no sender here; a redemption is charged no fee (FINDINGS (6)).
          fee: String(tx.Account === mptIssuerOf(id) ? 0n : nonNegative(fall - amount)),
        };
        break;
      }
      case 'Clawback': {
        id = mptAmountIssuance(tx.Amount);
        if (id === undefined) return undefined;
        const holder = holderOf(tx.Holder, id);
        transfer = {
          kind: 'clawback',
          source: stringOf(tx.Holder),
          destination: stringOf(tx.Account),
          amount: String(holder === undefined ? 0n : nonNegative(holder.amount_before - holder.amount_after)),
          fee: '0',
        };
        break;
      }
      case 'MPTokenIssuanceSet': {
        const flags = Number(tx.Flags ?? 0);
        const kind: MptTransferKind | undefined =
          (flags & TF_MPT_LOCK) !== 0 ? 'lock' : (flags & TF_MPT_UNLOCK) !== 0 ? 'unlock' : undefined;
        if (kind === undefined || !isMptIssuanceId(tx.MPTokenIssuanceID)) return undefined;
        id = (tx.MPTokenIssuanceID as string).toUpperCase();
        const after =
          tx.Holder !== undefined
            ? holderOf(tx.Holder, id)?.amount_after
            : deltas.issuances.find((i) => i.mpt_issuance_id === id)?.outstanding_after;
        transfer = {
          kind,
          source: stringOf(tx.Account),
          destination: stringOf(tx.Holder),
          amount: String(after ?? 0n),
          fee: '0',
        };
        break;
      }
      case 'EscrowCreate': {
        id = mptAmountIssuance(tx.Amount);
        if (id === undefined) return undefined;
        transfer = {
          kind: 'escrow_create',
          source: stringOf(tx.Account),
          destination: stringOf(tx.Destination),
          amount: String(this.value(parsed, tx.Amount.value)),
          fee: '0',
        };
        break;
      }
      case 'EscrowFinish': {
        const escrow = mptEscrowOf(meta);
        if (escrow === undefined) return undefined;
        id = escrow.mpt_issuance_id;
        const amount = this.value(parsed, escrow.value);
        const destination = holderOf(escrow.destination, id);
        const rise = destination === undefined ? amount : destination.amount_after - destination.amount_before;
        transfer = {
          kind: 'escrow_finish',
          source: escrow.account,
          destination: escrow.destination,
          amount: String(amount),
          fee: String(nonNegative(amount - rise)),
        };
        break;
      }
      case 'EscrowCancel': {
        const escrow = mptEscrowOf(meta);
        if (escrow === undefined) return undefined;
        id = escrow.mpt_issuance_id;
        transfer = {
          kind: 'escrow_cancel',
          source: escrow.account,
          destination: escrow.account,
          amount: String(this.value(parsed, escrow.value)),
          fee: '0',
        };
        break;
      }
      default:
        return undefined;
    }
    return { mpt_issuance_id: id, ...transfer };
  }

  /** The units of an amount, 0 and counted when it is not a `UInt64`. */
  private value(parsed: ParsedMpt, value: unknown): bigint {
    const units = mptUnits(value);
    if (units === undefined) parsed.anomalies += 1;
    return units ?? 0n;
  }

  /** An integer field of a node; absent is 0, and anything but an integer of at most `max` is 0 and counted. */
  private uint(parsed: ParsedMpt, value: unknown, max: number | undefined): number {
    if (value === undefined) return 0;
    const read = mptUInt(value, max);
    if (read === undefined) parsed.anomalies += 1;
    return read ?? 0;
  }

  /** `MaximumAmount`; absent is `null`, and so is anything but a `UInt64`, counted. */
  private maximum(parsed: ParsedMpt, value: unknown): string | null {
    if (value === undefined) return null;
    const units = mptUnits(value);
    if (units === undefined) parsed.anomalies += 1;
    return units === undefined ? null : String(units);
  }

  /** `MPTokenMetadata` in upper case; absent is `''`, and so is anything but a string, counted. */
  private metadata(parsed: ParsedMpt, value: unknown): string {
    if (value === undefined) return '';
    if (typeof value !== 'string') parsed.anomalies += 1;
    return typeof value === 'string' ? value.toUpperCase() : '';
  }
}
