/**
 * `mptDeltas` over every recorded MPT transaction of `test/fixtures/xrpl/mpt` and `test/fixtures/xrpl-testnet/mpt`, and over the
 * synthetic cases below, each a small, named edit of a recorded transaction's metadata (FINDINGS.md says which shapes were not read):
 *
 * - `threaded`: `payment_holder_to_holder` with `PreviousFields` removed from the receiver's `MPToken`: a node that was only
 *   threaded (the sender's stays, so the conservation of the rest can still be read).
 * - `bad_amount`: `payment_holder_to_holder` with the receiver's `MPTAmount`s not digits, or above a UInt64.
 * - `bad_id`: `payment_holder_to_holder` with the receiver's `MPTokenIssuanceID` not 48 hex digits.
 * - `no_account`: `payment_holder_to_holder` with no `Account` in the receiver's `MPToken`.
 * - `bad_issuer`, `no_sequence`: `payment_mint` with the issuance's `Issuer` not an address, or with no `Sequence`.
 * - `failed_first_credit`: `payment_mint` with a `tec` result: the transaction credits no one, so a `PreviousFields` without
 *   `MPTAmount` is an unchanged balance.
 * - `other_issuance_credit`: `payment_mint` with `Amount` of another issuance: a token not of that issuance is not credited.
 * - `other_holder_escrow`: `escrow_create` by another account: only the holder that made the escrow has the field added.
 * - `other_issuance_escrow`: `escrow_create` of another issuance, likewise on the holder's and on the issuance's node.
 * - `escrow_finish_to_issuer`: `escrow_finish` to the escrow's issuer (none of the 69 finishes read does this): the issuer holds no
 *   `MPToken`, so that node goes, and `OutstandingAmount` falls by the amount.
 * - `self_escrow_finish`: `escrow_finish` whose escrow's `Destination` is its `Account`, with the two tokens as one.
 */
import { editedMptCase, everyMptTransaction, mptCase, mptCaseNames, mptNode } from '../test-utils/mpt-cases';
import { decodeMptIssuanceId } from '../util/mpt';
import { mptDeltas, MptDeltas, mptEscrowOf, mptPaymentIssuance, mptUnits } from './mpt-deltas';
import { ParserTx } from './parser.interface';

const deltasOf = (t: ParserTx): MptDeltas => mptDeltas(t.tx, t.meta);

const holderOf = (deltas: MptDeltas, holder: string) => {
  const found = deltas.holders.find((h) => h.holder === holder);
  if (found === undefined) throw new Error(`no delta of ${holder}`);
  return found;
};

const sumsOf = (deltas: MptDeltas): Map<string, { holders: bigint; escrowed: bigint }> => {
  const sums = new Map<string, { holders: bigint; escrowed: bigint }>();
  for (const h of deltas.holders) {
    const sum = sums.get(h.mpt_issuance_id) ?? { holders: 0n, escrowed: 0n };
    sum.holders += h.amount_after - h.amount_before + (h.escrowed_after - h.escrowed_before);
    sum.escrowed += h.escrowed_after - h.escrowed_before;
    sums.set(h.mpt_issuance_id, sum);
  }
  return sums;
};

