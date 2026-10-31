/**
 * `MptParser` over the recorded MPT cases of `test/fixtures/xrpl/mpt` and `test/fixtures/xrpl-testnet/mpt`, deep-frozen, and over the
 * synthetic cases below, each a small, named edit of a recorded transaction, for what FINDINGS.md says no transaction read shows:
 *
 * - `clawback_took_less`: `clawback_partial` with the holder's `MPTAmount` and the issuance's `OutstandingAmount` falling by 500000,
 *   half of `Amount` (taken equals `Amount` on all 46 clawbacks read).
 * - `payment_partial_delivered`: `payment_holder_to_holder` as a partial payment: `tfPartialPayment` set, the amounts of the nodes
 *   moved by 40000 instead of 100000, and `DeliveredAmount` and `delivered_amount` 40000 (no partial MPT payment was read).
 * - `payment_fee_after_fix`: `payment_transfer_fee` as of a ledger after fixMPTDeliveredAmount (the two fee payments read are before it).
 * - `escrow_finish_to_issuer`: `escrow_finish` with the escrow's `Destination` the issuer: the destination's `MPToken` goes (the
 *   issuer holds none), and `OutstandingAmount` falls by the amount (none of the 69 finishes read does this).
 * - `lock_inside_batch`, `unlock_inside_batch`: `issuance_set_lock_holder` and `issuance_set_unlock_holder` with `tfInnerBatchTxn`
 *   also set, as `E07F200F…` (ledger 107785580, not recorded) has it.
 * - `set_without_flag`: `issuance_set_lock_holder` with `Flags` 0, or only `tfInnerBatchTxn` (92A7A0B4…, not recorded, has no flag).
 * - `lock_holder_no_node`: `issuance_set_lock_holder` without its `MPToken` node, as a lock of a balance already locked changes nothing.
 * - `lock_all_no_node`: `issuance_set_lock_all` without its `MPTokenIssuance` node, the same.
 * - `failed_lock`: `issuance_set_lock_holder` with a `tec` result.
 * - `short_id_*`: `payment_mint`, `clawback_full` and `issuance_set_lock_holder` with an ID that is not 48 hex digits in the transaction.
 * - `mixed_*`: `payment_transfer_fee` with `SendMax` native or `Amount` native, which needs MPTokensV2.
 * - `bad_value_*`: `escrow_create` and `payment_mint` with an amount that is not digits.
 * - `bad_scale`: `issuance_create` with `AssetScale` and `TransferFee` that are not the column's type.
 */
import {
  editedMptCase,
  everyMptTransaction,
  mptCase,
  mptCaseContext,
  mptCaseNames,
  mptContext,
  mptNode,
} from '../test-utils/mpt-cases';
import { decodeMptIssuanceId, mptIssuerOf } from '../util/mpt';
import { LSF_MPT_LOCKED, MptParser, ParsedMpt, TF_MPT_LOCK, TF_MPT_UNLOCK } from './mpt.parser';
import { ParserTx } from './parser.interface';

const parser = new MptParser();
const XRPL = mptContext('xrpl');
const parsed = (name: string): ParsedMpt => parser.parse(mptCase(name), mptCaseContext(name));
const TF_INNER_BATCH_TXN = 0x40000000;
const parseAt = (t: ParserTx): ParsedMpt => parser.parse(t, XRPL);

