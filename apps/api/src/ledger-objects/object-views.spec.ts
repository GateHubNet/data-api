import { TrackedObjectType } from '@gatehub/data-api-shared';
import {
  AMOUNT_KEYS,
  CHECK_KEYS,
  checkObject,
  DELEGATION_CSV_COLUMNS,
  DELEGATION_KEYS,
  delegationCsvRow,
  delegationObject,
  DELEGATIONS_BODY_KEYS,
  DETAIL_BODY_KEYS,
  ESCROW_KEYS,
  escrowObject,
  EVENT_CSV_COLUMNS,
  EVENT_EXTRA_KEYS,
  EVENT_KEYS,
  HISTORY_BODY_KEYS,
  LEDGER_OBJECT_KEYS,
  OBJECT_REF_KEYS,
  objectAmount,
  objectEvent,
  objectEventCsvRow,
  ObjectRead,
  PAYMENT_CHANNEL_KEYS,
  paymentChannelObject,
  PERMISSION_KEYS,
  REMOVED_KEYS,
  rippleIso,
} from './object-views';

const ALICE = 'rHciXfDnf4BXsRqTEuvoKmxZWBkxYMRVpt';
const BOB = 'rnKd8CYrXwMoGn4R48onJGLShh1PcrFrTx';
const CAROL = 'rhv9jFwfWfH4Cd1uX4b3ACkdgDKASFz7Dz';
const ISSUER = 'rUNuVgEcbL5Po5RKGnq8DP1KukY6RkTSyz';
const HEX_CURRENCY = '5852504C00000000000000000000000000000000';
const MPT_ID = '0000012AB5F762798A53D543A014CAF8B297CFF8F2F937E8';
const MPT_ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const OBJECT_ID = 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90';
const HASH = (n: number): string => n.toString(16).toUpperCase().padStart(64, '0');

/** 2026-10-24T09:30:00Z, in unix seconds: the close time of the answer. */
const T = Date.UTC(2026, 9, 24, 9, 30, 0) / 1000;
/** The Ripple epoch (2000-01-01T00:00:00Z) in unix seconds. */
const RIPPLE_EPOCH = 946_684_800;
/** A Ripple-epoch time as a ledger field, from a unix time. */
const ripple = (unix: number): number => unix - RIPPLE_EPOCH;

type Obj = Record<string, unknown>;

/** `keys` are those of `order` that `object` has, in that order: no key is out of place, none is made up. */
function expectOrdered(object: Obj, order: readonly string[]): void {
  const keys = Object.keys(object);
  expect(keys).toEqual(order.filter((k) => keys.includes(k)));
}

/** An input must not be changed: the rows are deep frozen. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/** A row of `object_changes` as the service gives it (built here: these are synthetic cases, with the field shapes of the recorded nodes). */
function row(o: Partial<ObjectRead> = {}): ObjectRead {
  return deepFreeze({
    object_type: 'Escrow' as TrackedObjectType,
    object_id: OBJECT_ID,
    ledger_index: 107_684_512,
    tx_index: 3,
    tx_hash: HASH(1),
    close_time: Date.UTC(2026, 9, 15, 8, 44, 19) / 1000,
    tx_type: 'EscrowCreate',
    result: 'tesSUCCESS',
    sender: ALICE,
    delegate: '',
    action: 'created' as const,
    event: 'create',
    owner: ALICE,
    counterparty: BOB,
    fields: {},
    previous: {},
    event_fields: {},
    ...o,
  });
}

const CREATED_REF = { ledger_index: 107_684_512, time: '2026-10-15T08:44:19Z', tx_hash: HASH(1) };

describe('the key lists', () => {
  it('equal the spec, key for key', () => {
    expect(OBJECT_REF_KEYS).toEqual(['ledger_index', 'time', 'tx_hash']);
    expect(REMOVED_KEYS).toEqual(['ledger_index', 'time', 'tx_hash', 'tx_type']);
    expect(EVENT_KEYS).toEqual([
      'event',
      'ledger_index',
      'time',
      'tx_hash',
      'tx_type',
      'account',
      'delegate',
      'result',
    ]);
    expect(ESCROW_KEYS).toEqual([
      'escrow_id',
      'account',
      'sequence',
      'destination',
      'amount',
      'finish_after',
      'cancel_after',
      'condition',
      'fulfillment',
      'destination_tag',
      'source_tag',
      'transfer_rate',
      'status',
      'created',
      'removed',
    ]);
    expect(CHECK_KEYS).toEqual([
      'check_id',
      'account',
      'sequence',
      'destination',
      'send_max',
      'expiration',
      'invoice_id',
      'destination_tag',
      'source_tag',
      'delivered',
      'status',
      'created',
      'removed',
    ]);
    expect(PAYMENT_CHANNEL_KEYS).toEqual([
      'channel_id',
      'account',
      'sequence',
      'destination',
      'amount',
      'balance',
      'remaining',
      'settle_delay',
      'public_key',
      'expiration',
      'cancel_after',
      'destination_tag',
      'source_tag',
      'status',
      'opened_with',
      'funds',
      'claims',
      'created',
      'removed',
    ]);
    expect(EVENT_EXTRA_KEYS).toEqual({
      escrow: ['amount', 'fulfillment'],
      check: ['send_max', 'expiration', 'delivered'],
      payment_channel: ['amount', 'balance', 'amount_change', 'balance_change', 'expiration', 'settle_delay'],
    });
    expect(DELEGATION_KEYS).toEqual(['delegation_id', 'account', 'authorize', 'permissions', 'updated', 'created']);
    expect(PERMISSION_KEYS).toEqual(['permission', 'kind', 'transaction_type']);
    expect(LEDGER_OBJECT_KEYS).toEqual(['object_id', 'object_type', 'account', 'deleted', 'ledger_index']);
    expect(AMOUNT_KEYS).toEqual(['currency', 'issuer', 'value', 'mpt_issuance_id']);
  });

  it('start every body with result, coverage, ledger_index and close_time', () => {
    expect(DETAIL_BODY_KEYS).toEqual({
      escrow: ['result', 'coverage', 'ledger_index', 'close_time', 'escrow', 'history', 'history_marker'],
      check: ['result', 'coverage', 'ledger_index', 'close_time', 'check', 'history', 'history_marker'],
      payment_channel: [
        'result',
        'coverage',
        'ledger_index',
        'close_time',
        'payment_channel',
        'history',
        'history_marker',
      ],
    });
    expect(HISTORY_BODY_KEYS).toEqual([
      'result',
      'coverage',
      'ledger_index',
      'close_time',
      'count',
      'marker',
      'history',
    ]);
    expect(DELEGATIONS_BODY_KEYS).toEqual([
      'result',
      'coverage',
      'ledger_index',
      'close_time',
      'count',
      'marker',
      'delegations',
    ]);
  });
});