describe('mptDeltas: conservation over every recorded transaction', () => {
  const every = everyMptTransaction();

  it('reads transactions of both networks, the named cases among them', () => {
    expect(every.filter((e) => e.network === 'xrpl').length).toBeGreaterThanOrEqual(20);
    expect(every.filter((e) => e.network === 'xrpl-testnet').length).toBeGreaterThanOrEqual(4);
    const hashes = new Set(every.map((e) => e.t.hash));
    for (const name of mptCaseNames().filter((n) => n !== 'clawback_issued' && n !== 'payment_failed')) {
      expect([name, hashes.has(mptCase(name).hash)]).toEqual([name, true]);
    }
  });

  it('conserves the outstanding amount: the holders move what the issuance says, and 0 without its node', () => {
    for (const { network, t } of every) {
      const deltas = deltasOf(t);
      const sums = sumsOf(deltas);
      for (const [id, { holders }] of sums) {
        const issuance = deltas.issuances.find((i) => i.mpt_issuance_id === id);
        const expected = issuance === undefined ? 0n : issuance.outstanding_after - issuance.outstanding_before;
        expect({ network, hash: t.hash, id, change: holders }).toEqual({ network, hash: t.hash, id, change: expected });
      }
      for (const issuance of deltas.issuances) {
        const holders = sums.get(issuance.mpt_issuance_id)?.holders ?? 0n;
        expect({ network, hash: t.hash, change: issuance.outstanding_after - issuance.outstanding_before }).toEqual({
          network,
          hash: t.hash,
          change: holders,
        });
      }
    }
  });

  it('moves the escrowed amounts of the holders and of the issuance together', () => {
    for (const { network, t } of every) {
      const deltas = deltasOf(t);
      const sums = sumsOf(deltas);
      for (const issuance of deltas.issuances) {
        const escrowed = sums.get(issuance.mpt_issuance_id)?.escrowed ?? 0n;
        expect({ network, hash: t.hash, change: issuance.escrowed_after - issuance.escrowed_before }).toEqual({
          network,
          hash: t.hash,
          change: escrowed,
        });
      }
      // A holder's escrow always shows on the issuance's node too.
      for (const [id, { escrowed }] of sums) {
        if (escrowed !== 0n) expect(deltas.issuances.map((i) => i.mpt_issuance_id)).toContain(id);
      }
    }
  });

  it('never moves a balance below 0 and reads every amount of the recorded nodes', () => {
    for (const { network, t } of every) {
      const deltas = deltasOf(t);
      expect({ network, hash: t.hash, anomalies: deltas.anomalies }).toEqual({ network, hash: t.hash, anomalies: 0 });
      for (const h of deltas.holders) {
        for (const value of [h.amount_before, h.amount_after, h.escrowed_before, h.escrowed_after]) {
          expect(value >= 0n).toBe(true);
        }
      }
    }
  });

  it('makes an ID of 48 upper-case hex digits for every node, from the node', () => {
    for (const { t } of every) {
      const deltas = deltasOf(t);
      for (const { mpt_issuance_id: id } of [...deltas.holders, ...deltas.issuances]) {
        expect(id).toBe(id.toUpperCase());
        expect(() => decodeMptIssuanceId(id)).not.toThrow();
      }
      for (const issuance of deltas.issuances) {
        expect(decodeMptIssuanceId(issuance.mpt_issuance_id)).toEqual({
          sequence: issuance.sequence,
          issuer: issuance.issuer,
        });
      }
    }
  });

  it('gives each node the position it has in AffectedNodes', () => {
    for (const { t } of every) {
      const deltas = deltasOf(t);
      const nodes = t.meta.AffectedNodes as Record<string, any>[];
      for (const d of deltas.holders) {
        const body =
          nodes[d.node_index].CreatedNode ?? nodes[d.node_index].ModifiedNode ?? nodes[d.node_index].DeletedNode;
        expect(body.LedgerEntryType).toBe('MPToken');
      }
      for (const d of deltas.issuances) {
        const body =
          nodes[d.node_index].CreatedNode ?? nodes[d.node_index].ModifiedNode ?? nodes[d.node_index].DeletedNode;
        expect(body.LedgerEntryType).toBe('MPTokenIssuance');
      }
    }
  });
});