describe('MptParser: states', () => {
  it('has the constants of the ledger', () => {
    expect([TF_MPT_LOCK, TF_MPT_UNLOCK, LSF_MPT_LOCKED]).toEqual([1, 2, 1]);
  });

  it('issuance_create: one issuance state with the ID the node gave, its metadata and no transfer', () => {
    const t = mptCase('issuance_create');
    expect(parsed('issuance_create')).toEqual({
      issuanceStates: [
        {
          mpt_issuance_id: t.meta.mpt_issuance_id,
          node_index: expect.any(Number),
          issuer: t.tx.Account,
          sequence: 66652146,
          flags: 126,
          asset_scale: 4,
          maximum_amount: '1000000000000',
          outstanding_amount: '0',
          escrowed_amount: '0',
          transfer_fee: 192,
          metadata_hex: t.tx.MPTokenMetadata,
          deleted: false,
        },
      ],
      holderStates: [],
      transfers: [],
      anomalies: 0,
    });
  });

  it('issuance_create_no_max: no MaximumAmount is null, and the defaults left out of NewFields are 0', () => {
    const [state] = parsed('issuance_create_no_max').issuanceStates;
    expect(state.maximum_amount).toBeNull();
    expect(state).toMatchObject({ outstanding_amount: '0', escrowed_amount: '0', transfer_fee: 0, asset_scale: 2 });
  });

  it('keeps MaximumAmount when the node says 2^63-1', () => {
    expect(parsed('escrow_create_transfer_fee').issuanceStates[0].maximum_amount).toBe('9223372036854775807');
  });

  it("metadata_hex is '' when the node has none, and upper case otherwise", () => {
    const none = editedMptCase('issuance_create', (_tx, meta) => {
      delete mptNode(meta, 'MPTokenIssuance').NewFields.MPTokenMetadata;
    });
    expect(parseAt(none).issuanceStates[0].metadata_hex).toBe('');
    const lower = editedMptCase('issuance_create', (_tx, meta) => {
      mptNode(meta, 'MPTokenIssuance').NewFields.MPTokenMetadata = 'abcd';
    });
    expect(parseAt(lower).issuanceStates[0].metadata_hex).toBe('ABCD');
  });

  it('issuance_destroy: deleted, with the ID from the node although the transaction used a ticket', () => {
    const t = mptCase('issuance_destroy');
    expect(parsed('issuance_destroy').issuanceStates).toEqual([
      expect.objectContaining({
        mpt_issuance_id: t.tx.MPTokenIssuanceID,
        sequence: 105785146,
        outstanding_amount: '0',
        deleted: true,
      }),
    ]);
    expect(parsed('issuance_destroy').transfers).toEqual([]);
  });

  it('authorize_holder: a holder state with nothing on it, and no transfer', () => {
    const t = mptCase('authorize_holder');
    expect(parsed('authorize_holder')).toEqual({
      issuanceStates: [],
      holderStates: [
        {
          holder: t.tx.Account,
          mpt_issuance_id: t.tx.MPTokenIssuanceID,
          node_index: expect.any(Number),
          amount: '0',
          escrowed_amount: '0',
          flags: 0,
          deleted: false,
        },
      ],
      transfers: [],
      anomalies: 0,
    });
  });

  it('authorize_by_issuer: the flags the issuer set, and no transfer', () => {
    const { holderStates, transfers } = parsed('authorize_by_issuer');
    expect(holderStates[0].flags).toBe(2);
    expect(transfers).toEqual([]);
  });

  it('unauthorize_holder: deleted', () => {
    expect(parsed('unauthorize_holder').holderStates[0]).toMatchObject({ deleted: true, amount: '0', flags: 2 });
    expect(parsed('unauthorize_holder').transfers).toEqual([]);
  });

  it('a state of the amounts after the transaction: an escrow on the holder and on the issuance', () => {
    const t = mptCase('escrow_create');
    const { holderStates, issuanceStates } = parsed('escrow_create');
    expect(holderStates).toEqual([
      expect.objectContaining({ holder: t.tx.Account, amount: '677146', escrowed_amount: '277073' }),
    ]);
    expect(issuanceStates).toEqual([
      expect.objectContaining({ outstanding_amount: '954219', escrowed_amount: '277073' }),
    ]);
  });

  it('escrow_finish_creates_token: a created token with its amount', () => {
    const t = mptCase('escrow_finish_creates_token');
    const state = parsed('escrow_finish_creates_token').holderStates.find((h) => h.holder === t.tx.Account);
    expect(state).toMatchObject({ amount: '9990', deleted: false });
  });

  it('payment_failed: states as its nodes say (none), and no transfer', () => {
    expect(parsed('payment_failed')).toEqual({ issuanceStates: [], holderStates: [], transfers: [], anomalies: 0 });
  });

  it('a failed transaction with MPT nodes still has states, and no transfer', () => {
    const failed = editedMptCase('payment_holder_to_holder', (_tx, meta) => {
      meta.TransactionResult = 'tecPATH_DRY';
    });
    expect(parseAt(failed).holderStates).toHaveLength(2);
    expect(parseAt(failed).transfers).toEqual([]);
  });

  it('clawback_issued: nothing', () => {
    expect(parsed('clawback_issued')).toEqual({ issuanceStates: [], holderStates: [], transfers: [], anomalies: 0 });
  });

  it('every ID of every state of every recorded transaction decodes, and no amount is anything but digits', () => {
    for (const { network, t } of everyMptTransaction()) {
      const { issuanceStates, holderStates, transfers, anomalies } = parser.parse(t, mptContext(network));
      expect({ hash: t.hash, anomalies }).toEqual({ hash: t.hash, anomalies: 0 });
      for (const { mpt_issuance_id: id } of [...issuanceStates, ...holderStates, ...transfers]) {
        expect(() => decodeMptIssuanceId(id)).not.toThrow();
      }
      for (const state of issuanceStates) {
        for (const value of [state.outstanding_amount, state.escrowed_amount]) expect(value).toMatch(/^\d+$/);
      }
      for (const state of holderStates) {
        for (const value of [state.amount, state.escrowed_amount]) expect(value).toMatch(/^\d+$/);
      }
      for (const transfer of transfers) {
        for (const value of [transfer.amount, transfer.fee]) expect(value).toMatch(/^\d+$/);
      }
    }
  });

  it('gives at most one transfer per transaction, and only for a success', () => {
    for (const { network, t } of everyMptTransaction()) {
      const { transfers } = parser.parse(t, mptContext(network));
      expect(transfers.length).toBeLessThanOrEqual(1);
      if (t.meta.TransactionResult !== 'tesSUCCESS') expect(transfers).toEqual([]);
    }
  });

  it('shares no objects with what it read, and gives the same answer twice', () => {
    for (const name of mptCaseNames()) {
      const t = mptCase(name);
      const first = parser.parse(t, mptCaseContext(name));
      expect(parser.parse(t, mptCaseContext(name))).toEqual(first);
      for (const value of [...first.issuanceStates, ...first.holderStates, ...first.transfers].flatMap(Object.values)) {
        expect(typeof value === 'object' && value !== null).toBe(false);
      }
    }
  });
});

