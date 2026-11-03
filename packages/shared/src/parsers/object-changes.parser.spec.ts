/**
 * ObjectChangesParser over the recorded escrow, check, payment channel and delegation cases (`test/fixtures/{xrpl,xahau}/objects`,
 * `FINDINGS.md` next to them), over every transaction of every recorded set, and over the synthetic cases below. A synthetic
 * case is hand-made, never recorded: it is built from a recorded transaction by a small, named edit of its transaction and
 * metadata (`synthetic(...)`, its hash `syntheticHash('<name>', '<base hash>')`), because the network has none of it:
 *
 * - `synthetic-escrow-create-ticket` (xrpl `escrow_create_ticket`): `escrow_create_timed` sent with a ticket: `Sequence` 0, a
 *   `TicketSequence`, the escrow at `escrowId(owner, ticket)`.
 * - `synthetic-escrow-finish-fulfillment` (`escrow_finish_fulfillment`): `escrow_finish_timed` of a conditional escrow, with
 *   the `Fulfillment` of the empty preimage.
 * - `synthetic-escrow-create-mpt` (`escrow_create_mpt`): `escrow_create_token` with an MPT `Amount` and the sender's
 *   `MPToken` in the place of its trust line.
 * - `synthetic-check-cash-deliver-min` (`check_cash_deliver_min`): the Batch inner XRP cash `check_cash_amount` as a cash with
 *   `DeliverMin` (half of the amount) and no `Amount`, the stored `DeliveredAmount` the way `xahau/objects` `check_cash`
 *   has it. `synthetic-check-cash-delivered-{stored,served,amount,none}` pin the order of the delivered amount's sources.
 * - `synthetic-check-cancel-third-party-expired` (`check_cancel_third_party_expired`): `check_cancel_source` sent by an account
 *   that is neither party, after the check's `Expiration`.
 * - `synthetic-delegate-set-replace` and `synthetic-delegate-set-empty` (`delegate_set_replace`, `delegate_set_empty`):
 *   `delegate_set_create` as the same delegation with a new list, and as an empty list that deletes it.
 * - `synthetic-delegated-payment` and `synthetic-delegated-tec` (`delegated_payment`, `delegated_tec`): the recorded Payments
 *   of Task 5 with a `Delegate` that paid the fee; `synthetic-delegated-escrow-create`: `escrow_create_timed` the same way.
 * - `synthetic-account-delete-delegate` and `synthetic-account-delete-delegate-authorized`: the recorded AccountDelete
 *   `8F2DCA94…` that deletes the recorded delegation `rnt8Pb…` to `rw2X2G…`, as the delegating account and as the delegate
 *   (FINDINGS (3): what deletes a Delegate besides DelegateSet rests on the documentation; none was seen on the network).
 * - `synthetic-account-set-escrow-update`: a recorded AccountSet whose metadata also modifies an Escrow (no transaction does;
 *   it pins the fall-through to `update`). `synthetic-channel-threaded`: `channel_claim` whose channel was only threaded.
 * - `synthetic-escrow-create-no-sequence`: the Xahau `escrow_create` with `Sequence` 0 and no ticket.
 * - `synthetic-delegated-batch-inner-check-cash`: the Batch inner `check_cash_amount` with a `Delegate`;
 *   `synthetic-tec-channel-close-expired`: `channel_close_expired` with a tec result.
 */
import BigNumber from 'bignumber.js';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { objectOracle } from '../../test/object-oracle';
import { delegatedFrom, SYNTHETIC_DELEGATE } from '../../test/synthetic-delegated';
import { syntheticHash } from '../../test/synthetic-hash';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { RawLedger, RawTransaction } from '../ingest/raw-ledger';
import { getNetworkProfile, NETWORK_NAMES, NetworkName } from '../network';
import { deepFreeze } from '../test-utils/deep-freeze';
import { objectCase, ObjectNet } from '../test-utils/object-cases';
import { escrowId } from '../util/keylets';
import { stableStringify } from '../util/stable-json';
import { BalanceChangesParser } from './balance-changes.parser';
import {
  OBJECT_EVENTS,
  OBJECT_FIELD_EXCLUSIONS,
  ObjectChangesParser,
  ParsedObjectChange,
  TF_CLOSE,
  TF_RENEW,
  TRACKED_OBJECT_TYPES,
  TrackedObjectType,
} from './object-changes.parser';
import { ParseContext, parseContextFor, ParserTx, toParserTx } from './parser.interface';

type Json = Record<string, any>;

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');
const RIPPLE_EPOCH = 946_684_800;

const parser = new ObjectChangesParser();
const balances = new BalanceChangesParser();
const CTX = Object.fromEntries(NETWORK_NAMES.map((n) => [n, parseContextFor(getNetworkProfile(n))])) as Record<
  NetworkName,
  ParseContext
>;

// -- the recorded cases -----------------------------------------------------------------------------------------------

interface Base {
  ledger: RawLedger;
  tx: RawTransaction;
}

/** The recorded case of the objects set; it must have been found. */
function base(net: ObjectNet, name: string): Base {
  const found = objectCase(net, name);
  if (!found) throw new Error(`${net}/objects: ${name} is not recorded`);
  return found;
}

const setCache = new Map<string, RawLedger[]>();

/** A recorded transaction of a recorded set, by its hash. */
function recordedIn(set: [NetworkName, string], hash: string): Base {
  const key = set.join('/');
  if (!setCache.has(key)) setCache.set(key, FixtureLedgerSource.fromDir(join(FIXTURES, ...set)).list());
  for (const ledger of setCache.get(key)!) {
    const tx = ledger.transactions.find((t) => t.hash === hash);
    if (tx) return { ledger, tx };
  }
  throw new Error(`${set.join('/')} has no transaction ${hash}`);
}

const parserTxOf = ({ ledger, tx }: Base): ParserTx => deepFreeze(toParserTx(tx, ledger.header, null));
const recorded = (net: ObjectNet, name: string): ParserTx => parserTxOf(base(net, name));

/** The rows of a transaction of the network `net`. */
const parse = (t: ParserTx, net: NetworkName = 'xrpl'): ParsedObjectChange[] => parser.parse(t, CTX[net]);

/** The one row of a transaction. */
function only(t: ParserTx, net: NetworkName = 'xrpl'): ParsedObjectChange {
  const rows = parse(t, net);
  expect(rows).toHaveLength(1);
  return rows[0];
}

const jsonOf = (text: string): Json => JSON.parse(text) as Json;

/** The body of a node's wrapper (`{ CreatedNode | ModifiedNode | DeletedNode: body }`). */
const bodyOf = (wrapper: Json): Json => Object.values(wrapper)[0] as Json;
const wrapperOf = (meta: Json, type: string): Json =>
  (meta.AffectedNodes as Json[]).find((w) => bodyOf(w).LedgerEntryType === type)!;
const nodeOf = (t: ParserTx, type: string): Json => bodyOf(wrapperOf(t.meta, type));

// -- the synthetic cases ----------------------------------------------------------------------------------------------

interface SyntheticCase {
  name: string;
  net: ObjectNet;
  t: ParserTx;
}
const SYNTHETIC: SyntheticCase[] = [];

function register(net: ObjectNet, name: string, ledger: RawLedger, raw: RawTransaction): ParserTx {
  const t = deepFreeze(toParserTx(raw, ledger.header, null));
  SYNTHETIC.push({ name, net, t });
  return t;
}

/** `from` with `edit` applied to a copy of its transaction and metadata; the hash says which transaction it is made from. */
function synthetic(
  net: ObjectNet,
  name: string,
  from: Base,
  edit: (tx: Json, meta: Json, from: Base) => void,
): ParserTx {
  const raw = structuredClone(from.tx) as RawTransaction;
  edit(raw.tx as Json, raw.meta as Json, from);
  raw.hash = syntheticHash(name, from.tx.hash);
  return register(net, name, from.ledger, raw);
}

const permissions = (...names: string[]): Json[] => names.map((n) => ({ Permission: { PermissionValue: n } }));

/** The recorded delegation of `xrpl/objects` `delegate_set_create`: the pair that the Delegate cases below name. */
const delegationBase = (): Base => base('xrpl', 'delegate_set_create');
const delegationNode = (): Json => nodeOf(parserTxOf(delegationBase()), 'Delegate');
const delegation = (): Json => delegationNode().NewFields;