describe('mptDeltas: what a node lists', () => {
  it('reads a first credit, PreviousFields {}, as a rise from 0', () => {
    const t = mptCase('payment_mint');
    const delta = holderOf(deltasOf(t), t.tx.Destination);
    expect(delta).toMatchObject({ action: 'modified', amount_before: 0n, amount_after: 1n });
  });

  it('reads a first credit before fixMPTDeliveredAmount the same way', () => {
    const t = mptCase('payment_before_delivered_fix');
    expect(holderOf(deltasOf(t), t.tx.Destination)).toMatchObject({ amount_before: 0n, amount_after: 1n });
  });

  it('reads a first credit by a finish as a rise from 0, for the escrow destination', () => {
    const t = mptCase('escrow_finish');
    const deltas = deltasOf(t);
    expect(holderOf(deltas, t.tx.Account)).toMatchObject({ amount_before: 0n, amount_after: 277073n });
    // The owner's balance is not listed and stays: the finish credits another account.
    expect(holderOf(deltas, t.tx.Owner)).toMatchObject({
      amount_before: 636146n,
      amount_after: 636146n,
      escrowed_before: 318073n,
      escrowed_after: 41000n,
    });
    expect(deltas.issuances[0]).toMatchObject({
      escrowed_before: 318073n,
      escrowed_after: 41000n,
      outstanding_before: 954219n,
      outstanding_after: 954219n,
    });
  });

  it('reads a first escrow as a rise from 0 on the holder and on the issuance, PreviousFields {} on the latter', () => {
    const t = mptCase('escrow_create');
    const deltas = deltasOf(t);
    expect(holderOf(deltas, t.tx.Account)).toMatchObject({
      amount_before: 954219n,
      amount_after: 677146n,
      escrowed_before: 0n,
      escrowed_after: 277073n,
    });
    expect(deltas.issuances[0]).toMatchObject({
      escrowed_before: 0n,
      escrowed_after: 277073n,
      outstanding_before: 954219n,
      outstanding_after: 954219n,
    });
  });

  it('reads a cancel by an owner who had put in all it held as MPTAmount added', () => {
    const t = mptCase('escrow_cancel');
    const deltas = deltasOf(t);
    expect(holderOf(deltas, t.tx.Owner)).toMatchObject({
      amount_before: 0n,
      amount_after: 10000n,
      escrowed_before: 10000n,
      escrowed_after: 0n,
    });
    expect(deltas.issuances[0]).toMatchObject({ escrowed_before: 10000n, escrowed_after: 0n });
  });

  it('reads a field that falls to 0 and leaves FinalFields as 0', () => {
    const t = mptCase('clawback_full');
    expect(holderOf(deltasOf(t), t.tx.Holder)).toMatchObject({ amount_before: 1n, amount_after: 0n });
  });

  it('reads the fee of a finish: the destination rises by less than the locked amount falls', () => {
    const t = mptCase('escrow_finish_transfer_fee');
    const deltas = deltasOf(t);
    expect(holderOf(deltas, t.tx.Account)).toMatchObject({ amount_before: 0n, amount_after: 9990n });
    expect(holderOf(deltas, t.tx.Owner)).toMatchObject({ escrowed_before: 10000n, escrowed_after: 0n });
    expect(deltas.issuances[0]).toMatchObject({
      outstanding_before: 100000n,
      outstanding_after: 99990n,
      escrowed_before: 10000n,
      escrowed_after: 0n,
    });
  });

  it('reads an MPTAmount in the NewFields of a created token, as a finish can create one', () => {
    const t = mptCase('escrow_finish_creates_token');
    expect(holderOf(deltasOf(t), t.tx.Account)).toMatchObject({
      action: 'created',
      amount_before: 0n,
      amount_after: 9990n,
    });
  });

  it('reads a created MPToken with nothing on it as 0 to 0', () => {
    const t = mptCase('authorize_holder');
    expect(holderOf(deltasOf(t), t.tx.Account)).toMatchObject({
      action: 'created',
      amount_before: 0n,
      amount_after: 0n,
      escrowed_before: 0n,
      escrowed_after: 0n,
      flags: 0,
    });
  });

  it('reads a lock as a change of flags alone', () => {
    const t = mptCase('issuance_set_lock_holder');
    expect(holderOf(deltasOf(t), t.tx.Holder)).toMatchObject({
      amount_before: 45000000n,
      amount_after: 45000000n,
      flags: 3,
    });
  });

  it('reads a deleted node from its final fields', () => {
    const unauthorized = mptCase('unauthorize_holder');
    expect(holderOf(deltasOf(unauthorized), unauthorized.tx.Account)).toMatchObject({
      action: 'deleted',
      amount_before: 0n,
      amount_after: 0n,
      flags: 2,
    });
    expect(deltasOf(mptCase('issuance_destroy')).issuances[0]).toMatchObject({
      action: 'deleted',
      outstanding_before: 0n,
      outstanding_after: 0n,
    });
  });

  it('builds the ID of a destroyed issuance from the node, as the transaction used a ticket', () => {
    const t = mptCase('issuance_destroy');
    expect(t.tx.Sequence).toBe(0);
    expect(deltasOf(t).issuances[0].mpt_issuance_id).toBe(t.tx.MPTokenIssuanceID);
  });

  it('reads a created issuance as 0 to 0, with its NewFields', () => {
    const t = mptCase('issuance_create');
    const [issuance] = deltasOf(t).issuances;
    expect(issuance).toMatchObject({ action: 'created', outstanding_before: 0n, outstanding_after: 0n });
    expect(issuance.fields.MPTokenMetadata).toBe(t.tx.MPTokenMetadata);
  });

  it('has nothing for a transaction without MPT nodes', () => {
    expect(deltasOf(mptCase('clawback_issued'))).toEqual({ holders: [], issuances: [], anomalies: 0 });
    expect(deltasOf(mptCase('payment_failed'))).toEqual({ holders: [], issuances: [], anomalies: 0 });
  });

  it('skips a node modified without PreviousFields', () => {
    const t = mptCase('payment_holder_to_holder');
    const threaded = editedMptCase('payment_holder_to_holder', (_tx, meta) => {
      delete mptNode(meta, 'MPToken', (f) => f.Account === t.tx.Destination).PreviousFields;
    });
    expect(deltasOf(threaded).holders.map((h) => h.holder)).toEqual([t.tx.Account]);
  });

  it('does not write to what it reads', () => {
    for (const name of mptCaseNames()) expect(() => deltasOf(mptCase(name))).not.toThrow();
  });
});