describe('objects', () => {
  it('writes each object, event, delegation and body in its *_KEYS order, absent keys left out, never null', () => {
    // an escrow with every key: a conditional token escrow, finished with a fulfillment
    const created = row({
      fields: { Account: ALICE, Sequence: 46_118_302 },
      event_fields: { sequence: 46_118_302 },
    });
    const finished = row({
      ledger_index: 107_731_020,
      tx_hash: HASH(2),
      close_time: Date.UTC(2026, 9, 27, 9, 15, 2) / 1000,
      tx_type: 'EscrowFinish',
      action: 'deleted',
      event: 'finish',
      fields: {
        Account: ALICE,
        Amount: { currency: HEX_CURRENCY, issuer: ISSUER, value: '3285' },
        CancelAfter: ripple(T + 1000),
        Condition: 'A0258020' + '49'.repeat(32) + '810100',
        Destination: BOB,
        DestinationTag: 30_418,
        FinishAfter: ripple(T - 1000),
        Sequence: 46_118_302,
        SourceTag: 7,
        TransferRate: 1_005_000_000,
      },
      event_fields: { fulfillment: 'A0228020' + '11'.repeat(32) },
    });
    const escrow = escrowObject(finished, created, T, 'XRP');
    expect(Object.keys(escrow)).toEqual([...ESCROW_KEYS]);
    expect(Object.keys(escrow.created ?? {})).toEqual([...OBJECT_REF_KEYS]);
    expect(Object.keys(escrow.removed ?? {})).toEqual([...REMOVED_KEYS]);

    // the same escrow, pending and with the least a node has: the keys it has no value for are not there
    const bare = escrowObject(
      row({ fields: { Account: ALICE, Amount: '1000000000', Destination: BOB, Sequence: 5 } }),
      undefined,
      T,
      'XRP',
    );
    expect(Object.keys(bare)).toEqual(['escrow_id', 'account', 'sequence', 'destination', 'amount', 'status']);

    // a check with every key: cashed
    const checkCreated = row({ object_type: 'Check', tx_type: 'CheckCreate', event_fields: { sequence: 991_203 } });
    const cashed = row({
      object_type: 'Check',
      ledger_index: 107_731_020,
      tx_hash: HASH(2),
      tx_type: 'CheckCash',
      action: 'deleted',
      event: 'cash',
      fields: {
        Account: ALICE,
        Destination: BOB,
        DestinationTag: 88_231,
        Expiration: ripple(T + 5000),
        InvoiceID: HASH(9),
        Sequence: 991_203,
        SendMax: { currency: HEX_CURRENCY, issuer: ISSUER, value: '2500' },
        SourceTag: 1,
      },
      event_fields: { delivered: { currency: HEX_CURRENCY, issuer: ISSUER, value: '2180.4' } },
    });
    const check = checkObject(cashed, checkCreated, T, 'XRP');
    expect(Object.keys(check)).toEqual([...CHECK_KEYS]);
    expect(
      Object.keys(checkObject(row({ object_type: 'Check', fields: { SendMax: '5' } }), undefined, T, 'XRP')),
    ).toEqual(['check_id', 'account', 'destination', 'send_max', 'status']);

    // a payment channel with every key: closed
    const channelCreated = row({
      object_type: 'PayChannel',
      tx_type: 'PaymentChannelCreate',
      fields: { Account: ALICE, Amount: '1000000', Destination: BOB },
      event_fields: { sequence: 61_531_741 },
    });
    const closed = row({
      object_type: 'PayChannel',
      ledger_index: 107_731_020,
      tx_hash: HASH(2),
      tx_type: 'PaymentChannelClaim',
      action: 'deleted',
      event: 'close',
      fields: {
        Account: ALICE,
        Amount: '1000000',
        Balance: '32185',
        CancelAfter: ripple(T + 9000),
        Destination: BOB,
        DestinationTag: 4,
        Expiration: ripple(T + 100),
        PublicKey: 'ED' + 'D5'.repeat(32),
        Sequence: 61_531_741,
        SettleDelay: 1_209_600,
        SourceTag: 5,
      },
    });
    const channel = paymentChannelObject(closed, channelCreated, { funds: 2, claims: 3 }, T, 'XRP');
    expect(Object.keys(channel)).toEqual([...PAYMENT_CHANNEL_KEYS]);

    // events: the common keys, then the type's, in order, with the delegate when the transaction had one
    const delegated = (o: Partial<ObjectRead>) => row({ delegate: CAROL, ...o });
    const events: [keyof typeof EVENT_EXTRA_KEYS, ObjectRead][] = [
      ['escrow', delegated({ fields: { Amount: '5' } })],
      ['escrow', delegated({ action: 'deleted', event: 'finish', event_fields: { fulfillment: 'A0' } })],
      [
        'check',
        delegated({
          object_type: 'Check',
          fields: { SendMax: '5', Expiration: ripple(T) },
          event_fields: { sequence: 1 },
        }),
      ],
      [
        'check',
        delegated({ object_type: 'Check', action: 'deleted', event: 'cash', event_fields: { delivered: '5' } }),
      ],
      [
        'payment_channel',
        delegated({
          object_type: 'PayChannel',
          action: 'modified',
          event: 'fund',
          fields: { Amount: '5000002', Balance: '5000000', Expiration: ripple(T), SettleDelay: 60 },
          previous: { Amount: '5000001', Balance: '1' },
        }),
      ],
      [
        'payment_channel',
        delegated({
          object_type: 'PayChannel',
          fields: { Amount: '5000002', Expiration: ripple(T), SettleDelay: 60 },
        }),
      ],
    ];
    for (const [kind, source] of events) {
      const event = objectEvent(source, 'XRP');
      expectOrdered(event as unknown as Obj, [...EVENT_KEYS, ...EVENT_EXTRA_KEYS[kind]]);
      expect(Object.keys(event).slice(0, 8)).toEqual([...EVENT_KEYS]);
    }
    // an event with the least it has: the delegate is left out
    expect(Object.keys(objectEvent(row({ action: 'deleted', event: 'cancel' }), 'XRP'))).toEqual([
      'event',
      'ledger_index',
      'time',
      'tx_hash',
      'tx_type',
      'account',
      'result',
    ]);

    // a delegation with every key
    const delegationCreated = row({ object_type: 'Delegate', event: 'set', tx_type: 'DelegateSet' });
    const delegation = delegationObject(
      row({
        object_type: 'Delegate',
        event: 'set',
        action: 'modified',
        ledger_index: 107_690_822,
        tx_hash: HASH(3),
        fields: { Account: ALICE, Authorize: BOB, Permissions: [{ Permission: { PermissionValue: 'Payment' } }] },
      }),
      delegationCreated,
      { Payment: 0 },
    );
    expect(Object.keys(delegation)).toEqual([...DELEGATION_KEYS]);
    expect(Object.keys(delegation.permissions[0])).toEqual(['permission', 'kind']);
    expect(Object.keys(delegation.updated)).toEqual([...OBJECT_REF_KEYS]);

    // nothing is null, whichever the object
    for (const answer of [escrow, bare, check, channel, delegation, ...events.map(([, r]) => objectEvent(r, 'XRP'))]) {
      expect(JSON.stringify(answer)).not.toContain('null');
      expect(JSON.stringify(answer)).not.toContain('undefined');
    }
  });

  it('writes the account and destination of the row, the amount in whole units and a node time as ISO UTC', () => {
    const escrow = escrowObject(
      row({
        fields: { Account: ALICE, Amount: '1000000000', Destination: BOB, FinishAfter: ripple(T + 60), Sequence: 5 },
      }),
      undefined,
      T,
      'XRP',
    );
    expect(escrow).toEqual({
      escrow_id: OBJECT_ID,
      account: ALICE,
      sequence: 5,
      destination: BOB,
      amount: { currency: 'XRP', value: '1000' },
      finish_after: '2026-10-24T09:31:00Z',
      status: 'pending',
    });
  });

  it('takes an escrow, a check and a channel from the newest row, and the removal from it only when it deleted the object', () => {
    const finished = row({
      ledger_index: 107_731_020,
      tx_hash: HASH(2),
      close_time: Date.UTC(2026, 9, 27, 9, 15, 2) / 1000,
      tx_type: 'EscrowFinish',
      action: 'deleted',
      event: 'finish',
      fields: { Account: ALICE, Amount: '1000000', Destination: BOB, Sequence: 5 },
      event_fields: { fulfillment: 'A0228020AA' },
    });
    const finish = escrowObject(finished, row({ event_fields: { sequence: 5 } }), T, 'XRP');
    expect(finish.status).toBe('finished');
    expect(finish.fulfillment).toBe('A0228020AA');
    expect(finish.created).toEqual(CREATED_REF);
    expect(finish.removed).toEqual({
      ledger_index: 107_731_020,
      time: '2026-10-27T09:15:02Z',
      tx_hash: HASH(2),
      tx_type: 'EscrowFinish',
    });

    // a modified row is not a removal, and carries no fulfillment even if its event facts had one
    const open = escrowObject(
      row({ action: 'modified', event: 'update', event_fields: { fulfillment: 'A0' }, fields: { Amount: '1' } }),
      undefined,
      T,
      'XRP',
    );
    expect(open).not.toHaveProperty('removed');
    expect(open).not.toHaveProperty('fulfillment');
    expect(open).not.toHaveProperty('created');

    // the status of the deleting event: cancelled and removed, whatever the times
    const statuses = ['cancel', 'removed'].map(
      (event) => escrowObject(row({ action: 'deleted', event, fields: { Amount: '1' } }), undefined, T, 'XRP').status,
    );
    expect(statuses).toEqual(['cancelled', 'removed']);
  });

  it('evaluates the status at the close time of the answer, on Ripple-epoch fields', () => {
    const escrowAt = (t: number, f: Obj) => escrowObject(row({ fields: f }), undefined, t, 'XRP').status;
    const window = { Amount: '1', FinishAfter: ripple(2000), CancelAfter: ripple(3000) };
    expect([1999, 2000, 2001, 3000, 3001].map((t) => escrowAt(t, window))).toEqual([
      'pending',
      'pending',
      'can_be_finished',
      'can_be_finished',
      'can_be_cancelled',
    ]);

    const checkAt = (t: number) =>
      checkObject(
        row({ object_type: 'Check', fields: { SendMax: '1', Expiration: ripple(2000) } }),
        undefined,
        t,
        'XRP',
      ).status;
    expect([1999, 2000].map(checkAt)).toEqual(['open', 'expired']);

    const channelAt = (t: number, f: Obj) =>
      paymentChannelObject(
        row({ object_type: 'PayChannel', fields: { Amount: '1', ...f } }),
        undefined,
        { funds: 0, claims: 0 },
        t,
        'XRP',
      ).status;
    expect([channelAt(1, {}), channelAt(1, { Expiration: ripple(9_999_999_999) })]).toEqual(['open', 'closing']);
    expect([1999, 2000].map((t) => channelAt(t, { CancelAfter: ripple(2000) }))).toEqual(['open', 'closing']);
  });

  it("takes a ticketed escrow's sequence from its created row", () => {
    // the node has no Sequence (the escrow was created with a ticket): the creating event's sequence is the ticket's
    const newest = row({
      action: 'deleted',
      event: 'cancel',
      fields: { Account: ALICE, Amount: '1', Destination: BOB },
    });
    const created = row({ event_fields: { sequence: 107_896_555 } });
    expect(escrowObject(newest, created, T, 'XRP').sequence).toBe(107_896_555);

    // the node's own Sequence comes first, and with neither the key is left out
    const own = row({ fields: { Sequence: 12 } });
    expect(escrowObject(own, created, T, 'XRP').sequence).toBe(12);
    expect(escrowObject(newest, undefined, T, 'XRP')).not.toHaveProperty('sequence');
    expect(escrowObject(newest, row({}), T, 'XRP')).not.toHaveProperty('sequence');
  });

  it('writes a check with its amounts, expiration and invoice as on the ledger, and delivered from the cashing row', () => {
    const cashed = row({
      object_type: 'Check',
      tx_type: 'CheckCash',
      action: 'deleted',
      event: 'cash',
      fields: {
        Account: ALICE,
        Destination: BOB,
        Expiration: ripple(Date.UTC(2026, 10, 30, 12, 0, 0) / 1000),
        InvoiceID: '6F2A' + '00'.repeat(30),
        Sequence: 991_203,
        SendMax: { currency: HEX_CURRENCY, issuer: ISSUER, value: '2500' },
      },
      event_fields: { delivered: { currency: HEX_CURRENCY, issuer: ISSUER, value: '2180.4' } },
    });
    const check = checkObject(cashed, undefined, T, 'XRP');
    expect(check).toMatchObject({
      check_id: OBJECT_ID,
      send_max: { currency: HEX_CURRENCY, issuer: ISSUER, value: '2500' },
      expiration: '2026-11-30T12:00:00Z',
      invoice_id: '6F2A' + '00'.repeat(30),
      delivered: { currency: HEX_CURRENCY, issuer: ISSUER, value: '2180.4' },
      status: 'cashed',
    });

    // an XRP cash delivers drops
    const xrp = checkObject(
      row({
        object_type: 'Check',
        action: 'deleted',
        event: 'cash',
        fields: { SendMax: '2000000000' },
        event_fields: { delivered: '933622827' },
      }),
      undefined,
      T,
      'XRP',
    );
    expect(xrp.send_max).toEqual({ currency: 'XRP', value: '2000' });
    expect(xrp.delivered).toEqual({ currency: 'XRP', value: '933.622827' });

    // a check that is still in the ledger has delivered nothing
    expect(
      checkObject(row({ object_type: 'Check', fields: { SendMax: '1' } }), undefined, T, 'XRP'),
    ).not.toHaveProperty('delivered');
  });

  it('writes a channel from the newest row, its deposit from the created row and its counts as given', () => {
    const created = row({
      object_type: 'PayChannel',
      tx_type: 'PaymentChannelCreate',
      fields: { Amount: '1000000' },
      event_fields: { sequence: 61_531_741 },
    });
    const newest = row({
      object_type: 'PayChannel',
      ledger_index: 107_641_123,
      tx_hash: HASH(2),
      tx_type: 'PaymentChannelClaim',
      action: 'modified',
      event: 'claim',
      fields: {
        Account: ALICE,
        Amount: '2500000',
        Balance: '32185',
        Destination: BOB,
        PublicKey: '03D63CA73239D94AAF52574A20E3BC26CBDB811CA55A5914FAA28836F079CE0DC3',
        SettleDelay: 1_209_600,
        DestinationTag: 0,
      },
      previous: { Balance: '0' },
    });
    expect(paymentChannelObject(newest, created, { funds: 1, claims: 4 }, T, 'XRP')).toEqual({
      channel_id: OBJECT_ID,
      account: ALICE,
      sequence: 61_531_741,
      destination: BOB,
      amount: { currency: 'XRP', value: '2.5' },
      balance: { currency: 'XRP', value: '0.032185' },
      remaining: { currency: 'XRP', value: '2.467815' },
      settle_delay: 1_209_600,
      public_key: '03D63CA73239D94AAF52574A20E3BC26CBDB811CA55A5914FAA28836F079CE0DC3',
      destination_tag: 0,
      status: 'open',
      opened_with: { currency: 'XRP', value: '1' },
      funds: 1,
      claims: 4,
      created: { ledger_index: 107_684_512, time: '2026-10-15T08:44:19Z', tx_hash: HASH(1) },
    });
    // the creation is not indexed: no deposit, no created, no sequence (the node has none)
    const old = paymentChannelObject(newest, undefined, { funds: 0, claims: 0 }, T, 'XRP');
    expect(old).not.toHaveProperty('opened_with');
    expect(old).not.toHaveProperty('created');
    expect(old).not.toHaveProperty('sequence');
  });
});