describe('MptParser: transfers of a payment', () => {
  it('payment_holder_to_holder: from and to the holders, no fee', () => {
    const t = mptCase('payment_holder_to_holder');
    expect(parsed('payment_holder_to_holder').transfers).toEqual([
      {
        mpt_issuance_id: t.tx.Amount.mpt_issuance_id,
        kind: 'payment',
        source: t.tx.Account,
        destination: t.tx.Destination,
        amount: '100000',
        fee: '0',
      },
    ]);
  });

  it('payment_mint: from the issuer, no fee', () => {
    const t = mptCase('payment_mint');
    expect(parsed('payment_mint').transfers).toEqual([
      expect.objectContaining({
        kind: 'payment',
        source: mptIssuerOf(t.tx.Amount.mpt_issuance_id),
        destination: t.tx.Destination,
        amount: '1',
        fee: '0',
      }),
    ]);
  });

  it('payment_redeem: to the issuer, no fee', () => {
    const t = mptCase('payment_redeem');
    expect(parsed('payment_redeem').transfers).toEqual([
      expect.objectContaining({ destination: mptIssuerOf(t.tx.Amount.mpt_issuance_id), amount: '1', fee: '0' }),
    ]);
  });

  it('records the burned fee of payment_transfer_fee: the fall of the outstanding amount', () => {
    const { transfers, issuanceStates } = parsed('payment_transfer_fee');
    expect(transfers).toEqual([expect.objectContaining({ amount: '1000000', fee: '5890' })]);
    expect(issuanceStates[0].outstanding_amount).toBe('199999998994110');
    const issuance = mptNode(mptCase('payment_transfer_fee').meta, 'MPTokenIssuance');
    expect(BigInt(issuance.PreviousFields.OutstandingAmount) - BigInt(issuance.FinalFields.OutstandingAmount)).toBe(
      5890n,
    );
  });

  it('records the same fee on a fee payment after the fix', () => {
    const t = editedMptCase('payment_transfer_fee', () => undefined);
    const after = { ...t, ledger_index: 107000000 };
    expect(parseAt(after).transfers).toEqual([expect.objectContaining({ amount: '1000000', fee: '5890' })]);
  });

  it('delivers Amount before the fix', () => {
    const t = mptCase('payment_before_delivered_fix');
    expect(t.meta.DeliveredAmount).toBeUndefined();
    expect(parsed('payment_before_delivered_fix').transfers).toEqual([
      expect.objectContaining({ amount: t.tx.Amount.value, fee: '0' }),
    ]);
  });

  it('delivers what the metadata stored for a partial payment, and no fee on what was not sent', () => {
    const t = mptCase('payment_holder_to_holder');
    const partial = editedMptCase('payment_holder_to_holder', (tx, meta) => {
      tx.Flags = 0x00020000;
      const delivered = { mpt_issuance_id: tx.Amount.mpt_issuance_id, value: '40000' };
      meta.DeliveredAmount = delivered;
      meta.delivered_amount = delivered;
      mptNode(meta, 'MPToken', (f) => f.Account === t.tx.Account).PreviousFields.MPTAmount = '40000';
      const receiver = mptNode(meta, 'MPToken', (f) => f.Account === t.tx.Destination);
      receiver.FinalFields.MPTAmount = '56267452';
    });
    expect(parseAt(partial).transfers).toEqual([expect.objectContaining({ amount: '40000', fee: '0' })]);
  });

  // Synthetic (FINDINGS (5)): before the fix the ledger stored no DeliveredAmount, and the node serves Amount as delivered_amount.
  const partialBeforeFix = (name: string, asked: string): ParserTx =>
    editedMptCase(name, (tx, meta) => {
      tx.Flags = 0x00020000;
      tx.Amount.value = asked;
      delete meta.DeliveredAmount;
      meta.delivered_amount = { mpt_issuance_id: tx.Amount.mpt_issuance_id, value: asked };
    });

  it("delivers the destination's rise on a partial payment before the fix, the fee being what was burned", () => {
    expect(parseAt(partialBeforeFix('payment_transfer_fee', '2000000')).transfers).toEqual([
      expect.objectContaining({ amount: '1000000', fee: '5890' }),
    ]);
  });

  it('delivers the fall of OutstandingAmount on a partial payment to the issuer before the fix', () => {
    const asked = mptCase('payment_redeem').tx.Amount.value as string;
    expect(parseAt(partialBeforeFix('payment_redeem', `${asked}0`)).transfers).toEqual([
      expect.objectContaining({ amount: asked, fee: '0' }),
    ]);
  });

  it('reads the DeliverMax of a transaction without Amount', () => {
    const t = mptCase('payment_mint');
    const deliverMax = editedMptCase('payment_mint', (tx, meta) => {
      delete tx.Amount;
      delete meta.delivered_amount;
    });
    expect(parseAt(deliverMax).transfers).toEqual([
      expect.objectContaining({ mpt_issuance_id: t.tx.DeliverMax.mpt_issuance_id, amount: '1' }),
    ]);
  });

  it('counts an amount that is not digits and writes 0', () => {
    const bad = editedMptCase('payment_mint', (tx, meta) => {
      tx.Amount.value = 'x';
      meta.delivered_amount.value = 'x';
    });
    const { transfers, anomalies } = parseAt(bad);
    expect(transfers[0].amount).toBe('0');
    expect(anomalies).toBe(1);
  });

  it('gives no transfer for an ID that is not 48 hex digits, and keeps the states', () => {
    const short = editedMptCase('payment_mint', (tx, meta) => {
      tx.Amount.mpt_issuance_id = '00';
      meta.delivered_amount.mpt_issuance_id = '00';
    });
    expect(parseAt(short).transfers).toEqual([]);
    expect(parseAt(short).holderStates).toHaveLength(1);
  });

  it('gives no transfer for a mixed payment, as MPTokensV2 is not enabled', () => {
    const nativeSendMax = editedMptCase('payment_transfer_fee', (tx) => {
      tx.SendMax = '1000000';
    });
    const nativeAmount = editedMptCase('payment_transfer_fee', (tx, meta) => {
      tx.Amount = '1000000';
      delete tx.DeliverMax;
      meta.delivered_amount = '1000000';
    });
    expect(parseAt(nativeSendMax).transfers).toEqual([]);
    expect(parseAt(nativeAmount).transfers).toEqual([]);
  });
});