describe('mptDeltas: the transaction says which unlisted field was added', () => {
  it('reads an unlisted MPTAmount as unchanged when the transaction failed', () => {
    const t = mptCase('payment_mint');
    const failed = editedMptCase('payment_mint', (_tx, meta) => {
      meta.TransactionResult = 'tecNO_AUTH';
    });
    expect(holderOf(deltasOf(failed), t.tx.Destination)).toMatchObject({ amount_before: 1n, amount_after: 1n });
  });

  it('reads an unlisted MPTAmount as unchanged when the payment is of another issuance', () => {
    const t = mptCase('payment_mint');
    const other = editedMptCase('payment_mint', (tx) => {
      tx.Amount = { mpt_issuance_id: '0'.repeat(48), value: '1' };
    });
    expect(holderOf(deltasOf(other), t.tx.Destination)).toMatchObject({ amount_before: 1n, amount_after: 1n });
  });

  it('reads an unlisted LockedAmount as unchanged on an escrow by another holder', () => {
    const t = mptCase('escrow_create');
    const other = editedMptCase('escrow_create', (tx) => {
      tx.Account = 'rBoJ7MWPXiejVbqCRhiVgGcaXAHXVstCD4';
    });
    const deltas = deltasOf(other);
    expect(holderOf(deltas, t.tx.Account)).toMatchObject({ escrowed_before: 277073n, escrowed_after: 277073n });
    // The issuance's node is still of this issuance's escrow, whoever made it.
    expect(deltas.issuances[0]).toMatchObject({ escrowed_before: 0n, escrowed_after: 277073n });
  });

  it('reads an unlisted LockedAmount as unchanged on an escrow of another issuance', () => {
    const t = mptCase('escrow_create');
    const other = editedMptCase('escrow_create', (tx) => {
      tx.Amount = { mpt_issuance_id: '0'.repeat(48), value: '277073' };
    });
    const deltas = deltasOf(other);
    expect(holderOf(deltas, t.tx.Account)).toMatchObject({ escrowed_before: 277073n });
    expect(deltas.issuances[0]).toMatchObject({ escrowed_before: 277073n });
  });

  it('keeps the rest of the rule: a listed value wins over the rule', () => {
    const t = mptCase('payment_holder_to_holder');
    expect(holderOf(deltasOf(t), t.tx.Destination)).toMatchObject({
      amount_before: 56227452n,
      amount_after: 56327452n,
    });
  });

  it('credits the holder of a self-escrow on the finish when MPTAmount is not listed', () => {
    const t = mptCase('escrow_finish');
    const self = editedMptCase('escrow_finish', (tx, meta) => {
      tx.Account = t.tx.Owner;
      mptNode(meta, 'Escrow').FinalFields.Destination = t.tx.Owner;
    });
    const owner = deltasOf(self).holders.find((h) => h.holder === t.tx.Owner);
    expect(owner).toMatchObject({ amount_before: 0n, amount_after: 636146n });
  });

  it('conserves a finish to the issuer: no MPToken of the issuer, and OutstandingAmount falls by the amount', () => {
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
    const deltas = deltasOf(toIssuer);
    const issuance = deltas.issuances[0];
    expect(issuance.outstanding_before - issuance.outstanding_after).toBe(277073n);
    const holders = deltas.holders.reduce(
      (sum, h) => sum + h.amount_after - h.amount_before + (h.escrowed_after - h.escrowed_before),
      0n,
    );
    expect(holders).toBe(issuance.outstanding_after - issuance.outstanding_before);
  });
});