describe('amounts', () => {
  it('converts drops to whole units and keeps an issued-token value and a hex currency code as on the ledger', () => {
    expect(objectAmount('1000000', 'XRP')).toEqual({ currency: 'XRP', value: '1' });
    expect(objectAmount('1', 'XRP')).toEqual({ currency: 'XRP', value: '0.000001' });
    expect(objectAmount('0', 'XRP')).toEqual({ currency: 'XRP', value: '0' });
    expect(objectAmount('933622827', 'XAH')).toEqual({ currency: 'XAH', value: '933.622827' });
    // a native amount has no issuer key at all
    expect(Object.keys(objectAmount('5', 'XRP') ?? {})).toEqual(['currency', 'value']);

    // an issued token: the value is the ledger's text, even in the exponent form it sometimes has, and the code as it is
    const token = { currency: HEX_CURRENCY, issuer: ISSUER, value: '1000000000000000e-4' };
    expect(objectAmount(token, 'XRP')).toEqual(token);
    expect(Object.keys(objectAmount(token, 'XRP') ?? {})).toEqual(['currency', 'issuer', 'value']);
    expect(objectAmount({ currency: 'USD', issuer: ISSUER, value: '0.438027' }, 'XRP')).toEqual({
      currency: 'USD',
      issuer: ISSUER,
      value: '0.438027',
    });
    // not the same object: the answer owns what it writes
    expect(objectAmount(token, 'XRP')).not.toBe(token);
  });

  it('gives no amount for what is not one', () => {
    for (const raw of [
      undefined,
      null,
      '',
      'abc',
      '1.5',
      '-1',
      5,
      true,
      [],
      {},
      { currency: 'USD', value: '1' },
      { value: '1' },
    ]) {
      expect(objectAmount(raw, 'XRP')).toBeUndefined();
    }
    expect(objectAmount({ mpt_issuance_id: 'XYZ', value: '1' }, 'XRP')).toBeUndefined();
    expect(objectAmount({ mpt_issuance_id: MPT_ID }, 'XRP')).toBeUndefined();
  });

  it('writes an MPT amount as the MPT amount object', () => {
    const expected = { currency: MPT_ID, issuer: MPT_ISSUER, value: '2500000', mpt_issuance_id: MPT_ID };
    expect(objectAmount({ mpt_issuance_id: MPT_ID, value: '2500000' }, 'XRP')).toEqual(expected);
    // the ID in lower case is answered in upper case, and the value is never scaled
    expect(objectAmount({ mpt_issuance_id: MPT_ID.toLowerCase(), value: '2500000' }, 'XRP')).toEqual(expected);
    expect(Object.keys(objectAmount({ mpt_issuance_id: MPT_ID, value: '1' }, 'XRP') ?? {})).toEqual([
      'currency',
      'issuer',
      'value',
      'mpt_issuance_id',
    ]);
  });

  it('writes the amounts of an MPT escrow', () => {
    const escrow = escrowObject(
      row({ fields: { Account: ALICE, Amount: { mpt_issuance_id: MPT_ID, value: '75' }, Destination: BOB } }),
      undefined,
      T,
      'XRP',
    );
    expect(escrow.amount).toEqual({ currency: MPT_ID, issuer: MPT_ISSUER, value: '75', mpt_issuance_id: MPT_ID });
    const event = objectEvent(row({ fields: { Amount: { mpt_issuance_id: MPT_ID, value: '75' } } }), 'XRP');
    expect(event.amount).toEqual(escrow.amount);
  });
});