/** An account that is neither party to the check of `check_cancel_source`, and none of the recorded transactions names. */
const THIRD_PARTY = SYNTHETIC_DELEGATE;
const TICKET = 107_890_001;
const MPT_ISSUANCE = '0000012AB5F762798A53D543A014CAF8B297CFF8F2F937E8';
const MPT_AMOUNT = { mpt_issuance_id: MPT_ISSUANCE, value: '250' };
const DELEGATED_PAYMENT_BASE = 'BAF0C2EC22CFC229C9AABC02413EB6433A820F5689B69FD4AD83565A38EF77ED';
const DELEGATED_TEC_BASE = '5AA87418BCF36929DBA2638FE6B83A27A6F77FDFF42F25EDB82929F0BADF9D8B';
const ACCOUNT_DELETE_BASE = '8F2DCA944394B29981E24DDD6C46192C404D90F7F5FC4EAB6813B0AFD7751A2D';
const ACCOUNT_SET_BASE = '07DD38A50E6FE455A417241819F267E88ECD738862E25183CCDEE653D1121557';

/** A delegated Payment or tec Payment of the Task 5 specs: their base transactions are recorded in `xrpl/recorded`. */
function delegated(name: string, from: Base): ParserTx {
  return register('xrpl', name, from.ledger, delegatedFrom(from.tx, name));
}

/** `DeletedNode` Delegate for an AccountDelete: the recorded delegation, with the thread fields of its creation. */
function deletedDelegate(): Json {
  const { ledger, tx } = delegationBase();
  const created = delegationNode();
  return {
    DeletedNode: {
      LedgerEntryType: 'Delegate',
      LedgerIndex: created.LedgerIndex,
      FinalFields: {
        ...structuredClone(created.NewFields),
        Flags: 0,
        OwnerNode: '0',
        PreviousTxnID: tx.hash,
        PreviousTxnLgrSeq: ledger.header.ledger_index,
      },
    },
  };
}

/** The recorded AccountDelete as sent by `account`, with the recorded delegation deleted along with it. */
function accountDeleteOf(name: string, account: string): ParserTx {
  return synthetic('xrpl', name, recordedIn(['xrpl', 'account-state'], ACCOUNT_DELETE_BASE), (tx, meta) => {
    tx.Account = account;
    bodyOf(wrapperOf(meta, 'AccountRoot')).FinalFields.Account = account;
    (meta.AffectedNodes as Json[]).push(deletedDelegate());
  });
}

const without = (meta: Json, type: string, op: string): Json[] =>
  (meta.AffectedNodes as Json[]).filter((w) => !(op in w && bodyOf(w).LedgerEntryType === type));

/**
 * `check_cash_amount` with the three places a cash's delivered amount can come from set to different values (the stored
 * `DeliveredAmount` 825, the served `delivered_amount` 826, `Amount` 827), then `edit`ed: it pins which one wins.
 */
function cashDelivered(name: string, edit: (tx: Json, meta: Json) => void): ParserTx {
  return synthetic('xrpl', name, base('xrpl', 'check_cash_amount'), (tx, meta) => {
    tx.Amount = '933622827';
    meta.delivered_amount = '933622826';
    meta.DeliveredAmount = '933622825';
    edit(tx, meta);
  });
}

const S = {
  escrowCreateTicket: synthetic(
    'xrpl',
    'synthetic-escrow-create-ticket',
    base('xrpl', 'escrow_create_timed'),
    (tx, meta) => {
      tx.Sequence = 0;
      tx.TicketSequence = TICKET;
      const escrow = bodyOf(wrapperOf(meta, 'Escrow'));
      escrow.LedgerIndex = escrowId(tx.Account, TICKET);
      escrow.NewFields.Sequence = TICKET;
    },
  ),

  escrowFinishFulfillment: synthetic(
    'xrpl',
    'synthetic-escrow-finish-fulfillment',
    base('xrpl', 'escrow_finish_timed'),
    (tx, meta) => {
      tx.Fulfillment = 'A0028000';
      bodyOf(wrapperOf(meta, 'Escrow')).FinalFields.Condition =
        'A0258020E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855810100';
    },
  ),

  escrowCreateMpt: synthetic('xrpl', 'synthetic-escrow-create-mpt', base('xrpl', 'escrow_create_token'), (tx, meta) => {
    tx.Amount = { ...MPT_AMOUNT };
    bodyOf(wrapperOf(meta, 'Escrow')).NewFields.Amount = { ...MPT_AMOUNT };
    // The sender's trust line is its MPToken here: the tokens stay in it, locked.
    const nodes = meta.AffectedNodes as Json[];
    nodes[nodes.indexOf(wrapperOf(meta, 'RippleState'))] = {
      ModifiedNode: {
        LedgerEntryType: 'MPToken',
        LedgerIndex: syntheticHash('synthetic-escrow-create-mpt', 'MPToken'),
        FinalFields: {
          Account: tx.Account,
          Flags: 0,
          LockedAmount: '250',
          MPTAmount: '1000',
          MPTokenIssuanceID: MPT_ISSUANCE,
          OwnerNode: '0',
        },
        PreviousFields: {},
      },
    };
  }),

  checkCashDeliverMin: synthetic(
    'xrpl',
    'synthetic-check-cash-deliver-min',
    base('xrpl', 'check_cash_amount'),
    (tx, meta) => {
      meta.DeliveredAmount = tx.Amount;
      tx.DeliverMin = String(BigInt(tx.Amount) / 2n);
      delete tx.Amount;
    },
  ),
  cashStored: cashDelivered('synthetic-check-cash-delivered-stored', () => undefined),
  cashServed: cashDelivered('synthetic-check-cash-delivered-served', (_tx, meta) => delete meta.DeliveredAmount),
  cashAmount: cashDelivered('synthetic-check-cash-delivered-amount', (_tx, meta) => {
    delete meta.DeliveredAmount;
    delete meta.delivered_amount;
  }),
  cashNone: cashDelivered('synthetic-check-cash-delivered-none', (tx, meta) => {
    delete meta.DeliveredAmount;
    delete meta.delivered_amount;
    delete tx.Amount;
    tx.DeliverMin = '466811414';
  }),

  checkCancelThirdParty: synthetic(
    'xrpl',
    'synthetic-check-cancel-third-party-expired',
    base('xrpl', 'check_cancel_source'),
    (tx, meta, from) => {
      const source = tx.Account;
      tx.Account = THIRD_PARTY;
      const payer = (meta.AffectedNodes as Json[])
        .map(bodyOf)
        .find((n) => n.LedgerEntryType === 'AccountRoot' && n.FinalFields?.Account === source);
      if (!payer) throw new Error('check_cancel_source: the metadata has no AccountRoot of its sender');
      payer.FinalFields.Account = THIRD_PARTY;
      // The check had expired a day before the ledger closed.
      bodyOf(wrapperOf(meta, 'Check')).FinalFields.Expiration = from.ledger.header.close_time - RIPPLE_EPOCH - 86_400;
    },
  ),

  delegateSetReplace: synthetic('xrpl', 'synthetic-delegate-set-replace', delegationBase(), (tx, meta, from) => {
    const nodes = meta.AffectedNodes as Json[];
    const created = bodyOf(wrapperOf(meta, 'Delegate'));
    tx.Permissions = permissions('OfferCreate', 'OfferCancel', 'Payment');
    nodes[nodes.indexOf(wrapperOf(meta, 'Delegate'))] = {
      ModifiedNode: {
        LedgerEntryType: 'Delegate',
        LedgerIndex: created.LedgerIndex,
        FinalFields: { ...created.NewFields, Flags: 0, OwnerNode: '0', Permissions: structuredClone(tx.Permissions) },
        PreviousFields: { Permissions: created.NewFields.Permissions },
        PreviousTxnID: from.tx.hash,
        PreviousTxnLgrSeq: from.ledger.header.ledger_index,
      },
    };
    // The entry exists already: no new owned object, no new directory.
    meta.AffectedNodes = without(meta, 'DirectoryNode', 'CreatedNode');
    delete bodyOf(wrapperOf(meta, 'AccountRoot')).PreviousFields.OwnerCount;
  }),

  delegateSetEmpty: synthetic('xrpl', 'synthetic-delegate-set-empty', delegationBase(), (tx, meta, from) => {
    const nodes = meta.AffectedNodes as Json[];
    const created = bodyOf(wrapperOf(meta, 'Delegate'));
    tx.Permissions = [];
    nodes[nodes.indexOf(wrapperOf(meta, 'Delegate'))] = {
      DeletedNode: {
        LedgerEntryType: 'Delegate',
        LedgerIndex: created.LedgerIndex,
        FinalFields: {
          ...created.NewFields,
          Flags: 0,
          OwnerNode: '0',
          PreviousTxnID: from.tx.hash,
          PreviousTxnLgrSeq: from.ledger.header.ledger_index,
        },
      },
    };
    meta.AffectedNodes = without(meta, 'DirectoryNode', 'CreatedNode');
    const root = bodyOf(wrapperOf(meta, 'AccountRoot'));
    root.FinalFields.OwnerCount = 1;
    root.PreviousFields.OwnerCount = 2;
  }),

  delegatedPayment: delegated('synthetic-delegated-payment', recordedIn(['xrpl', 'recorded'], DELEGATED_PAYMENT_BASE)),
  delegatedTec: delegated('synthetic-delegated-tec', recordedIn(['xrpl', 'recorded'], DELEGATED_TEC_BASE)),
  delegatedEscrowCreate: delegated('synthetic-delegated-escrow-create', base('xrpl', 'escrow_create_timed')),

  accountDeleteDelegate: accountDeleteOf('synthetic-account-delete-delegate', delegation().Account),
  accountDeleteDelegateAuthorized: accountDeleteOf(
    'synthetic-account-delete-delegate-authorized',
    delegation().Authorize,
  ),

  accountSetEscrowUpdate: synthetic(
    'xrpl',
    'synthetic-account-set-escrow-update',
    recordedIn(['xrpl', 'account-state'], ACCOUNT_SET_BASE),
    (_tx, meta) => {
      const escrow = parserTxOf(base('xrpl', 'escrow_create_timed'));
      (meta.AffectedNodes as Json[]).push({
        ModifiedNode: {
          LedgerEntryType: 'Escrow',
          LedgerIndex: nodeOf(escrow, 'Escrow').LedgerIndex,
          FinalFields: { ...structuredClone(nodeOf(escrow, 'Escrow').NewFields), Flags: 0, OwnerNode: '0' },
          PreviousFields: { Amount: '400000' },
          PreviousTxnID: escrow.hash,
          PreviousTxnLgrSeq: escrow.ledger_index,
        },
      });
    },
  ),

  channelThreaded: synthetic('xrpl', 'synthetic-channel-threaded', base('xrpl', 'channel_claim'), (_tx, meta) => {
    delete bodyOf(wrapperOf(meta, 'PayChannel')).PreviousFields;
  }),

  escrowCreateNoSequence: synthetic(
    'xahau',
    'synthetic-escrow-create-no-sequence',
    base('xahau', 'escrow_create'),
    (tx) => {
      tx.Sequence = 0;
    },
  ),

  delegatedBatchInnerCheckCash: synthetic(
    'xrpl',
    'synthetic-delegated-batch-inner-check-cash',
    base('xrpl', 'check_cash_amount'),
    (tx) => {
      tx.Delegate = SYNTHETIC_DELEGATE;
    },
  ),

  tecChannelCloseExpired: synthetic(
    'xrpl',
    'synthetic-tec-channel-close-expired',
    base('xrpl', 'channel_close_expired'),
    (_tx, meta) => {
      meta.TransactionResult = 'tecNO_PERMISSION';
    },
  ),
};