describe('mptDeltas: nothing throws on ledger data', () => {
  const RECEIVER = (t: ParserTx) => t.tx.Destination as string;

  it.each([
    ['not digits', 'x', 0n],
    ['a sign', '-5', 0n],
    ['a fraction', '1.5', 0n],
    ['hex', '0xFF', 0n],
    ['above a UInt64', '18446744073709551616', 0n],
    ['a number', 5, 0n],
    ['null', null, 0n],
  ])('reads an MPTAmount that is %s as 0 and counts it', (_name, value, read) => {
    const t = mptCase('payment_holder_to_holder');
    const bad = editedMptCase('payment_holder_to_holder', (_tx, meta) => {
      mptNode(meta, 'MPToken', (f) => f.Account === RECEIVER(t)).FinalFields.MPTAmount = value;
    });
    const deltas = deltasOf(bad);
    expect(holderOf(deltas, RECEIVER(t)).amount_after).toBe(read);
    expect(deltas.anomalies).toBe(1);
  });

  it('reads the largest UInt64 as it is', () => {
    const t = mptCase('payment_holder_to_holder');
    const big = editedMptCase('payment_holder_to_holder', (_tx, meta) => {
      mptNode(meta, 'MPToken', (f) => f.Account === RECEIVER(t)).FinalFields.MPTAmount = '18446744073709551615';
    });
    expect(holderOf(deltasOf(big), RECEIVER(t)).amount_after).toBe(18446744073709551615n);
    expect(deltasOf(big).anomalies).toBe(0);
  });

  it('counts each bad amount of a node, in PreviousFields too', () => {
    const t = mptCase('payment_holder_to_holder');
    const bad = editedMptCase('payment_holder_to_holder', (_tx, meta) => {
      const node = mptNode(meta, 'MPToken', (f) => f.Account === RECEIVER(t));
      node.FinalFields.MPTAmount = 'x';
      node.PreviousFields.MPTAmount = 'y';
    });
    expect(holderOf(deltasOf(bad), RECEIVER(t))).toMatchObject({ amount_before: 0n, amount_after: 0n });
    expect(deltasOf(bad).anomalies).toBe(2);
  });

  it('skips and counts an MPToken whose MPTokenIssuanceID is not 48 hex digits', () => {
    const t = mptCase('payment_holder_to_holder');
    for (const id of ['00', 'G'.repeat(48), undefined, 5]) {
      const bad = editedMptCase('payment_holder_to_holder', (_tx, meta) => {
        mptNode(meta, 'MPToken', (f) => f.Account === RECEIVER(t)).FinalFields.MPTokenIssuanceID = id;
      });
      const deltas = deltasOf(bad);
      expect(deltas.holders.map((h) => h.holder)).toEqual([t.tx.Account]);
      expect(deltas.anomalies).toBe(1);
    }
  });

  it('skips and counts an MPToken with no Account', () => {
    const t = mptCase('payment_holder_to_holder');
    const bad = editedMptCase('payment_holder_to_holder', (_tx, meta) => {
      delete mptNode(meta, 'MPToken', (f) => f.Account === RECEIVER(t)).FinalFields.Account;
    });
    expect(deltasOf(bad).holders.map((h) => h.holder)).toEqual([t.tx.Account]);
    expect(deltasOf(bad).anomalies).toBe(1);
  });

  it('skips and counts an MPTokenIssuance whose ID cannot be made', () => {
    const noIssuer = editedMptCase('payment_mint', (_tx, meta) => {
      mptNode(meta, 'MPTokenIssuance').FinalFields.Issuer = 'not an address';
    });
    const noSequence = editedMptCase('payment_mint', (_tx, meta) => {
      delete mptNode(meta, 'MPTokenIssuance').FinalFields.Sequence;
    });
    const hugeSequence = editedMptCase('payment_mint', (_tx, meta) => {
      mptNode(meta, 'MPTokenIssuance').FinalFields.Sequence = 2 ** 32;
    });
    for (const bad of [noIssuer, noSequence, hugeSequence]) {
      const deltas = deltasOf(bad);
      expect(deltas.issuances).toEqual([]);
      expect(deltas.anomalies).toBe(1);
      expect(deltas.holders).toHaveLength(1);
    }
  });

  it('reads no nodes from metadata without AffectedNodes, and a body with no fields as nothing', () => {
    expect(mptDeltas({}, {})).toEqual({ holders: [], issuances: [], anomalies: 0 });
    expect(mptDeltas({}, { AffectedNodes: 'x' })).toEqual({ holders: [], issuances: [], anomalies: 0 });
    expect(
      mptDeltas(
        {},
        { AffectedNodes: [null, 5, {}, { ModifiedNode: { LedgerEntryType: 'MPToken', PreviousFields: {} } }] },
      ),
    ).toEqual({ holders: [], issuances: [], anomalies: 1 });
  });

  it('reads a Flags that is not a UInt32 as 0 and counts it', () => {
    const t = mptCase('issuance_set_lock_holder');
    const bad = editedMptCase('issuance_set_lock_holder', (_tx, meta) => {
      mptNode(meta, 'MPToken').FinalFields.Flags = 'x';
    });
    expect(holderOf(deltasOf(bad), t.tx.Holder).flags).toBe(0);
    expect(deltasOf(bad).anomalies).toBe(1);
  });
});