describe('times', () => {
  it('writes Ripple-epoch times as ISO UTC', () => {
    expect(rippleIso(814_567_890)).toBe('2025-10-23T20:51:30Z');
    expect(rippleIso(0)).toBe('2000-01-01T00:00:00Z');
    const escrow = escrowObject(
      row({ fields: { Amount: '1', FinishAfter: 814_567_890, CancelAfter: 814_567_891 } }),
      undefined,
      T,
      'XRP',
    );
    expect([escrow.finish_after, escrow.cancel_after]).toEqual(['2025-10-23T20:51:30Z', '2025-10-23T20:51:31Z']);
  });

  it('writes the time of a row as its close time in unix seconds', () => {
    const event = objectEvent(row({ close_time: Date.UTC(2026, 9, 15, 8, 44, 19) / 1000 }), 'XRP');
    expect(event.time).toBe('2026-10-15T08:44:19Z');
  });
});

describe('payment channels', () => {
  const channel = (fields: Obj, newest: Partial<ObjectRead> = {}, native = 'XRP') =>
    paymentChannelObject(
      row({ object_type: 'PayChannel', fields: { Account: ALICE, Destination: BOB, ...fields }, ...newest }),
      undefined,
      { funds: 0, claims: 0 },
      T,
      native,
    );

  it("gives a channel zero balance before its first claim, and remaining in the channel's currency", () => {
    // XRP: a created node omits a zero Balance (XRPL), or writes it (Xahau)
    const omitted = channel({ Amount: '1000000' });
    expect(omitted.balance).toEqual({ currency: 'XRP', value: '0' });
    expect(omitted.remaining).toEqual({ currency: 'XRP', value: '1' });
    const written = channel({ Amount: '1000000', Balance: '0' }, {}, 'XAH');
    expect(written.balance).toEqual({ currency: 'XAH', value: '0' });
    expect(written.remaining).toEqual({ currency: 'XAH', value: '1' });

    // an issued token (Xahau): the balance and the remainder are in the token, with its issuer
    const amount = { currency: HEX_CURRENCY, issuer: ISSUER, value: '25.5' };
    const token = channel({ Amount: amount });
    expect(token.balance).toEqual({ currency: HEX_CURRENCY, issuer: ISSUER, value: '0' });
    expect(token.remaining).toEqual(amount);
    expect(Object.keys(token.remaining ?? {})).toEqual(['currency', 'issuer', 'value']);

    // an MPT keeps its issuance ID
    const mpt = channel({ Amount: { mpt_issuance_id: MPT_ID, value: '10' } });
    expect(mpt.balance).toEqual({ currency: MPT_ID, issuer: MPT_ISSUER, value: '0', mpt_issuance_id: MPT_ID });
    expect(mpt.remaining?.value).toBe('10');
  });

  it('subtracts exactly, in plain decimals', () => {
    const afterClaim = channel({
      Amount: { currency: HEX_CURRENCY, issuer: ISSUER, value: '25.5' },
      Balance: { currency: HEX_CURRENCY, issuer: ISSUER, value: '10.25' },
    });
    expect(afterClaim.balance).toEqual({ currency: HEX_CURRENCY, issuer: ISSUER, value: '10.25' });
    expect(afterClaim.remaining).toEqual({ currency: HEX_CURRENCY, issuer: ISSUER, value: '15.25' });

    // the ledger's exponent form is read, and what is computed has none
    const exponent = channel({
      Amount: { currency: 'USD', issuer: ISSUER, value: '1000000000000000e-4' },
      Balance: { currency: 'USD', issuer: ISSUER, value: '1e-4' },
    });
    expect(exponent.amount?.value).toBe('1000000000000000e-4');
    expect(exponent.balance?.value).toBe('1e-4');
    expect(exponent.remaining?.value).toBe('99999999999.9999');

    // a channel whose whole deposit was paid out has nothing left
    expect(channel({ Amount: '5000000', Balance: '5000000' }).remaining).toEqual({ currency: 'XRP', value: '0' });
  });

  it('leaves out amount, balance and remaining when the node has no Amount, and never invents a balance for a bad one', () => {
    const none = channel({});
    expect(none).not.toHaveProperty('amount');
    expect(none).not.toHaveProperty('balance');
    expect(none).not.toHaveProperty('remaining');
    const bad = channel({ Amount: '1000000', Balance: 'oops' });
    expect(bad).not.toHaveProperty('balance');
    expect(bad).not.toHaveProperty('remaining');
  });

  it('gives a channel event amount_change and balance_change only when not zero', () => {
    const event = (o: Partial<ObjectRead>) => objectEvent(row({ object_type: 'PayChannel', ...o }), 'XRP');

    // a fund: the amount rose by a drop, the balance did not move (it is not in previous)
    const fund = event({
      action: 'modified',
      event: 'fund',
      tx_type: 'PaymentChannelFund',
      fields: { Amount: '5000002', Balance: '5000000', Expiration: 844_841_098 },
      previous: { Amount: '5000001' },
    });
    expect(fund).toMatchObject({
      event: 'fund',
      amount: { currency: 'XRP', value: '5.000002' },
      balance: { currency: 'XRP', value: '5' },
      amount_change: { currency: 'XRP', value: '0.000001' },
      expiration: '2026-10-09T06:04:58Z',
    });
    expect(fund).not.toHaveProperty('balance_change');
    expect(fund).not.toHaveProperty('settle_delay');

    // the first claim: previous has Balance "0" (XRPL does not write a zero), the balance rose
    const claim = event({
      action: 'modified',
      event: 'claim',
      tx_type: 'PaymentChannelClaim',
      fields: { Amount: '1000000', Balance: '32185' },
      previous: { Balance: '0' },
    });
    expect(claim.balance_change).toEqual({ currency: 'XRP', value: '0.032185' });
    expect(claim).not.toHaveProperty('amount_change');
    expect(claim).not.toHaveProperty('expiration');

    // previous names a field whose value did not change: no change is written
    const same = event({
      action: 'modified',
      event: 'update',
      fields: { Amount: '1000000', Balance: '5' },
      previous: { Amount: '1000000', Balance: '5' },
    });
    expect(same).not.toHaveProperty('amount_change');
    expect(same).not.toHaveProperty('balance_change');

    // a token channel: the changes are in the token
    const token = event({
      action: 'modified',
      event: 'claim',
      fields: {
        Amount: { currency: HEX_CURRENCY, issuer: ISSUER, value: '25.5' },
        Balance: { currency: HEX_CURRENCY, issuer: ISSUER, value: '10.25' },
      },
      previous: { Balance: { currency: HEX_CURRENCY, issuer: ISSUER, value: '4.5' } },
    });
    expect(token.balance_change).toEqual({ currency: HEX_CURRENCY, issuer: ISSUER, value: '5.75' });
    expect(token.balance).toEqual({ currency: HEX_CURRENCY, issuer: ISSUER, value: '10.25' });

    // a drop in the balance is negative
    const down = event({
      action: 'modified',
      event: 'update',
      fields: { Amount: '9', Balance: '2' },
      previous: { Balance: '5' },
    });
    expect(down.balance_change).toEqual({ currency: 'XRP', value: '-0.000003' });
  });

  it('gives a channel event the amount and balance after it, the expiration after it, and settle_delay on create', () => {
    const created = objectEvent(
      row({
        object_type: 'PayChannel',
        tx_type: 'PaymentChannelCreate',
        fields: { Amount: '1000000', SettleDelay: 1_209_600 },
      }),
      'XRP',
    );
    expect(created).toMatchObject({
      event: 'create',
      amount: { currency: 'XRP', value: '1' },
      balance: { currency: 'XRP', value: '0' },
      settle_delay: 1_209_600,
    });
    expect(created).not.toHaveProperty('expiration');
    expect(created).not.toHaveProperty('amount_change');

    // a later row of the channel does not repeat the settle delay
    const claim = objectEvent(
      row({
        object_type: 'PayChannel',
        action: 'modified',
        event: 'claim',
        fields: { Amount: '1000000', Balance: '1', SettleDelay: 1_209_600 },
        previous: { Balance: '0' },
      }),
      'XRP',
    );
    expect(claim).not.toHaveProperty('settle_delay');
  });
});