describe('MptParser: transfers of a clawback', () => {
  it('clawback_full: from the holder to the issuer, what was taken', () => {
    const t = mptCase('clawback_full');
    expect(parsed('clawback_full').transfers).toEqual([
      {
        mpt_issuance_id: t.tx.Amount.mpt_issuance_id,
        kind: 'clawback',
        source: t.tx.Holder,
        destination: t.tx.Account,
        amount: '1',
        fee: '0',
      },
    ]);
  });

  it('clawback_partial, in a Batch: the holder fall, with Flags tfInnerBatchTxn', () => {
    const t = mptCase('clawback_partial');
    expect(t.tx.Flags).toBe(TF_INNER_BATCH_TXN);
    const holder = mptNode(t.meta, 'MPToken');
    const fall = BigInt(holder.PreviousFields.MPTAmount) - BigInt(holder.FinalFields.MPTAmount);
    expect(parsed('clawback_partial').transfers).toEqual([
      expect.objectContaining({ kind: 'clawback', amount: String(fall), fee: '0' }),
    ]);
    // FINDINGS: taken equals Amount on every clawback read; the synthetic below is one that took less.
    expect(String(fall)).toBe(t.tx.Amount.value);
  });

  it('takes the holder fall when that is less than asked', () => {
    const tookLess = editedMptCase('clawback_partial', (_tx, meta) => {
      mptNode(meta, 'MPToken').FinalFields.MPTAmount = '3500000';
      mptNode(meta, 'MPTokenIssuance').FinalFields.OutstandingAmount = '3500000';
    });
    expect(BigInt(tookLess.tx.Amount.value)).toBeGreaterThan(500000n);
    expect(parseAt(tookLess).transfers).toEqual([expect.objectContaining({ amount: '500000' })]);
  });

  it('writes 0 for a holder whose balance did not fall, and never a negative amount', () => {
    const rose = editedMptCase('clawback_partial', (_tx, meta) => {
      mptNode(meta, 'MPToken').FinalFields.MPTAmount = '5000000';
    });
    expect(parseAt(rose).transfers).toEqual([expect.objectContaining({ amount: '0' })]);
    const none = editedMptCase('clawback_partial', (_tx, meta) => {
      meta.AffectedNodes = [];
    });
    expect(parseAt(none).transfers).toEqual([expect.objectContaining({ amount: '0' })]);
  });

  it('gives no transfer for an ID that is not 48 hex digits', () => {
    const short = editedMptCase('clawback_full', (tx) => {
      tx.Amount.mpt_issuance_id = '00';
    });
    expect(parseAt(short).transfers).toEqual([]);
  });
});