describe('mptUnits', () => {
  it('reads the digits of a UInt64, and nothing else', () => {
    expect(mptUnits('0')).toBe(0n);
    expect(mptUnits('9223372036854775807')).toBe(9223372036854775807n);
    for (const value of ['', 'x', '-1', '1e3', ' 1', '18446744073709551616', 5, null, undefined, {}]) {
      expect(mptUnits(value)).toBeUndefined();
    }
  });
});

describe('mptPaymentIssuance', () => {
  const ID = '0000012AB5F762798A53D543A014CAF8B297CFF8F2F937E8';
  const OTHER = '0000012BB5F762798A53D543A014CAF8B297CFF8F2F937E8';
  const mpt = (id: string) => ({ mpt_issuance_id: id, value: '10' });

  it('is the ID of an MPT Amount or DeliverMax, in upper case', () => {
    expect(mptPaymentIssuance({ Amount: mpt(ID) }, {})).toBe(ID);
    expect(mptPaymentIssuance({ DeliverMax: mpt(ID) }, {})).toBe(ID);
    expect(mptPaymentIssuance({ Amount: mpt(ID.toLowerCase()) }, {})).toBe(ID);
  });

  it('holds when the other amounts are the same MPT or say nothing', () => {
    expect(
      mptPaymentIssuance(
        { Amount: mpt(ID), SendMax: mpt(ID) },
        { DeliveredAmount: mpt(ID), delivered_amount: mpt(ID) },
      ),
    ).toBe(ID);
    expect(mptPaymentIssuance({ Amount: mpt(ID) }, { delivered_amount: 'unavailable' })).toBe(ID);
  });

  it('is undefined for a mixed payment, as MPTokensV2 is not enabled', () => {
    expect(mptPaymentIssuance({ Amount: '1000000', SendMax: mpt(ID) }, {})).toBeUndefined();
    expect(mptPaymentIssuance({ Amount: '1000000' }, { DeliveredAmount: mpt(ID) })).toBeUndefined();
    expect(mptPaymentIssuance({ Amount: mpt(ID), SendMax: '1000000' }, {})).toBeUndefined();
    expect(mptPaymentIssuance({ Amount: mpt(ID), SendMax: mpt(OTHER) }, {})).toBeUndefined();
    expect(mptPaymentIssuance({ Amount: mpt(ID) }, { delivered_amount: '5' })).toBeUndefined();
  });

  it('is undefined for an ID that is not 48 hex digits, and for no MPT at all', () => {
    expect(mptPaymentIssuance({ Amount: mpt('00') }, {})).toBeUndefined();
    expect(mptPaymentIssuance({ Amount: { mpt_issuance_id: 5, value: '1' } }, {})).toBeUndefined();
    expect(mptPaymentIssuance({ Amount: '1000000' }, {})).toBeUndefined();
    expect(mptPaymentIssuance({ Amount: { currency: 'USD', issuer: 'r', value: '1' } }, {})).toBeUndefined();
    expect(mptPaymentIssuance({}, {})).toBeUndefined();
  });
});

describe('mptEscrowOf', () => {
  it('is the deleted Escrow node of an MPT escrow', () => {
    const t = mptCase('escrow_finish');
    expect(mptEscrowOf(t.meta)).toEqual({
      account: t.tx.Owner,
      destination: t.tx.Account,
      mpt_issuance_id: '0663EB64E8DDA74A98C6C70B740E67C7A2D1509EE78C163A',
      value: '277073',
    });
  });

  it('is undefined when no Escrow was deleted, or the deleted one holds no MPT', () => {
    expect(mptEscrowOf(mptCase('escrow_create').meta)).toBeUndefined();
    const native = editedMptCase('escrow_finish', (_tx, meta) => {
      mptNode(meta, 'Escrow').FinalFields.Amount = '1000000';
    });
    expect(mptEscrowOf(native.meta)).toBeUndefined();
    const short = editedMptCase('escrow_finish', (_tx, meta) => {
      mptNode(meta, 'Escrow').FinalFields.Amount = { mpt_issuance_id: '00', value: '1' };
    });
    expect(mptEscrowOf(short.meta)).toBeUndefined();
    expect(mptEscrowOf({})).toBeUndefined();
  });
});