describe('events', () => {
  it('names the transaction, its sender as account, and the delegate when there is one', () => {
    const plain = objectEvent(row({ fields: { Amount: '1000000000' } }), 'XRP');
    expect(plain).toEqual({
      event: 'create',
      ledger_index: 107_684_512,
      time: '2026-10-15T08:44:19Z',
      tx_hash: HASH(1),
      tx_type: 'EscrowCreate',
      account: ALICE,
      result: 'tesSUCCESS',
      amount: { currency: 'XRP', value: '1000' },
    });
    const delegated = objectEvent(row({ delegate: CAROL, result: 'tecNO_PERMISSION' }), 'XRP');
    expect(delegated).toMatchObject({ account: ALICE, delegate: CAROL, result: 'tecNO_PERMISSION' });
  });

  it('adds amount on an escrow create and fulfillment on a finish, and nothing on a cancel', () => {
    const create = objectEvent(row({ fields: { Amount: '5000000' } }), 'XRP');
    expect(create.amount).toEqual({ currency: 'XRP', value: '5' });
    expect(create).not.toHaveProperty('fulfillment');

    const finish = objectEvent(
      row({
        action: 'deleted',
        event: 'finish',
        tx_type: 'EscrowFinish',
        fields: { Amount: '5000000' },
        event_fields: { fulfillment: 'A0228020AA' },
      }),
      'XRP',
    );
    expect(finish.fulfillment).toBe('A0228020AA');
    expect(finish).not.toHaveProperty('amount');

    // a finish with no Fulfillment (an unconditional escrow) has none
    const timed = objectEvent(
      row({ action: 'deleted', event: 'finish', tx_type: 'EscrowFinish', fields: { Amount: '1' } }),
      'XRP',
    );
    expect(timed).not.toHaveProperty('fulfillment');
    const cancel = objectEvent(
      row({ action: 'deleted', event: 'cancel', tx_type: 'EscrowCancel', fields: { Amount: '1' } }),
      'XRP',
    );
    expect(cancel).not.toHaveProperty('amount');
    expect(cancel).not.toHaveProperty('fulfillment');
  });

  it('adds send_max and expiration on a check create and delivered on a cash', () => {
    const create = objectEvent(
      row({
        object_type: 'Check',
        tx_type: 'CheckCreate',
        fields: { SendMax: { currency: 'USD', issuer: ISSUER, value: '2500' }, Expiration: 814_567_890 },
        event_fields: { sequence: 3 },
      }),
      'XRP',
    );
    expect(create).toMatchObject({
      send_max: { currency: 'USD', issuer: ISSUER, value: '2500' },
      expiration: '2025-10-23T20:51:30Z',
    });
    expect(create).not.toHaveProperty('delivered');

    const cash = objectEvent(
      row({
        object_type: 'Check',
        action: 'deleted',
        event: 'cash',
        tx_type: 'CheckCash',
        fields: { SendMax: '2000000000', Expiration: 814_567_890 },
        event_fields: { delivered: '933622827' },
      }),
      'XRP',
    );
    expect(cash.delivered).toEqual({ currency: 'XRP', value: '933.622827' });
    expect(cash).not.toHaveProperty('send_max');
    expect(cash).not.toHaveProperty('expiration');
  });

  it('adds nothing to a delegation row', () => {
    const event = objectEvent(row({ object_type: 'Delegate', event: 'set', tx_type: 'DelegateSet' }), 'XRP');
    expect(Object.keys(event)).toEqual(['event', 'ledger_index', 'time', 'tx_hash', 'tx_type', 'account', 'result']);
  });
});