describe('MptParser: transfers of a lock', () => {
  it('issuance_set_lock_holder: the issuer to the holder, its MPTAmount, and the flag on the holder', () => {
    const t = mptCase('issuance_set_lock_holder');
    const { transfers, holderStates } = parsed('issuance_set_lock_holder');
    expect(transfers).toEqual([
      {
        mpt_issuance_id: t.tx.MPTokenIssuanceID,
        kind: 'lock',
        source: t.tx.Account,
        destination: t.tx.Holder,
        amount: '45000000',
        fee: '0',
      },
    ]);
    expect(holderStates[0].flags & LSF_MPT_LOCKED).toBe(LSF_MPT_LOCKED);
  });

  it('issuance_set_unlock_holder: unlock, and the flag gone', () => {
    const { transfers, holderStates } = parsed('issuance_set_unlock_holder');
    expect(transfers).toEqual([expect.objectContaining({ kind: 'unlock', amount: '45000000', fee: '0' })]);
    expect(holderStates[0].flags & LSF_MPT_LOCKED).toBe(0);
  });

  it("issuance_set_lock_all: destination '' and the OutstandingAmount", () => {
    expect(parsed('issuance_set_lock_all').transfers).toEqual([
      expect.objectContaining({ kind: 'lock', destination: '', amount: '100', fee: '0' }),
    ]);
  });

  it('reads the flag of a lock inside a Batch, masked by a bit test', () => {
    const lock = editedMptCase('issuance_set_lock_holder', (tx) => {
      tx.Flags = TF_INNER_BATCH_TXN | TF_MPT_LOCK;
    });
    const unlock = editedMptCase('issuance_set_unlock_holder', (tx) => {
      tx.Flags = TF_INNER_BATCH_TXN | TF_MPT_UNLOCK;
    });
    expect(parseAt(lock).transfers).toEqual([expect.objectContaining({ kind: 'lock' })]);
    expect(parseAt(unlock).transfers).toEqual([expect.objectContaining({ kind: 'unlock' })]);
  });

  it('gives no transfer for an MPTokenIssuanceSet with neither flag, inside a Batch or not', () => {
    for (const flags of [0, undefined, TF_INNER_BATCH_TXN]) {
      const none = editedMptCase('issuance_set_lock_holder', (tx) => {
        tx.Flags = flags;
      });
      expect(parseAt(none).transfers).toEqual([]);
    }
  });

  it("writes '0' when the node of a lock is not in the metadata", () => {
    const holder = editedMptCase('issuance_set_lock_holder', (_tx, meta) => {
      meta.AffectedNodes = [];
    });
    const all = editedMptCase('issuance_set_lock_all', (_tx, meta) => {
      meta.AffectedNodes = [];
    });
    expect(parseAt(holder).transfers).toEqual([expect.objectContaining({ amount: '0' })]);
    expect(parseAt(all).transfers).toEqual([expect.objectContaining({ amount: '0' })]);
  });

  it('gives no transfer for a failed lock, or an ID that is not 48 hex digits', () => {
    const failed = editedMptCase('issuance_set_lock_holder', (_tx, meta) => {
      meta.TransactionResult = 'tecNO_PERMISSION';
    });
    const short = editedMptCase('issuance_set_lock_holder', (tx) => {
      tx.MPTokenIssuanceID = '00';
    });
    expect(parseAt(failed).transfers).toEqual([]);
    expect(parseAt(short).transfers).toEqual([]);
  });
});