// -- hand-made envelopes for the event table -------------------------------------------------------------------------

type Op = 'CreatedNode' | 'ModifiedNode' | 'DeletedNode';

/** A node of the metadata. A modified node has `PreviousFields` (`previous`, `{}` by default) unless `null`. */
function node(op: Op, type: string, fields: Json, previous: Json | null = {}, id = 'ab'.repeat(32)): Json {
  return {
    [op]: {
      LedgerEntryType: type,
      LedgerIndex: id,
      ...(op === 'CreatedNode' ? { NewFields: fields } : { FinalFields: fields }),
      ...(op === 'ModifiedNode' && previous !== null ? { PreviousFields: previous } : {}),
      ...(op === 'DeletedNode' && previous !== null && Object.keys(previous).length > 0
        ? { PreviousFields: previous }
        : {}),
    },
  };
}

/** A transaction of `txType` with the given metadata nodes. Unit data: hand-made, not presented as recorded. */
function envelope(txType: string, nodes: Json[], tx: Json = {}, meta: Json = {}): ParserTx {
  return deepFreeze({
    hash: 'HASH',
    ledger_index: 100,
    close_time: 1_700_000_000,
    tx_index: 0,
    client: null,
    tx: { TransactionType: txType, Account: 'rSender', Sequence: 5, Fee: '10', ...tx },
    meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: nodes, ...meta },
  });
}

const PARTIES: Record<TrackedObjectType, Json> = {
  Escrow: { Account: 'rOwner', Destination: 'rOther', Amount: '1000000' },
  Check: { Account: 'rOwner', Destination: 'rOther', SendMax: '1000000', Sequence: 5 },
  PayChannel: { Account: 'rOwner', Destination: 'rOther', Amount: '1000000', Balance: '0', SettleDelay: 60 },
  Delegate: { Account: 'rOwner', Authorize: 'rOther', Permissions: permissions('Payment') },
};

interface EventCase {
  type: TrackedObjectType;
  op: Op;
  txType: string;
  flags?: number;
  /** Fields added to the node's final fields. */
  final?: Json;
  previous?: Json;
  event: string;
}

const eventCase = (
  type: TrackedObjectType,
  op: Op,
  txType: string,
  event: string,
  rest: Partial<EventCase> = {},
): EventCase => ({
  type,
  op,
  txType,
  event,
  ...rest,
});

/** Every row of spec 2.2's table, in its order, and the cases around it that fall through to the row after or to `update`. */
const EVENT_TABLE: EventCase[] = [
  eventCase('Escrow', 'CreatedNode', 'EscrowCreate', 'create'),
  eventCase('Escrow', 'DeletedNode', 'EscrowFinish', 'finish'),
  eventCase('Escrow', 'DeletedNode', 'EscrowCancel', 'cancel'),
  eventCase('Escrow', 'DeletedNode', 'AccountDelete', 'removed'),
  eventCase('Escrow', 'DeletedNode', 'EscrowCreate', 'removed'),
  eventCase('Escrow', 'DeletedNode', 'CheckCancel', 'removed'),
  eventCase('Escrow', 'CreatedNode', 'EscrowFinish', 'update'),
  eventCase('Escrow', 'ModifiedNode', 'AccountSet', 'update', { previous: { Amount: '1' } }),
  eventCase('Escrow', 'ModifiedNode', 'EscrowFinish', 'update', { previous: { Amount: '1' } }),

  eventCase('Check', 'CreatedNode', 'CheckCreate', 'create'),
  eventCase('Check', 'DeletedNode', 'CheckCash', 'cash'),
  eventCase('Check', 'DeletedNode', 'CheckCancel', 'cancel'),
  eventCase('Check', 'DeletedNode', 'OfferCreate', 'removed'),
  eventCase('Check', 'DeletedNode', 'CheckCreate', 'removed'),
  eventCase('Check', 'CreatedNode', 'CheckCash', 'update'),
  eventCase('Check', 'ModifiedNode', 'CheckCash', 'update', { previous: { SendMax: '2' } }),

  eventCase('PayChannel', 'CreatedNode', 'PaymentChannelCreate', 'create'),
  eventCase('PayChannel', 'DeletedNode', 'PaymentChannelClaim', 'close'),
  eventCase('PayChannel', 'DeletedNode', 'PaymentChannelFund', 'close'),
  eventCase('PayChannel', 'DeletedNode', 'PaymentChannelClaim', 'close', { flags: TF_CLOSE, final: { Expiration: 9 } }),
  eventCase('PayChannel', 'DeletedNode', 'PaymentChannelCreate', 'removed'),
  eventCase('PayChannel', 'DeletedNode', 'AccountDelete', 'removed'),
  eventCase('PayChannel', 'ModifiedNode', 'PaymentChannelFund', 'fund', { previous: { Amount: '1' } }),
  eventCase('PayChannel', 'ModifiedNode', 'PaymentChannelFund', 'fund', { flags: TF_CLOSE, final: { Expiration: 9 } }),
  eventCase('PayChannel', 'ModifiedNode', 'PaymentChannelClaim', 'claim', { previous: { Balance: '0' } }),
  eventCase('PayChannel', 'ModifiedNode', 'PaymentChannelClaim', 'close_request', {
    flags: TF_CLOSE,
    final: { Expiration: 9 },
  }),
  eventCase('PayChannel', 'ModifiedNode', 'PaymentChannelClaim', 'close_request', {
    flags: TF_CLOSE | TF_RENEW,
    final: { Expiration: 9 },
    previous: { Expiration: 7 },
  }),
  eventCase('PayChannel', 'ModifiedNode', 'PaymentChannelClaim', 'claim', { flags: TF_CLOSE }),
  eventCase('PayChannel', 'ModifiedNode', 'PaymentChannelClaim', 'claim', {
    flags: TF_CLOSE,
    previous: { Expiration: 7 },
  }),
  eventCase('PayChannel', 'ModifiedNode', 'PaymentChannelClaim', 'claim', { final: { Expiration: 9 } }),
  eventCase('PayChannel', 'ModifiedNode', 'PaymentChannelClaim', 'renew', {
    flags: TF_RENEW,
    previous: { Expiration: 7 },
  }),
  eventCase('PayChannel', 'ModifiedNode', 'PaymentChannelClaim', 'renew', {
    flags: (TF_RENEW | 0x80000000) >>> 0,
    previous: { Expiration: 7 },
  }),
  eventCase('PayChannel', 'ModifiedNode', 'PaymentChannelClaim', 'claim', {
    flags: TF_RENEW,
    final: { Expiration: 9 },
    previous: { Expiration: 7 },
  }),
  eventCase('PayChannel', 'ModifiedNode', 'PaymentChannelClaim', 'claim', {
    flags: TF_RENEW,
    previous: { Balance: '0' },
  }),
  eventCase('PayChannel', 'ModifiedNode', 'PaymentChannelClaim', 'claim', { previous: { Expiration: 7 } }),
  eventCase('PayChannel', 'CreatedNode', 'PaymentChannelFund', 'update'),
  eventCase('PayChannel', 'ModifiedNode', 'OfferCreate', 'update', { previous: { Balance: '0' } }),

  eventCase('Delegate', 'CreatedNode', 'DelegateSet', 'set'),
  eventCase('Delegate', 'ModifiedNode', 'DelegateSet', 'set', {
    previous: { Permissions: permissions('Payment', 'TrustSet') },
  }),
  eventCase('Delegate', 'DeletedNode', 'DelegateSet', 'delete'),
  eventCase('Delegate', 'DeletedNode', 'AccountDelete', 'removed'),
  eventCase('Delegate', 'DeletedNode', 'AccountSet', 'removed'),
  eventCase('Delegate', 'CreatedNode', 'AccountSet', 'update'),
  eventCase('Delegate', 'ModifiedNode', 'AccountSet', 'update', { previous: { Permissions: permissions('Payment') } }),
];