describe('delegations', () => {
  const TYPES = { Payment: 0, OfferCreate: 7, OfferCancel: 8 };

  it('maps permissions, an unknown value as its number', () => {
    const newest = row({
      object_type: 'Delegate',
      event: 'set',
      action: 'modified',
      tx_type: 'DelegateSet',
      ledger_index: 107_690_822,
      tx_hash: HASH(3),
      close_time: Date.UTC(2026, 9, 14, 16, 3, 22) / 1000,
      object_id: 'C07D' + '00'.repeat(30),
      fields: {
        Account: ALICE,
        Authorize: BOB,
        Permissions: [
          { Permission: { PermissionValue: 'OfferCreate' } },
          { Permission: { PermissionValue: 'TrustlineAuthorize' } },
          { Permission: { PermissionValue: 1 } },
          { Permission: { PermissionValue: 70_000 } },
          { Permission: { PermissionValue: '65547' } },
        ],
      },
    });
    const created = row({
      object_type: 'Delegate',
      event: 'set',
      tx_type: 'DelegateSet',
      ledger_index: 107_601_140,
      tx_hash: HASH(4),
      close_time: Date.UTC(2026, 9, 10, 11, 20, 5) / 1000,
    });
    const delegation = delegationObject(newest, created, TYPES);
    expect(delegation).toEqual({
      delegation_id: 'C07D' + '00'.repeat(30),
      account: ALICE,
      authorize: BOB,
      permissions: [
        { permission: 'OfferCreate', kind: 'transaction' },
        { permission: 'TrustlineAuthorize', kind: 'granular', transaction_type: 'TrustSet' },
        { permission: 'Payment', kind: 'transaction' },
        { permission: '70000', kind: 'unknown' },
        { permission: 'MPTokenIssuanceLock', kind: 'granular', transaction_type: 'MPTokenIssuanceSet' },
      ],
      updated: { ledger_index: 107_690_822, time: '2026-10-14T16:03:22Z', tx_hash: HASH(3) },
      created: { ledger_index: 107_601_140, time: '2026-10-10T11:20:05Z', tx_hash: HASH(4) },
    });
    for (const permission of delegation.permissions) expectOrdered(permission as unknown as Obj, PERMISSION_KEYS);
  });

  it('leaves out created when the creation is not indexed, and has no permissions for a node with none', () => {
    const newest = row({ object_type: 'Delegate', event: 'set', fields: { Account: ALICE, Authorize: BOB } });
    const delegation = delegationObject(newest, undefined, TYPES);
    expect(delegation).not.toHaveProperty('created');
    expect(delegation.permissions).toEqual([]);
    expect(delegation.updated).toEqual(CREATED_REF);
  });

  it('skips an entry that has no PermissionValue rather than inventing a permission', () => {
    const newest = row({
      object_type: 'Delegate',
      event: 'set',
      fields: { Permissions: [{ Permission: {} }, {}, { Permission: { PermissionValue: 'Payment' } }] },
    });
    expect(delegationObject(newest, undefined, TYPES).permissions).toEqual([
      { permission: 'Payment', kind: 'transaction' },
    ]);
  });
});