describe('MptParser: transfers of an escrow', () => {
  it('escrow_create: the amount, from the holder to the destination', () => {
    const t = mptCase('escrow_create');
    expect(parsed('escrow_create').transfers).toEqual([
      {
        mpt_issuance_id: t.tx.Amount.mpt_issuance_id,
        kind: 'escrow_create',
        source: t.tx.Account,
        destination: t.tx.Destination,
        amount: '277073',
        fee: '0',
      },
    ]);
  });

  it('escrow_finish: the escrow’s parties and amount, no fee when the destination got it all', () => {
    const t = mptCase('escrow_finish');
    expect(parsed('escrow_finish').transfers).toEqual([
      {
        mpt_issuance_id: '0663EB64E8DDA74A98C6C70B740E67C7A2D1509EE78C163A',
        kind: 'escrow_finish',
        source: t.tx.Owner,
        destination: t.tx.Account,
        amount: '277073',
        fee: '0',
      },
    ]);
  });

  it('escrow_finish_transfer_fee: the fee comes out of the locked amount', () => {
    expect(parsed('escrow_finish_transfer_fee').transfers).toEqual([
      expect.objectContaining({ kind: 'escrow_finish', amount: '10000', fee: '10' }),
    ]);
    expect(parsed('escrow_finish_transfer_fee').issuanceStates[0].outstanding_amount).toBe('99990');
  });

  it('escrow_finish_creates_token: the fee, read from a created token', () => {
    expect(parsed('escrow_finish_creates_token').transfers).toEqual([
      expect.objectContaining({ kind: 'escrow_finish', amount: '10000', fee: '10' }),
    ]);
  });

  it('a finish to the issuer has no fee, as the issuer holds no MPToken', () => {
    const t = mptCase('escrow_finish');
    const toIssuer = editedMptCase('escrow_finish', (tx, meta) => {
      const issuance = mptNode(meta, 'MPTokenIssuance');
      const issuer = issuance.FinalFields.Issuer as string;
      tx.Account = issuer;
      mptNode(meta, 'Escrow').FinalFields.Destination = issuer;
      meta.AffectedNodes = (meta.AffectedNodes as Record<string, any>[]).filter(
        (entry) => entry.ModifiedNode?.FinalFields?.Account !== t.tx.Account,
      );
      issuance.PreviousFields.OutstandingAmount = issuance.FinalFields.OutstandingAmount;
      issuance.FinalFields.OutstandingAmount = '677146';
    });
    expect(parseAt(toIssuer).transfers).toEqual([
      expect.objectContaining({ kind: 'escrow_finish', amount: '277073', fee: '0' }),
    ]);
  });

  it('escrow_cancel: the amount returns to the same account', () => {
    const t = mptCase('escrow_cancel');
    expect(parsed('escrow_cancel').transfers).toEqual([
      {
        mpt_issuance_id: '012B9F3AE0240039D43CFE08C9DB96476E1A3B31A6D90097',
        kind: 'escrow_cancel',
        source: t.tx.Owner,
        destination: t.tx.Owner,
        amount: '10000',
        fee: '0',
      },
    ]);
  });

  it('gives no transfer for a finish or cancel of an escrow that holds no MPT, or a create of another asset', () => {
    const finish = editedMptCase('escrow_finish', (_tx, meta) => {
      mptNode(meta, 'Escrow').FinalFields.Amount = '1000000';
    });
    const create = editedMptCase('escrow_create', (tx) => {
      tx.Amount = '1000000';
    });
    expect(parseAt(finish).transfers).toEqual([]);
    expect(parseAt(create).transfers).toEqual([]);
  });

  it('counts an escrow amount that is not digits and writes 0', () => {
    const bad = editedMptCase('escrow_create', (tx) => {
      tx.Amount.value = 'x';
    });
    expect(parseAt(bad).transfers).toEqual([expect.objectContaining({ amount: '0' })]);
    expect(parseAt(bad).anomalies).toBe(1);
  });
});