// -- the corpus: every transaction of every recorded set, and the synthetic cases -------------------------------------

interface Entry {
  name: string;
  net: NetworkName;
  synthetic: boolean;
  t: ParserTx;
  ctx: ParseContext;
  rows: ParsedObjectChange[];
}

let corpusCache: Entry[] | undefined;

/** Every transaction of every ledger of every directory of the recorded sets of the four networks, and the synthetic cases. */
function corpus(): Entry[] {
  if (corpusCache) return corpusCache;
  const entries: Entry[] = [];
  const add = (name: string, net: NetworkName, t: ParserTx, synthetic: boolean) =>
    entries.push({ name, net, synthetic, t, ctx: CTX[net], rows: parser.parse(t, CTX[net]) });

  for (const net of NETWORK_NAMES) {
    const netDir = join(FIXTURES, net);
    if (!existsSync(netDir)) continue;
    for (const set of readdirSync(netDir).sort()) {
      if (!statSync(join(netDir, set)).isDirectory()) continue;
      for (const ledger of FixtureLedgerSource.fromDir(join(netDir, set)).list()) {
        for (const raw of ledger.transactions) {
          add(
            `${net}/${set} ${ledger.header.ledger_index} ${raw.hash}`,
            net,
            deepFreeze(toParserTx(raw, ledger.header, null)),
            false,
          );
        }
      }
    }
  }
  for (const s of SYNTHETIC) add(s.name, s.net, s.t, true);
  return (corpusCache = entries);
}

const TRACKED = new Set<string>(TRACKED_OBJECT_TYPES);
const trackedNodes = (t: ParserTx): Json[] =>
  ((t.meta.AffectedNodes ?? []) as Json[]).map(bodyOf).filter((n) => TRACKED.has(n.LedgerEntryType));

/** The value of an amount in whole units: native drops converted, an issued token as it is. */
const wholeUnits = (amount: unknown): BigNumber =>
  typeof amount === 'string' ? new BigNumber(amount).shiftedBy(-6) : new BigNumber((amount as Json).value);

/** Whether the keys of every object of `value` are in the default string order. */
function sortedKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(sortedKeys);
  if (typeof value !== 'object' || value === null) return true;
  const keys = Object.keys(value);
  return keys.every((k, i) => i === 0 || keys[i - 1] < k) && Object.values(value).every(sortedKeys);
}

// ---------------------------------------------------------------------------------------------------------------------

