import {
  buildLedgerRows,
  getNetworkProfile,
  parseContextFor,
  RawTransaction,
  TransactionsRow,
} from '@gatehub/data-api-shared';
import { delegatedFrom, SYNTHETIC_DELEGATE } from '../../../../packages/shared/test/synthetic-delegated';
import { fixtureTransaction } from '../../test/support/fixtures';
import { toTransactionSummary } from './transaction-summary';

const CTX = parseContextFor(getNetworkProfile('xrpl'));

/** The recorded native Payment `synthetic-delegated-payment` is made from: 15.151515 XRP, a 5000 drop fee (ledger 107670360). */
const PAYMENT = 'BAF0C2EC22CFC229C9AABC02413EB6433A820F5689B69FD4AD83565A38EF77ED';
const SYNTHETIC = 'synthetic-delegated-payment';

const recorded = fixtureTransaction('xrpl-recorded', PAYMENT);
const SENDER = String(recorded.tx.tx.Account);
const DESTINATION = String(recorded.tx.tx.Destination);

/** The row the syncer stores for `raw`, which sits in the ledger of the recorded payment. */
function stored(raw: RawTransaction): TransactionsRow {
  return buildLedgerRows({ header: recorded.ledger.header, transactions: [raw] }, CTX).transactions[0];
}

// `synthetic-delegated-payment`: the recorded Payment as if its sender had delegated it and the delegate had paid the 5000 drop
// fee (`delegatedFrom`). Hand-made, never recorded: no Payment of a delegate was found on the network.
const delegated = stored(delegatedFrom(recorded.tx, SYNTHETIC));
const undelegated = recorded.row;

describe('toTransactionSummary of a delegated transaction', () => {
  it('the data is as the tests assume', () => {
    expect(JSON.parse(delegated.tx_json).Delegate).toBe(SYNTHETIC_DELEGATE);
    expect(JSON.parse(undelegated.tx_json).Delegate).toBeUndefined();
    expect([delegated.account, delegated.fee, undelegated.fee]).toEqual([SENDER, '5000', '5000']);
    expect(SYNTHETIC_DELEGATE).not.toBe(DESTINATION);
    expect(SYNTHETIC_DELEGATE).not.toBe(SENDER);
  });

  it("puts the fee on the delegate's row and names the delegate last", () => {
    const summary = toTransactionSummary(delegated, SYNTHETIC_DELEGATE, CTX);
    expect(summary).toMatchObject({ initiator: false, fee: '0.005', delegate: SYNTHETIC_DELEGATE });
    // the delegate is no party to the payment, so it has nothing of the transaction's sides
    expect([summary.counterparty, summary.amount, summary.currency, summary.issuer]).toEqual([null, null, null, null]);
    expect(Object.keys(summary).at(-1)).toBe('delegate');
    expect(Object.keys(summary).at(-2)).toBe('flags_changed');
  });

  it("leaves the sender's fee empty when a delegate paid it", () => {
    expect(toTransactionSummary(delegated, SENDER, CTX)).toEqual({
      hash: delegated.hash,
      ledger_index: delegated.ledger_index,
      executed_time: '2026-10-15T10:00:02+00:00',
      tx_type: 'Payment',
      result: 'tesSUCCESS',
      initiator: true,
      counterparty: DESTINATION,
      amount: '15.151515',
      currency: 'XRP',
      issuer: null,
      fee: null,
      flags_changed: null,
      delegate: SYNTHETIC_DELEGATE,
    });
  });

  it('names the delegate on the row of the receiver too, with no fee', () => {
    expect(toTransactionSummary(delegated, DESTINATION, CTX)).toMatchObject({
      initiator: false,
      counterparty: SENDER,
      amount: '15.151515',
      fee: null,
      delegate: SYNTHETIC_DELEGATE,
    });
  });

  it('the fee is on one row only: the delegate that is also the receiver gets it', () => {
    const toDelegate = stored(delegatedFrom(recorded.tx, 'synthetic-delegated-payment-to-its-delegate', DESTINATION));
    const rows = [SENDER, DESTINATION].map((account) => toTransactionSummary(toDelegate, account, CTX));
    expect(rows.map((r) => [r.initiator, r.fee, r.delegate])).toEqual([
      [true, null, DESTINATION],
      [false, '0.005', DESTINATION],
    ]);
  });
});

describe('toTransactionSummary of an undelegated transaction', () => {
  it('keeps an undelegated row as it was, with an empty delegate', () => {
    expect(toTransactionSummary(undelegated, SENDER, CTX)).toEqual({
      hash: undelegated.hash,
      ledger_index: undelegated.ledger_index,
      executed_time: '2026-10-15T10:00:02+00:00',
      tx_type: 'Payment',
      result: 'tesSUCCESS',
      initiator: true,
      counterparty: DESTINATION,
      amount: '15.151515',
      currency: 'XRP',
      issuer: null,
      fee: '0.005',
      flags_changed: null,
      delegate: null,
    });
    expect(toTransactionSummary(undelegated, DESTINATION, CTX)).toMatchObject({
      initiator: false,
      fee: null,
      delegate: null,
    });
  });

  it('an empty Delegate is no delegate: the sender pays', () => {
    const tx = { ...JSON.parse(undelegated.tx_json), Delegate: '' };
    const summary = toTransactionSummary({ ...undelegated, tx_json: JSON.stringify(tx) }, SENDER, CTX);
    expect([summary.initiator, summary.fee, summary.delegate]).toEqual([true, '0.005', null]);
  });
});