describe('MptParser: nothing throws on ledger data', () => {
  it('counts what it cannot read of an issuance and writes the default', () => {
    const bad = editedMptCase('issuance_create', (_tx, meta) => {
      const fields = mptNode(meta, 'MPTokenIssuance').NewFields;
      fields.AssetScale = 'x';
      fields.TransferFee = 70000;
      fields.Flags = -1;
      fields.MaximumAmount = 'x';
      fields.MPTokenMetadata = 5;
    });
    const { issuanceStates, anomalies } = parseAt(bad);
    expect(issuanceStates[0]).toMatchObject({
      asset_scale: 0,
      transfer_fee: 0,
      flags: 0,
      maximum_amount: null,
      metadata_hex: '',
    });
    expect(anomalies).toBe(5);
  });

  it('keeps the skipped nodes out of the states and counts them', () => {
    const noIssuer = editedMptCase('payment_mint', (_tx, meta) => {
      mptNode(meta, 'MPTokenIssuance').FinalFields.Issuer = 'not an address';
    });
    const { issuanceStates, holderStates, anomalies } = parseAt(noIssuer);
    expect(issuanceStates).toEqual([]);
    expect(holderStates).toHaveLength(1);
    expect(anomalies).toBe(1);
  });

  it('reads an empty transaction as nothing', () => {
    const empty: ParserTx = {
      hash: '',
      ledger_index: 1,
      close_time: 0,
      tx_index: 0,
      tx: {},
      meta: {},
      client: null,
    };
    expect(parser.parse(empty, XRPL)).toEqual({ issuanceStates: [], holderStates: [], transfers: [], anomalies: 0 });
    for (const TransactionType of [
      'Payment',
      'Clawback',
      'MPTokenIssuanceSet',
      'EscrowCreate',
      'EscrowFinish',
      'EscrowCancel',
    ]) {
      const bare = { ...empty, tx: { TransactionType }, meta: { TransactionResult: 'tesSUCCESS' } };
      expect(() => parser.parse(bare, XRPL)).not.toThrow();
      expect(parser.parse(bare, XRPL).transfers).toEqual([]);
    }
  });
});