describe('ObjectChangesParser', () => {
  describe('escrows', () => {
    it('escrow_create_timed: one created row, owner Account, counterparty Destination, sequence in event_fields', () => {
      const t = recorded('xrpl', 'escrow_create_timed');
      const row = only(t);

      expect(row).toEqual({
        object_type: 'Escrow',
        object_id: 'B95064B1A92F02EE009E6BDFB369CF476FB925BB8615456970E38774034A5D30',
        action: 'created',
        event: 'create',
        owner: 'rNeJW71pMjKy42j5jn7vnWZAbmuU6SKs6V',
        counterparty: 'rGtW2dWHmHQ3f65pfbjYF5PbFbdZwgwuqW',
        fields:
          '{"Account":"rNeJW71pMjKy42j5jn7vnWZAbmuU6SKs6V","Amount":"500000","CancelAfter":846265741,' +
          '"Destination":"rGtW2dWHmHQ3f65pfbjYF5PbFbdZwgwuqW","FinishAfter":846262201,"Sequence":107896555,"SourceTag":2610250016}',
        previous: '{}',
        event_fields: '{"sequence":107896555}',
      });
      expect(row.owner).toBe(t.tx.Account);
      expect(row.counterparty).toBe(t.tx.Destination);
      expect(row.object_id).toBe(escrowId(t.tx.Account, t.tx.Sequence));
    });

    it('ripple-mock A8272533…: an escrow to oneself is one row whose owner is its counterparty', () => {
      const t = parserTxOf(
        recordedIn(['xrpl', 'ripple-mock'], 'A827253314026A3D27A7AD8047C6A29D092BC161AF11E5B752EFD2C0E79FF2F1'),
      );
      const row = only(t);
      expect(row).toMatchObject({
        object_type: 'Escrow',
        action: 'created',
        event: 'create',
        owner: 'rGhDCgik9CwiNpcNnYHkEHcMgw2dkLgtNB',
        counterparty: 'rGhDCgik9CwiNpcNnYHkEHcMgw2dkLgtNB',
      });
      // This escrow's node has no Sequence of its own: the transaction's is the only place it is.
      expect(jsonOf(row.fields)).not.toHaveProperty('Sequence');
      expect(jsonOf(row.event_fields)).toEqual({ sequence: t.tx.Sequence });
      expect(row.object_id).toBe(escrowId(row.owner, t.tx.Sequence));
    });

    it('escrow_create_conditional: the Condition is a field, the directory pages are not stored', () => {
      const t = recorded('xrpl', 'escrow_create_conditional');
      const fields = jsonOf(only(t).fields);
      expect(fields.Condition).toBe(nodeOf(t, 'Escrow').NewFields.Condition);
      expect(Object.keys(nodeOf(t, 'Escrow').NewFields)).toEqual(expect.arrayContaining(['OwnerNode', 'IssuerNode']));
      for (const excluded of OBJECT_FIELD_EXCLUSIONS) expect(fields).not.toHaveProperty(excluded);
    });

    it('synthetic-escrow-create-ticket: the TicketSequence is the sequence, and escrowId(owner, it) is the object_id', () => {
      const t = S.escrowCreateTicket;
      expect(t.tx.Sequence).toBe(0);
      const row = only(t);
      expect(row.event).toBe('create');
      expect(jsonOf(row.event_fields)).toEqual({ sequence: TICKET });
      expect(row.object_id).toBe(escrowId(row.owner, TICKET));
      expect(row.object_id).not.toBe(escrowId(row.owner, 0));
    });

    it('synthetic-escrow-create-no-sequence: neither a Sequence nor a ticket leaves the sequence out', () => {
      const row = only(S.escrowCreateNoSequence, 'xahau');
      expect(row.event).toBe('create');
      expect(row.event_fields).toBe('{}');
    });

    it('escrow_finish_timed: a deleted finish row without a fulfillment', () => {
      const t = recorded('xrpl', 'escrow_finish_timed');
      const row = only(t);
      expect(row).toMatchObject({ object_type: 'Escrow', action: 'deleted', event: 'finish', event_fields: '{}' });
      expect(row.owner).toBe(nodeOf(t, 'Escrow').FinalFields.Account);
      expect(row.object_id).toBe(nodeOf(t, 'Escrow').LedgerIndex);
    });

    it('synthetic-escrow-finish-fulfillment: a deleted finish row carrying the fulfillment', () => {
      const row = only(S.escrowFinishFulfillment);
      expect(row).toMatchObject({ object_type: 'Escrow', action: 'deleted', event: 'finish' });
      expect(row.event_fields).toBe('{"fulfillment":"A0028000"}');
      expect(jsonOf(row.fields).Condition).toMatch(/^A0258020/);
    });

    it('escrow_cancel: cancel, and the IssuerNode and the other thread fields are not stored', () => {
      const t = recorded('xrpl', 'escrow_cancel');
      const row = only(t);
      expect(row).toMatchObject({ object_type: 'Escrow', action: 'deleted', event: 'cancel', event_fields: '{}' });
      const final = nodeOf(t, 'Escrow').FinalFields;
      for (const excluded of OBJECT_FIELD_EXCLUSIONS) expect(final).toHaveProperty(excluded); // all five are on this node
      expect(Object.keys(jsonOf(row.fields))).toEqual(
        Object.keys(final)
          .filter((k) => !OBJECT_FIELD_EXCLUSIONS.includes(k))
          .sort(),
      );
    });

    it.each([
      ['xrpl' as const, 'escrow_create_token'],
      ['xahau' as const, 'escrow_create_token'],
    ])('%s %s: Amount is the issued-token object of the ledger in fields', (net, name) => {
      const t = recorded(net, name);
      const row = only(t, net);
      const amount = nodeOf(t, 'Escrow').NewFields.Amount;
      expect(typeof amount).toBe('object');
      expect(jsonOf(row.fields).Amount).toEqual(amount);
      expect(Object.keys(jsonOf(row.fields).Amount).sort()).toEqual(['currency', 'issuer', 'value']);
    });

    it('xahau escrow_create: TransferRate is a field and there is no IssuerNode', () => {
      const t = recorded('xahau', 'escrow_create');
      const fields = jsonOf(only(t, 'xahau').fields);
      expect(fields.TransferRate).toBe(nodeOf(t, 'Escrow').NewFields.TransferRate);
      expect(fields).not.toHaveProperty('IssuerNode');
    });

    it('xrpl escrow_finish_token: the finish of a token escrow deletes the node, Amount as on the ledger', () => {
      const t = recorded('xrpl', 'escrow_finish_token');
      const row = only(t);
      expect(row).toMatchObject({ action: 'deleted', event: 'finish', event_fields: '{}' });
      expect(jsonOf(row.fields).Amount).toEqual(nodeOf(t, 'Escrow').FinalFields.Amount);
      expect(t.tx.Sequence).toBe(0); // sent with a ticket: a finish takes no sequence from it
    });

    it('synthetic-escrow-create-mpt: Amount is {mpt_issuance_id, value} as on the ledger in fields', () => {
      const t = S.escrowCreateMpt;
      const row = only(t);
      expect(row).toMatchObject({ object_type: 'Escrow', action: 'created', event: 'create' });
      expect(jsonOf(row.fields).Amount).toEqual(MPT_AMOUNT);
      expect(jsonOf(row.fields).Amount).not.toHaveProperty('issuer');
    });

    it('xahau escrow_finish_escrow_id: the deleted node is read, EscrowID changes nothing', () => {
      const t = recorded('xahau', 'escrow_finish_escrow_id');
      const row = only(t, 'xahau');
      // The transaction's Owner is the escrow's Destination here; the escrow's owner is its Account.
      expect(t.tx.Owner).toBe('rPicqzcyoxw22XBrFCMAcFXYU2boeqYjm6');
      expect(row).toMatchObject({
        object_type: 'Escrow',
        object_id: t.tx.EscrowID,
        action: 'deleted',
        event: 'finish',
        owner: 'rD74dUPRFNfgnY2NzrxxYRXN4BrfGSN6Mv',
        counterparty: t.tx.Owner,
        event_fields: '{}',
      });
      const elsewhere = deepFreeze({ ...t, tx: { ...t.tx, Owner: 'rNobody', EscrowID: '0'.repeat(64) } });
      expect(parse(elsewhere, 'xahau')).toEqual([row]);
    });

    it('xahau escrow_finish and escrow_cancel: finish and cancel', () => {
      expect(only(recorded('xahau', 'escrow_finish'), 'xahau')).toMatchObject({ action: 'deleted', event: 'finish' });
      const cancel = recorded('xahau', 'escrow_cancel');
      expect(only(cancel, 'xahau')).toMatchObject({ action: 'deleted', event: 'cancel' });
      expect(cancel.tx.Account).not.toBe(cancel.tx.Owner); // a third party cancelled it
    });
  });

  describe('checks', () => {
    it.each([
      ['xrpl' as const, 'check_create_xrp'],
      ['xrpl' as const, 'check_create_token'],
      ['xahau' as const, 'check_create'],
    ])('%s %s: a created row, the sequence in event_fields, SendMax as on the ledger', (net, name) => {
      const t = recorded(net, name);
      const row = only(t, net);
      expect(row).toMatchObject({
        object_type: 'Check',
        object_id: nodeOf(t, 'Check').LedgerIndex,
        action: 'created',
        event: 'create',
        owner: t.tx.Account,
        counterparty: t.tx.Destination,
      });
      expect(jsonOf(row.event_fields)).toEqual({ sequence: t.tx.Sequence });
      expect(jsonOf(row.fields).SendMax).toEqual(nodeOf(t, 'Check').NewFields.SendMax);
    });

    it('check_create_token: Expiration and InvoiceID are fields', () => {
      const fields = jsonOf(only(recorded('xrpl', 'check_create_token')).fields);
      expect(fields).toHaveProperty('Expiration');
      expect(fields).toHaveProperty('InvoiceID');
    });

    it('check_cash_amount: the XRP cash delivers the Amount the node served; a Batch inner transaction (no fee)', () => {
      const t = recorded('xrpl', 'check_cash_amount');
      const row = only(t);
      expect(row).toMatchObject({
        object_type: 'Check',
        action: 'deleted',
        event: 'cash',
        event_fields: '{"delivered":"933622827"}',
      });
      expect(t.meta.DeliveredAmount).toBeUndefined(); // an XRP cash stores none
      expect(t.meta.delivered_amount).toBe('933622827');
    });

    it('token cashes: delivered is the stored DeliveredAmount, as on the ledger', () => {
      for (const [set, hash] of [
        [['xrpl', 'objects'], '3ABD7BA6DA173F446AFA31C5C2D4EA51FC73A3BDA6E9ED7BBC557A215E33B330'],
        [['xrpl', 'objects'], 'A075E757D0E6E283ABB6CD7ED751A412D4B1DC14C6F5DE616819C7D6579EC63C'],
        [['xahau', 'objects'], '2615DA09A9FB5E0F919EE108066407A518771B63541BCA51DEB10B96D9FFA026'],
      ] as [[NetworkName, string], string][]) {
        const t = parserTxOf(recordedIn(set, hash));
        const row = only(t, set[0]);
        expect(row.event).toBe('cash');
        expect(typeof t.meta.DeliveredAmount).toBe('object');
        expect(jsonOf(row.event_fields)).toEqual({ delivered: t.meta.DeliveredAmount });
      }
    });

    it('xahau check_cash: DeliverMin and no Amount, the stored DeliveredAmount is delivered', () => {
      const t = recorded('xahau', 'check_cash');
      expect(t.tx.Amount).toBeUndefined();
      expect(t.tx.DeliverMin).toBe('1000000');
      expect(only(t, 'xahau')).toMatchObject({
        action: 'deleted',
        event: 'cash',
        event_fields: '{"delivered":"1000000"}',
      });
    });

    it('synthetic-check-cash-deliver-min: delivered is DeliveredAmount, never DeliverMin', () => {
      const t = S.checkCashDeliverMin;
      expect(t.tx.Amount).toBeUndefined();
      expect(t.tx.DeliverMin).toBe('466811413');
      expect(only(t).event_fields).toBe('{"delivered":"933622827"}');
    });

    it('delivered is DeliveredAmount, else the served delivered_amount, else Amount, else nothing (never DeliverMin)', () => {
      expect(jsonOf(only(S.cashStored).event_fields)).toEqual({ delivered: '933622825' });
      expect(jsonOf(only(S.cashServed).event_fields)).toEqual({ delivered: '933622826' });
      expect(jsonOf(only(S.cashAmount).event_fields)).toEqual({ delivered: '933622827' });
      expect(S.cashNone.tx.DeliverMin).toBeDefined();
      expect(only(S.cashNone).event_fields).toBe('{}');
    });

    it('check_cancel_source: cancel by the source', () => {
      const t = recorded('xrpl', 'check_cancel_source');
      const row = only(t);
      expect(row).toMatchObject({
        object_type: 'Check',
        action: 'deleted',
        event: 'cancel',
        owner: t.tx.Account,
        event_fields: '{}',
      });
    });

    it('synthetic-check-cancel-third-party-expired: cancel by an account that is neither party', () => {
      const t = S.checkCancelThirdParty;
      const row = only(t);
      expect(row).toMatchObject({ action: 'deleted', event: 'cancel', event_fields: '{}' });
      expect([row.owner, row.counterparty]).not.toContain(t.tx.Account);
      expect(jsonOf(row.fields).Expiration).toBeLessThan(t.close_time - RIPPLE_EPOCH);
    });
  });

  describe('payment channels', () => {
    it.each([
      ['xrpl' as const, 'channel_create'],
      ['xahau' as const, 'channel_create'],
      ['xahau' as const, 'channel_create_token'],
    ])('%s %s: a created row with the sequence', (net, name) => {
      const t = recorded(net, name);
      const row = only(t, net);
      expect(row).toMatchObject({
        object_type: 'PayChannel',
        object_id: nodeOf(t, 'PayChannel').LedgerIndex,
        action: 'created',
        event: 'create',
        owner: t.tx.Account,
        counterparty: t.tx.Destination,
      });
      expect(jsonOf(row.event_fields)).toEqual({ sequence: t.tx.Sequence });
    });

    it.each([
      ['channel_fund_expiration', 'fund'],
      ['channel_claim', 'claim'],
      ['channel_close_request', 'close_request'],
      ['channel_renew', 'renew'],
      ['channel_close_destination', 'close'],
      ['channel_close_expired', 'close'],
    ])('%s is %s', (name, event) => {
      const t = recorded('xrpl', name);
      const row = only(t);
      expect(row).toMatchObject({ object_type: 'PayChannel', event, event_fields: '{}' });
      expect(row.action).toBe(event === 'close' ? 'deleted' : 'modified');
      expect(row.object_id).toBe(nodeOf(t, 'PayChannel').LedgerIndex);
    });

    it('channel_close_destination: the deleted channel as it stood, and what the claim changed', () => {
      const row = only(recorded('xrpl', 'channel_close_destination'));
      expect(row).toMatchObject({
        owner: 'rMLwBUc2HZjfwvJLabFinEnCYEpdn9PAYF',
        counterparty: 'rLggTEwmTe3eJgyQbCSk4wQazow2TeKrtR',
        fields:
          '{"Account":"rMLwBUc2HZjfwvJLabFinEnCYEpdn9PAYF","Amount":"10000000","Balance":"154393",' +
          '"Destination":"rLggTEwmTe3eJgyQbCSk4wQazow2TeKrtR","Flags":0,' +
          '"PublicKey":"ED3FC7F09C25307C989D93EC314ABB2A811D6838886D60901294C66DEC7D3E1AD4","Sequence":99081953,"SettleDelay":1209600}',
        previous: '{"Balance":"154373"}',
      });
    });

    it('channel_claim: the first claim has previous.Balance "0"; channel_renew: previous.Expiration and no Expiration now', () => {
      expect(jsonOf(only(recorded('xrpl', 'channel_claim')).previous)).toEqual({ Balance: '0' });
      const renew = only(recorded('xrpl', 'channel_renew'));
      expect(jsonOf(renew.previous)).toEqual({ Expiration: 844406430 });
      expect(jsonOf(renew.fields)).not.toHaveProperty('Expiration');
    });

    it('channel_close_request: a modification with an empty PreviousFields still has its row; channel_fund_expiration: Expiration is set', () => {
      expect(nodeOf(recorded('xrpl', 'channel_close_request'), 'PayChannel').PreviousFields).toEqual({});
      expect(jsonOf(only(recorded('xrpl', 'channel_close_request')).fields)).toHaveProperty('Expiration');
      const fund = only(recorded('xrpl', 'channel_fund_expiration'));
      expect(jsonOf(fund.fields)).toHaveProperty('Expiration');
      expect(jsonOf(fund.previous)).toEqual({ Amount: '5000001' });
    });

    it('xahau channel_claim and channel_claim_token: claim, the token Balance as on the ledger', () => {
      expect(only(recorded('xahau', 'channel_claim'), 'xahau')).toMatchObject({ action: 'modified', event: 'claim' });
      const t = recorded('xahau', 'channel_claim_token');
      const row = only(t, 'xahau');
      expect(row.event).toBe('claim');
      expect(jsonOf(row.fields).Balance).toEqual(nodeOf(t, 'PayChannel').FinalFields.Balance);
      expect(jsonOf(row.previous).Balance).toEqual({
        currency: 'DHA',
        issuer: 'rDyz9rX7eGJRdVDC8NGxMxqh9U14qduqzS',
        value: '0',
      });
    });

    it('synthetic-tec-channel-close-expired: the row is kept whatever the result', () => {
      const t = S.tecChannelCloseExpired;
      expect(t.meta.TransactionResult).toBe('tecNO_PERMISSION');
      expect(only(t)).toMatchObject({ action: 'deleted', event: 'close' });
    });
  });

  describe('delegations', () => {
    it('delegate_set_create: set, with the list as the ledger writes it', () => {
      const t = recorded('xrpl', 'delegate_set_create');
      const row = only(t);
      expect(row).toMatchObject({
        object_type: 'Delegate',
        object_id: 'E63226B764F4D7C198DBF8E4DE0F5DA4F9C1AC449C2927F2150C0B731E020851',
        action: 'created',
        event: 'set',
        owner: 'rnt8PbBFT7idcLyj9PNgxjZi9Z1RiRX3QL',
        counterparty: 'rw2X2GFePFiLDdcQw6iELFfUEw1hPqAGcK',
        previous: '{}',
        event_fields: '{}',
      });
      expect(jsonOf(row.fields).Permissions).toEqual(t.tx.Permissions);
    });

    it('synthetic-delegate-set-replace: set with the new list, the old one in previous', () => {
      const t = S.delegateSetReplace;
      const row = only(t);
      expect(row).toMatchObject({ action: 'modified', event: 'set', event_fields: '{}' });
      expect(jsonOf(row.fields).Permissions).toEqual(permissions('OfferCreate', 'OfferCancel', 'Payment'));
      expect(jsonOf(row.previous)).toEqual({ Permissions: permissions('OfferCreate', 'OfferCancel') });
      for (const excluded of OBJECT_FIELD_EXCLUSIONS) expect(jsonOf(row.fields)).not.toHaveProperty(excluded);
    });

    it('synthetic-delegate-set-empty: delete, the list it had in fields', () => {
      const t = S.delegateSetEmpty;
      expect(t.tx.Permissions).toEqual([]);
      const row = only(t);
      expect(row).toMatchObject({
        action: 'deleted',
        event: 'delete',
        owner: 'rnt8PbBFT7idcLyj9PNgxjZi9Z1RiRX3QL',
        counterparty: 'rw2X2GFePFiLDdcQw6iELFfUEw1hPqAGcK',
        previous: '{}',
      });
      expect(jsonOf(row.fields).Permissions).toEqual(permissions('OfferCreate', 'OfferCancel'));
    });

    // FINDINGS (3): what else deletes a Delegate rests on the documentation (an AccountDelete of the delegating or the
    // delegate account); no such transaction was seen on the network, so these are built from rippled's behaviour as
    // xrpl.org describes it.
    it.each([
      ['synthetic-account-delete-delegate', 'delegating account', () => S.accountDeleteDelegate],
      ['synthetic-account-delete-delegate-authorized', 'delegate', () => S.accountDeleteDelegateAuthorized],
    ])(
      '%s: a Delegate deleted by an AccountDelete of the %s is removed (documentation, not observed)',
      (_name, _who, build) => {
        const t = build();
        expect(t.tx.TransactionType).toBe('AccountDelete');
        const row = only(t);
        expect(row).toMatchObject({
          object_type: 'Delegate',
          action: 'deleted',
          event: 'removed',
          owner: delegation().Account,
          counterparty: delegation().Authorize,
          event_fields: '{}',
        });
        expect([row.owner, row.counterparty]).toContain(t.tx.Account);
      },
    );

    it('a delegated transaction: the object is the delegator’s, the Delegate changes nothing', () => {
      const t = S.delegatedEscrowCreate;
      const plain = recorded('xrpl', 'escrow_create_timed');
      expect(t.tx.Delegate).toBe(SYNTHETIC_DELEGATE);
      expect(parse(t)).toEqual(parse(plain));
      expect(only(t).owner).toBe(t.tx.Account);
    });

    it.each([
      ['synthetic-delegated-payment', () => S.delegatedPayment],
      ['synthetic-delegated-tec', () => S.delegatedTec],
    ])('%s gives no rows', (_name, build) => {
      expect(build().tx.Delegate).toBe(SYNTHETIC_DELEGATE);
      expect(parse(build())).toEqual([]);
    });
  });

  describe('what is not a row', () => {
    it('an Escrow modified by AccountSet is update', () => {
      const row = only(S.accountSetEscrowUpdate);
      expect(row).toMatchObject({ object_type: 'Escrow', action: 'modified', event: 'update', event_fields: '{}' });
      expect(row.previous).toBe('{"Amount":"400000"}');
    });

    it('a threaded node without PreviousFields gives no row; an empty PreviousFields gives one', () => {
      expect(nodeOf(S.channelThreaded, 'PayChannel').PreviousFields).toBeUndefined();
      expect(parse(S.channelThreaded)).toEqual([]);

      for (const type of TRACKED_OBJECT_TYPES) {
        const threaded = envelope('AccountSet', [node('ModifiedNode', type, PARTIES[type], null)]);
        const touched = envelope('AccountSet', [node('ModifiedNode', type, PARTIES[type], {})]);
        expect(parse(threaded)).toEqual([]);
        expect(parse(touched)).toHaveLength(1);
      }
    });

    it('untracked types give no rows', () => {
      const t = envelope('Payment', [
        node('ModifiedNode', 'AccountRoot', { Account: 'rSender', Balance: '1' }, { Balance: '2' }),
        node('ModifiedNode', 'RippleState', { Balance: { value: '1' } }, { Balance: { value: '2' } }),
        node('DeletedNode', 'Offer', { Account: 'rSender' }),
        node('CreatedNode', 'DirectoryNode', { Owner: 'rSender' }),
        node('DeletedNode', 'NFTokenOffer', { Owner: 'rSender' }),
        node('CreatedNode', 'Ticket', { Account: 'rSender' }),
        node('DeletedNode', 'URIToken', { Owner: 'rSender' }),
        { UnknownNode: { LedgerEntryType: 'Escrow', LedgerIndex: 'AB', NewFields: PARTIES.Escrow } },
      ]);
      expect(parse(t)).toEqual([]);
      expect(parse(envelope('Payment', []))).toEqual([]);
      expect(parse(deepFreeze({ ...envelope('Payment', []), meta: { TransactionResult: 'tesSUCCESS' } }))).toEqual([]);
    });

    it('delegated_batch_inner touches no tracked object: no rows', () => {
      const t = recorded('xrpl', 'delegated_batch_inner');
      expect(t.tx.Delegate).toBeDefined();
      expect(parse(t)).toEqual([]);
    });
  });

  describe('a Batch inner transaction', () => {
    it('check_cash_amount, an inner transaction of a Batch (tfInnerBatchTxn, ParentBatchID), gives its own row', () => {
      const t = recorded('xrpl', 'check_cash_amount');
      expect(t.meta.ParentBatchID).toMatch(/^[0-9A-F]{64}$/);
      expect(t.tx.Fee).toBe('0');
      expect(only(t)).toMatchObject({ object_type: 'Check', action: 'deleted', event: 'cash' });
    });

    it('synthetic-delegated-batch-inner-check-cash: the same row with a Delegate on the inner transaction', () => {
      const t = S.delegatedBatchInnerCheckCash;
      expect(t.tx.Delegate).toBe(SYNTHETIC_DELEGATE);
      expect(parse(t)).toEqual(parse(recorded('xrpl', 'check_cash_amount')));
    });
  });

  describe('events', () => {
    it.each(EVENT_TABLE.map((c) => [`${c.type} ${c.op} by ${c.txType}${c.flags ? ` ${c.flags}` : ''}`, c] as const))(
      '%s',
      (_title, c) => {
        const fields = { ...PARTIES[c.type], ...c.final };
        const t = envelope(
          c.txType,
          [node(c.op, c.type, fields, c.previous ?? {})],
          c.flags === undefined ? {} : { Flags: c.flags },
        );
        const row = only(t);
        expect(row.event).toBe(c.event);
        expect(row.action).toBe({ CreatedNode: 'created', ModifiedNode: 'modified', DeletedNode: 'deleted' }[c.op]);
        expect(row.object_type).toBe(c.type);
        expect(OBJECT_EVENTS[c.type]).toContain(row.event);
      },
    );

    it('the table exercises every event of OBJECT_EVENTS and no other', () => {
      for (const type of TRACKED_OBJECT_TYPES) {
        const seen = new Set(EVENT_TABLE.filter((c) => c.type === type).map((c) => c.event));
        expect([...seen].sort()).toEqual([...OBJECT_EVENTS[type]].sort());
      }
    });

    it('whatever the result: tesSUCCESS and tec codes give the row', () => {
      for (const result of ['tesSUCCESS', 'tecNO_TARGET', 'tecEXPIRED', 'tecNO_PERMISSION']) {
        const t = envelope(
          'EscrowCancel',
          [node('DeletedNode', 'Escrow', PARTIES.Escrow)],
          {},
          { TransactionResult: result },
        );
        expect(only(t)).toMatchObject({ event: 'cancel' });
      }
    });

    it('rows follow AffectedNodes, the object_id is the LedgerIndex in upper case, and the other nodes are skipped', () => {
      const t = envelope('AccountDelete', [
        node('DeletedNode', 'AccountRoot', { Account: 'rSender' }),
        node('DeletedNode', 'Delegate', PARTIES.Delegate, {}, 'cd'.repeat(32)),
        node('DeletedNode', 'Escrow', PARTIES.Escrow, {}, 'ef'.repeat(31) + '0a'),
        node('DeletedNode', 'Check', PARTIES.Check, {}, '01'.repeat(32)),
        node('DeletedNode', 'PayChannel', PARTIES.PayChannel, {}, '23'.repeat(32)),
      ]);
      expect(parse(t).map((r) => [r.object_type, r.object_id])).toEqual([
        ['Delegate', 'CD'.repeat(32)],
        ['Escrow', 'EF'.repeat(31) + '0A'],
        ['Check', '01'.repeat(32)],
        ['PayChannel', '23'.repeat(32)],
      ]);
    });

    it('owner is Account; counterparty is Destination, or Authorize for a Delegate', () => {
      for (const type of TRACKED_OBJECT_TYPES) {
        const row = only(envelope('AccountDelete', [node('DeletedNode', type, PARTIES[type])]));
        expect([row.owner, row.counterparty]).toEqual(['rOwner', 'rOther']);
      }
    });

    it('create: the sequence is Sequence, else the TicketSequence; a Sequence of 0 or none uses the ticket', () => {
      const created = (tx: Json) => envelope('EscrowCreate', [node('CreatedNode', 'Escrow', PARTIES.Escrow)], tx);
      expect(only(created({ Sequence: 17 })).event_fields).toBe('{"sequence":17}');
      expect(only(created({ Sequence: 0, TicketSequence: 99 })).event_fields).toBe('{"sequence":99}');
      expect(only(created({ Sequence: undefined, TicketSequence: 99 })).event_fields).toBe('{"sequence":99}');
      expect(only(created({ Sequence: 0 })).event_fields).toBe('{}');
      for (const type of ['CheckCreate', 'PaymentChannelCreate']) {
        const node1 = node('CreatedNode', type === 'CheckCreate' ? 'Check' : 'PayChannel', PARTIES.Check);
        expect(only(envelope(type, [node1], { Sequence: 0, TicketSequence: 4 })).event_fields).toBe('{"sequence":4}');
      }
    });

    it('only finish, cash and create have event_fields', () => {
      const withEverything = { Fulfillment: 'A0028000', Amount: '5', Sequence: 3 };
      const cases: [string, Json][] = [
        ['EscrowCancel', node('DeletedNode', 'Escrow', PARTIES.Escrow)],
        ['AccountDelete', node('DeletedNode', 'Escrow', PARTIES.Escrow)],
        ['CheckCancel', node('DeletedNode', 'Check', PARTIES.Check)],
        ['PaymentChannelClaim', node('DeletedNode', 'PayChannel', PARTIES.PayChannel)],
        ['PaymentChannelFund', node('ModifiedNode', 'PayChannel', PARTIES.PayChannel)],
        ['DelegateSet', node('CreatedNode', 'Delegate', PARTIES.Delegate)],
        ['AccountSet', node('ModifiedNode', 'Escrow', PARTIES.Escrow)],
      ];
      for (const [txType, n] of cases) {
        expect(only(envelope(txType, [n], withEverything, { DeliveredAmount: '5' })).event_fields).toBe('{}');
      }
      expect(
        only(envelope('EscrowFinish', [node('DeletedNode', 'Escrow', PARTIES.Escrow)], withEverything)).event_fields,
      ).toBe('{"fulfillment":"A0028000"}');
    });

    it('fields and previous leave out the thread fields and the directory pages, at the top level only', () => {
      const extra = {
        PreviousTxnID: 'AB',
        PreviousTxnLgrSeq: 1,
        OwnerNode: '0',
        DestinationNode: '1',
        IssuerNode: '2',
        Memo: { OwnerNode: 'kept' },
      };
      const row = only(
        envelope('PaymentChannelClaim', [
          node('ModifiedNode', 'PayChannel', { ...PARTIES.PayChannel, ...extra }, { ...extra, Balance: '0' }),
        ]),
      );
      expect(jsonOf(row.fields)).toEqual({ ...PARTIES.PayChannel, Memo: { OwnerNode: 'kept' } });
      expect(jsonOf(row.previous)).toEqual({ Balance: '0', Memo: { OwnerNode: 'kept' } });
    });

    it('a deleted node’s PreviousFields are kept in previous, and none give {}', () => {
      const withPrevious = only(
        envelope('PaymentChannelClaim', [node('DeletedNode', 'PayChannel', PARTIES.PayChannel, { Balance: '7' })]),
      );
      expect(withPrevious.previous).toBe('{"Balance":"7"}');
      const without = only(
        envelope('PaymentChannelClaim', [node('DeletedNode', 'PayChannel', PARTIES.PayChannel, null)]),
      );
      expect(without.previous).toBe('{}');
    });
  });

  describe('constants', () => {
    it('lists the tracked types, their events, the exclusions and the claim flags', () => {
      expect(TRACKED_OBJECT_TYPES).toEqual(['Escrow', 'Check', 'PayChannel', 'Delegate']);
      expect(OBJECT_EVENTS).toEqual({
        Escrow: ['create', 'finish', 'cancel', 'removed', 'update'],
        Check: ['create', 'cash', 'cancel', 'removed', 'update'],
        PayChannel: ['create', 'fund', 'claim', 'close_request', 'renew', 'close', 'removed', 'update'],
        Delegate: ['set', 'delete', 'removed', 'update'],
      });
      expect(OBJECT_FIELD_EXCLUSIONS).toEqual([
        'PreviousTxnID',
        'PreviousTxnLgrSeq',
        'OwnerNode',
        'DestinationNode',
        'IssuerNode',
      ]);
      expect(TF_RENEW).toBe(0x00010000);
      expect(TF_CLOSE).toBe(0x00020000);
    });
  });

  describe('over every recorded set and the synthetic cases', () => {
    let entries: Entry[] = [];
    beforeAll(() => {
      entries = corpus();
    }, 120_000);

    const rowsOf = () => entries.flatMap((e) => e.rows.map((row) => ({ e, row })));

    it('has the transactions of both networks and the synthetic cases to run over', () => {
      expect(entries.filter((e) => !e.synthetic && e.net === 'xrpl').length).toBeGreaterThan(5000);
      expect(entries.filter((e) => !e.synthetic && e.net === 'xahau').length).toBeGreaterThan(1000);
      expect(entries.filter((e) => e.synthetic)).toHaveLength(SYNTHETIC.length);
      expect(SYNTHETIC).toHaveLength(21);
      expect(new Set(SYNTHETIC.map((s) => s.t.hash)).size).toBe(SYNTHETIC.length);
      for (const s of SYNTHETIC) expect(s.t.hash).toMatch(/^[0-9A-F]{64}$/);
    });

    it('covers every event but the removed rows of escrows, checks and channels, and update except of an Escrow', () => {
      const seen = new Set(rowsOf().map(({ row }) => `${row.object_type} ${row.event}`));
      const expected = TRACKED_OBJECT_TYPES.flatMap((type) =>
        OBJECT_EVENTS[type].map((event) => `${type} ${event}`),
      ).filter(
        (pair) =>
          ![
            'Escrow removed',
            'Check removed',
            'PayChannel removed',
            'Check update',
            'PayChannel update',
            'Delegate update',
          ].includes(pair),
      );
      expect([...seen].sort()).toEqual(expected.sort());
    });

    it('an Escrow created row is at escrowId(owner, event_fields.sequence)', () => {
      const created = rowsOf().filter(({ row }) => row.object_type === 'Escrow' && row.event === 'create');
      expect(created.length).toBeGreaterThanOrEqual(14);
      for (const { e, row } of created) {
        const { sequence } = jsonOf(row.event_fields);
        if (e.name === 'synthetic-escrow-create-no-sequence') {
          expect(sequence).toBeUndefined();
          continue;
        }
        expect(`${e.name}: ${row.object_id}`).toBe(`${e.name}: ${escrowId(row.owner, sequence)}`);
      }
    });

    it('a cash row delivers what the destination’s balance changes say in that currency', () => {
      const cashes = rowsOf().filter(
        ({ e, row }) => !e.synthetic && row.event === 'cash' && e.t.meta.TransactionResult === 'tesSUCCESS',
      );
      expect(cashes.length).toBeGreaterThanOrEqual(12);
      let issued = 0;
      for (const { e, row } of cashes) {
        const delivered = jsonOf(row.event_fields).delivered;
        const currency = typeof delivered === 'string' ? e.ctx.nativeCurrency : delivered.currency;
        if (typeof delivered !== 'string') issued++;
        const destination = balances
          .parse(e.t, e.ctx)
          .filter(
            (b) => b.account === row.counterparty && b.currency === currency && b.change_type !== 'transaction_cost',
          );
        const received = destination.reduce((sum, b) => sum.plus(b.amount_change), new BigNumber(0));
        expect(`${e.name}: ${received.toFixed()}`).toBe(`${e.name}: ${wholeUnits(delivered).toFixed()}`);
      }
      expect(issued).toBeGreaterThanOrEqual(3);
    });

    it("a channel row's Balance minus previous.Balance is the destination's paychannel_payout change", () => {
      const channels = rowsOf().filter(({ e, row }) => !e.synthetic && row.object_type === 'PayChannel');
      let paid = 0;
      let token = 0;
      for (const { e, row } of channels) {
        const previous = jsonOf(row.previous);
        const payouts = balances
          .parse(e.t, e.ctx)
          .filter((b) => b.change_type === 'paychannel_payout' && b.account === row.counterparty);
        const change = payouts.reduce((sum, b) => sum.plus(b.amount_change), new BigNumber(0));
        if (previous.Balance === undefined) {
          expect(`${e.name}: ${change.toFixed()}`).toBe(`${e.name}: 0`);
          continue;
        }
        paid++;
        if (typeof previous.Balance !== 'string') token++;
        const expected = wholeUnits(jsonOf(row.fields).Balance).minus(wholeUnits(previous.Balance));
        expect(`${e.name}: ${change.toFixed()}`).toBe(`${e.name}: ${expected.toFixed()}`);
      }
      expect(paid).toBeGreaterThanOrEqual(7);
      expect(token).toBeGreaterThanOrEqual(1);
    });

    it('fields round-trips through JSON.parse with sorted keys and none of OBJECT_FIELD_EXCLUSIONS', () => {
      const all = rowsOf();
      expect(all.length).toBeGreaterThan(200);
      for (const { e, row } of all) {
        for (const column of ['fields', 'previous', 'event_fields'] as const) {
          const parsed = jsonOf(row[column]);
          expect(`${e.name} ${column}: ${stableStringify(parsed)}`).toBe(`${e.name} ${column}: ${row[column]}`);
          expect(sortedKeys(parsed)).toBe(true);
        }
        for (const excluded of OBJECT_FIELD_EXCLUSIONS) {
          expect(jsonOf(row.fields)).not.toHaveProperty(excluded);
          expect(jsonOf(row.previous)).not.toHaveProperty(excluded);
        }
      }
    });

    it('a row has a 64 digit upper case object_id and the events of its type; untracked types give no rows', () => {
      for (const e of entries) {
        if (trackedNodes(e.t).length === 0) expect(e.rows).toEqual([]);
        for (const row of e.rows) {
          expect(row.object_id).toMatch(/^[0-9A-F]{64}$/);
          expect(OBJECT_EVENTS[row.object_type]).toContain(row.event);
          expect(row.owner).not.toBe('');
          expect(row.counterparty).not.toBe('');
        }
      }
    });

    it('is pure: parsing again gives the same rows, from input that is frozen', () => {
      for (const e of entries) {
        expect(Object.isFrozen(e.t.meta)).toBe(true);
        expect(parser.parse(e.t, e.ctx)).toEqual(e.rows);
      }
    });

    it('equals the oracle on every transaction', () => {
      const different: string[] = [];
      let compared = 0;
      for (const e of entries) {
        const expected = objectOracle(e.t);
        if (e.rows.length === 0 && expected.length === 0) continue;
        compared += expected.length;
        const actual = e.rows.map((r) => ({
          ...r,
          fields: jsonOf(r.fields),
          previous: jsonOf(r.previous),
          event_fields: jsonOf(r.event_fields),
        }));
        try {
          expect(actual).toEqual(expected);
        } catch {
          different.push(e.name);
        }
      }
      expect(different).toEqual([]);
      expect(compared).toBe(rowsOf().length);
      expect(compared).toBeGreaterThan(200);
    });
  });
});