describe('CSV rows', () => {
  const column = (kind: keyof typeof EVENT_EXTRA_KEYS): string[] => EVENT_CSV_COLUMNS[kind];

  it("give an event of any kind the same columns: EVENT_KEYS, then the type's, amounts flattened", () => {
    expect(column('escrow')).toEqual([
      ...EVENT_KEYS,
      'amount.currency',
      'amount.issuer',
      'amount.value',
      'amount.mpt_issuance_id',
      'fulfillment',
    ]);
    expect(column('check')).toEqual([
      ...EVENT_KEYS,
      'send_max.currency',
      'send_max.issuer',
      'send_max.value',
      'send_max.mpt_issuance_id',
      'expiration',
      'delivered.currency',
      'delivered.issuer',
      'delivered.value',
      'delivered.mpt_issuance_id',
    ]);
    expect(column('payment_channel')).toEqual([
      ...EVENT_KEYS,
      ...['amount', 'balance', 'amount_change', 'balance_change'].flatMap((k) => AMOUNT_KEYS.map((a) => `${k}.${a}`)),
      'expiration',
      'settle_delay',
    ]);
  });

  it('writes every column of the kind, null where the event has none, whatever the event', () => {
    const create = objectEvent(row({ fields: { Amount: '1000000' } }), 'XRP');
    const finish = objectEvent(
      row({ action: 'deleted', event: 'finish', delegate: CAROL, event_fields: { fulfillment: 'A0' } }),
      'XRP',
    );
    const a = objectEventCsvRow(create, 'escrow');
    const b = objectEventCsvRow(finish, 'escrow');
    expect(Object.keys(a)).toEqual(column('escrow'));
    expect(Object.keys(b)).toEqual(column('escrow'));
    expect(a).toMatchObject({
      event: 'create',
      account: ALICE,
      delegate: null,
      'amount.currency': 'XRP',
      'amount.issuer': null,
      'amount.value': '1',
      'amount.mpt_issuance_id': null,
      fulfillment: null,
    });
    expect(b).toMatchObject({ event: 'finish', delegate: CAROL, 'amount.value': null, fulfillment: 'A0' });
  });

  it("writes a token and an MPT amount in the columns of the kind's amounts", () => {
    const token = objectEventCsvRow(
      objectEvent(
        row({
          object_type: 'PayChannel',
          action: 'modified',
          event: 'claim',
          fields: {
            Amount: { currency: HEX_CURRENCY, issuer: ISSUER, value: '25.5' },
            Balance: { currency: HEX_CURRENCY, issuer: ISSUER, value: '10.25' },
          },
          previous: { Balance: { currency: HEX_CURRENCY, issuer: ISSUER, value: '4.5' } },
        }),
        'XRP',
      ),
      'payment_channel',
    );
    expect(token).toMatchObject({
      'amount.currency': HEX_CURRENCY,
      'amount.issuer': ISSUER,
      'amount.value': '25.5',
      'balance_change.value': '5.75',
      'amount_change.value': null,
      expiration: null,
      settle_delay: null,
    });
    const mpt = objectEventCsvRow(
      objectEvent(row({ fields: { Amount: { mpt_issuance_id: MPT_ID, value: '75' } } }), 'XRP'),
      'escrow',
    );
    expect(mpt).toMatchObject({
      'amount.currency': MPT_ID,
      'amount.issuer': MPT_ISSUER,
      'amount.value': '75',
      'amount.mpt_issuance_id': MPT_ID,
    });
  });

  it('writes a delegation with its permission names in one cell, separated by a space', () => {
    expect(DELEGATION_CSV_COLUMNS).toEqual([
      'delegation_id',
      'account',
      'authorize',
      'permissions',
      'updated.ledger_index',
      'updated.time',
      'updated.tx_hash',
      'created.ledger_index',
      'created.time',
      'created.tx_hash',
    ]);
    const newest = row({
      object_type: 'Delegate',
      event: 'set',
      action: 'modified',
      fields: {
        Account: ALICE,
        Authorize: BOB,
        Permissions: [
          { Permission: { PermissionValue: 'Payment' } },
          { Permission: { PermissionValue: 'TrustlineAuthorize' } },
        ],
      },
    });
    const csv = delegationCsvRow(delegationObject(newest, row({ ledger_index: 107_601_140 }), { Payment: 0 }));
    expect(Object.keys(csv)).toEqual(DELEGATION_CSV_COLUMNS);
    expect(csv).toMatchObject({
      account: ALICE,
      authorize: BOB,
      permissions: 'Payment TrustlineAuthorize',
      'updated.ledger_index': 107_684_512,
      'created.ledger_index': 107_601_140,
    });
    // a delegation whose creation is not indexed has empty created columns, the same columns
    const old = delegationCsvRow(delegationObject(newest, undefined, { Payment: 0 }));
    expect(Object.keys(old)).toEqual(DELEGATION_CSV_COLUMNS);
    expect(old).toMatchObject({ 'created.ledger_index': null, 'created.time': null, 'created.tx_hash': null });
  });
});
