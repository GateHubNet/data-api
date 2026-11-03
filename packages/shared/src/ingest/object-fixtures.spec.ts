import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { OBJECT_CASES, objectCase, objectFixturesDir, objectLedgers, ObjectNet } from '../test-utils/object-cases';
import { RawLedger, RawTransaction } from './raw-ledger';

/**
 * Guards `test/fixtures/{xrpl,xahau}/objects`: the named escrow, check, payment channel and delegation cases that the D5
 * parser, writer and API tests look up through `src/test-utils/object-cases.ts`. `FINDINGS.md` next to the ledgers says
 * what each case shows and lists the names that were not found on the network (they become synthetic transactions in the
 * tests that need them); the checks below pin the facts the cases are chosen for, so a re-recording that picks a different
 * transaction cannot silently change them.
 */
interface Case {
  ledger: number;
  hash: string;
  type: string;
  note: string;
}

interface Manifest {
  cases: Record<string, Case>;
  txs: Record<string, { ledger: number; type: string; result: string }>;
  ledgers: { ledger: number }[];
}

const NETS = ['xrpl', 'xahau'] as const;

const manifestOf = (net: ObjectNet): Manifest =>
  JSON.parse(readFileSync(join(objectFixturesDir(net), 'manifest.json'), 'utf8')) as Manifest;

/** The names under the "Not found" heading of `FINDINGS.md`: one bullet each, the name in backticks first. */
function notFoundNames(net: ObjectNet): string[] {
  const lines = readFileSync(join(objectFixturesDir(net), 'FINDINGS.md'), 'utf8').split('\n');
  const start = lines.findIndex((line) => /^##\s+Not found\s*$/.test(line));
  if (start < 0) throw new Error(`${net}/objects/FINDINGS.md has no "## Not found" section`);
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    const match = /^- `([a-z_]+)`/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

/** The cases of the set that were found and recorded. */
const casesOf = (net: ObjectNet): string[] => OBJECT_CASES[net].filter((name) => objectCase(net, name) !== undefined);

/** The case's recorded transaction; the case must have been found. */
function recorded(net: ObjectNet, name: string): { ledger: RawLedger; tx: RawTransaction } {
  const found = objectCase(net, name);
  if (!found) throw new Error(`${net}/objects: ${name} is not recorded`);
  return found;
}

/** Cases of the set that FINDINGS.md lists as not found: a test about one of them states why it has nothing to check. */
const isNotFound = (net: ObjectNet, name: string): boolean => notFoundNames(net).includes(name);

const field = (t: RawTransaction, name: string): any => t.tx[name];

interface Node {
  op: 'CreatedNode' | 'ModifiedNode' | 'DeletedNode';
  type: string;
  /** The node's fields after the transaction (`FinalFields` or `NewFields`). */
  after: Record<string, any>;
  /** `PreviousFields` alone: only the fields the transaction changed or removed (an added field is not in it). */
  previous: Record<string, any>;
}

function nodesOf(t: RawTransaction): Node[] {
  return (t.meta.AffectedNodes as Record<string, any>[]).map((entry) => {
    const op = Object.keys(entry)[0] as Node['op'];
    const body = entry[op];
    return {
      op,
      type: body.LedgerEntryType as string,
      after: { ...body.FinalFields, ...body.NewFields },
      previous: { ...body.PreviousFields },
    };
  });
}

const nodesOfType = (t: RawTransaction, type: string, op?: Node['op']) =>
  nodesOf(t).filter((n) => n.type === type && (op === undefined || n.op === op));

/** The ledger's close time in Ripple-epoch seconds, the unit of `Expiration` and `CancelAfter` (the header has unix seconds). */
const rippleCloseTime = (ledger: RawLedger): number => ledger.header.close_time - 946_684_800;

const TF_CLOSE = 0x00020000;
const TF_RENEW = 0x00010000;
const flagsOf = (t: RawTransaction): number => (field(t, 'Flags') as number | undefined) ?? 0;
const isIssued = (amount: unknown): boolean =>
  typeof amount === 'object' && amount !== null && !('mpt_issuance_id' in amount);

/** The reason of the first check that fails, or null when every check holds. */
const unless = (...checks: [ok: boolean, reason: string][]): string | null => checks.find(([ok]) => !ok)?.[1] ?? null;

/** What a case's transaction must show beyond its type: null when it does, else a short reason. */
type Shows = (t: RawTransaction, ledger: RawLedger) => string | null;

const XRPL_SHOWS: Record<string, Shows> = {
  escrow_create_timed: (t) =>
    unless(
      [field(t, 'FinishAfter') !== undefined, 'has no FinishAfter'],
      [field(t, 'CancelAfter') !== undefined, 'has no CancelAfter'],
      [field(t, 'Condition') === undefined, 'has a Condition'],
      [nodesOfType(t, 'Escrow', 'CreatedNode').length === 1, 'does not create one Escrow'],
    ),
  escrow_create_conditional: (t) =>
    unless(
      [field(t, 'Condition') !== undefined, 'has no Condition'],
      [nodesOfType(t, 'Escrow', 'CreatedNode').length === 1, 'does not create one Escrow'],
    ),
  escrow_create_ticket: (t) =>
    unless(
      [field(t, 'Sequence') === 0, 'Sequence is not 0'],
      [field(t, 'TicketSequence') !== undefined, 'no TicketSequence'],
    ),
  escrow_finish_timed: (t) =>
    unless(
      [field(t, 'Fulfillment') === undefined, 'has a Fulfillment'],
      [nodesOfType(t, 'Escrow', 'DeletedNode').length === 1, 'does not delete one Escrow'],
    ),
  escrow_finish_fulfillment: (t) =>
    unless(
      [field(t, 'Fulfillment') !== undefined, 'has no Fulfillment'],
      [field(t, 'Condition') !== undefined, 'has no Condition'],
      [nodesOfType(t, 'Escrow', 'DeletedNode').length === 1, 'does not delete one Escrow'],
    ),
  escrow_cancel: (t) => unless([nodesOfType(t, 'Escrow', 'DeletedNode').length === 1, 'does not delete one Escrow']),
  escrow_create_token: (t) =>
    unless(
      [isIssued(field(t, 'Amount')), 'Amount is not an issued token'],
      [nodesOfType(t, 'Escrow', 'CreatedNode').length === 1, 'does not create one Escrow'],
      [nodesOfType(t, 'RippleState').length > 0, 'moves no trust line'],
    ),
  escrow_finish_token: (t) => {
    const escrow = nodesOfType(t, 'Escrow', 'DeletedNode');
    return unless(
      [escrow.length === 1, 'does not delete one Escrow'],
      [isIssued(escrow[0]?.after.Amount), 'the escrow holds no issued token'],
      [nodesOfType(t, 'RippleState').length > 0, 'moves no trust line'],
    );
  },
  escrow_create_mpt: (t) =>
    unless(
      [
        typeof field(t, 'Amount') === 'object' && 'mpt_issuance_id' in field(t, 'Amount'),
        'Amount is not an MPT amount',
      ],
      [nodesOfType(t, 'Escrow', 'CreatedNode').length === 1, 'does not create one Escrow'],
    ),
  check_create_xrp: (t) =>
    unless(
      [typeof field(t, 'SendMax') === 'string', 'SendMax is not native'],
      [nodesOfType(t, 'Check', 'CreatedNode').length === 1, 'does not create one Check'],
    ),
  check_create_token: (t) =>
    unless(
      [isIssued(field(t, 'SendMax')), 'SendMax is not an issued token'],
      [field(t, 'InvoiceID') !== undefined, 'has no InvoiceID'],
      [field(t, 'Expiration') !== undefined, 'has no Expiration'],
      [nodesOfType(t, 'Check', 'CreatedNode').length === 1, 'does not create one Check'],
    ),
  check_cash_amount: (t) =>
    unless(
      [field(t, 'Amount') !== undefined, 'has no Amount'],
      [field(t, 'DeliverMin') === undefined, 'has a DeliverMin'],
      [nodesOfType(t, 'Check', 'DeletedNode').length === 1, 'does not delete one Check'],
    ),
  check_cash_deliver_min: (t) =>
    unless(
      [field(t, 'DeliverMin') !== undefined, 'has no DeliverMin'],
      [field(t, 'Amount') === undefined, 'has an Amount'],
      [nodesOfType(t, 'Check', 'DeletedNode').length === 1, 'does not delete one Check'],
    ),
  check_cancel_source: (t) => {
    const check = nodesOfType(t, 'Check', 'DeletedNode');
    return unless(
      [check.length === 1, 'does not delete one Check'],
      [check[0]?.after.Account === field(t, 'Account'), 'the sender is not the check source'],
    );
  },
  check_cancel_third_party_expired: (t, ledger) => {
    const check = nodesOfType(t, 'Check', 'DeletedNode');
    return unless(
      [check.length === 1, 'does not delete one Check'],
      [check[0]?.after.Account !== field(t, 'Account'), 'the sender is the check source'],
      [check[0]?.after.Destination !== field(t, 'Account'), 'the sender is the check destination'],
      [check[0]?.after.Expiration <= rippleCloseTime(ledger), 'the check had not expired'],
    );
  },
  channel_create: (t) =>
    unless(
      [field(t, 'SettleDelay') !== undefined, 'has no SettleDelay'],
      [nodesOfType(t, 'PayChannel', 'CreatedNode').length === 1, 'does not create one PayChannel'],
    ),
  channel_fund_expiration: (t) =>
    unless(
      [field(t, 'Expiration') !== undefined, 'has no Expiration'],
      [nodesOfType(t, 'PayChannel', 'ModifiedNode').length === 1, 'does not modify one PayChannel'],
    ),
  // the first claim of a channel: its Balance was "0" (FINDINGS 6; Task 11's `claims` count relies on it)
  channel_claim: (t) => {
    const channel = nodesOfType(t, 'PayChannel', 'ModifiedNode');
    return unless(
      [(flagsOf(t) & (TF_CLOSE | TF_RENEW)) === 0, 'has tfClose or tfRenew'],
      [field(t, 'Balance') !== undefined, 'has no Balance'],
      [channel.length === 1, 'does not modify one PayChannel'],
      [channel[0]?.previous.Balance === '0', 'PreviousFields.Balance is not "0"'],
    );
  },
  channel_close_request: (t) => {
    const channel = nodesOfType(t, 'PayChannel', 'ModifiedNode');
    return unless(
      [(flagsOf(t) & TF_CLOSE) !== 0, 'has no tfClose'],
      [channel.length === 1, 'does not modify one PayChannel'],
      [channel[0]?.after.Expiration !== undefined, 'the channel got no Expiration'],
      [channel[0]?.after.Account === field(t, 'Account'), 'the sender is not the channel source'],
    );
  },
  channel_close_destination: (t) => {
    const channel = nodesOfType(t, 'PayChannel', 'DeletedNode');
    return unless(
      [(flagsOf(t) & TF_CLOSE) !== 0, 'has no tfClose'],
      [channel.length === 1, 'does not delete one PayChannel'],
      [channel[0]?.after.Destination === field(t, 'Account'), 'the sender is not the channel destination'],
    );
  },
  channel_renew: (t) => {
    const channel = nodesOfType(t, 'PayChannel', 'ModifiedNode');
    return unless(
      [(flagsOf(t) & TF_RENEW) !== 0, 'has no tfRenew'],
      [channel.length === 1, 'does not modify one PayChannel'],
      [channel[0]?.previous.Expiration !== undefined, 'the renew removed no Expiration'],
      [channel[0]?.after.Expiration === undefined, 'the channel kept its Expiration'],
    );
  },
  channel_close_expired: (t, ledger) => {
    const channel = nodesOfType(t, 'PayChannel', 'DeletedNode');
    return unless(
      [channel.length === 1, 'does not delete one PayChannel'],
      [
        channel[0]?.after.Expiration <= rippleCloseTime(ledger) ||
          channel[0]?.after.CancelAfter <= rippleCloseTime(ledger),
        'the channel had not expired',
      ],
    );
  },
  delegate_set_create: (t) =>
    unless(
      [Array.isArray(field(t, 'Permissions')) && field(t, 'Permissions').length > 0, 'has no Permissions'],
      [nodesOfType(t, 'Delegate', 'CreatedNode').length === 1, 'does not create one Delegate'],
    ),
  delegate_set_replace: (t) =>
    unless(
      [Array.isArray(field(t, 'Permissions')) && field(t, 'Permissions').length > 0, 'has no Permissions'],
      [nodesOfType(t, 'Delegate', 'ModifiedNode').length === 1, 'does not modify one Delegate'],
    ),
  delegate_set_empty: (t) =>
    unless(
      [!field(t, 'Permissions') || field(t, 'Permissions').length === 0, 'has Permissions'],
      [nodesOfType(t, 'Delegate', 'DeletedNode').length === 1, 'does not delete one Delegate'],
    ),
  delegated_payment: (t) =>
    unless([
      field(t, 'Delegate') !== undefined && field(t, 'Delegate') !== field(t, 'Account'),
      'no Delegate other than the sender',
    ]),
  delegated_tec: (t) =>
    unless([
      field(t, 'Delegate') !== undefined && field(t, 'Delegate') !== field(t, 'Account'),
      'no Delegate other than the sender',
    ]),
  delegated_batch_inner: (t, ledger) =>
    unless(
      [
        field(t, 'Delegate') !== undefined && field(t, 'Delegate') !== field(t, 'Account'),
        'no Delegate other than the sender',
      ],
      [field(t, 'Fee') === '0', 'Fee is not "0"'],
      [ledger.transactions.some((o) => o.tx.TransactionType === 'Batch'), 'the ledger holds no Batch'],
    ),
};

const XAHAU_SHOWS: Record<string, Shows> = {
  escrow_create: (t) => unless([nodesOfType(t, 'Escrow', 'CreatedNode').length === 1, 'does not create one Escrow']),
  escrow_finish: (t) => unless([nodesOfType(t, 'Escrow', 'DeletedNode').length === 1, 'does not delete one Escrow']),
  escrow_finish_escrow_id: (t) =>
    unless(
      [/^[0-9A-F]{64}$/.test(field(t, 'EscrowID') ?? ''), 'has no EscrowID'],
      [nodesOfType(t, 'Escrow', 'DeletedNode').length === 1, 'does not delete one Escrow'],
    ),
  escrow_cancel: (t) => unless([nodesOfType(t, 'Escrow', 'DeletedNode').length === 1, 'does not delete one Escrow']),
  escrow_create_token: (t) =>
    unless(
      [isIssued(field(t, 'Amount')), 'Amount is not an issued token'],
      [nodesOfType(t, 'Escrow', 'CreatedNode').length === 1, 'does not create one Escrow'],
    ),
  check_create: (t) => unless([nodesOfType(t, 'Check', 'CreatedNode').length === 1, 'does not create one Check']),
  check_cash: (t) => unless([nodesOfType(t, 'Check', 'DeletedNode').length === 1, 'does not delete one Check']),
  channel_create: (t) =>
    unless([nodesOfType(t, 'PayChannel', 'CreatedNode').length === 1, 'does not create one PayChannel']),
  channel_claim: (t) =>
    unless([nodesOfType(t, 'PayChannel', 'ModifiedNode').length === 1, 'does not modify one PayChannel']),
  channel_create_token: (t) =>
    unless(
      [isIssued(field(t, 'Amount')), 'Amount is not an issued token'],
      [nodesOfType(t, 'PayChannel', 'CreatedNode').length === 1, 'does not create one PayChannel'],
    ),
  channel_claim_token: (t) => {
    const channel = nodesOfType(t, 'PayChannel');
    return unless(
      [channel.length === 1, 'does not touch one PayChannel'],
      [isIssued(channel[0]?.after.Amount), 'the channel holds no issued token'],
    );
  },
};

const SHOWS: Record<ObjectNet, Record<string, Shows>> = { xrpl: XRPL_SHOWS, xahau: XAHAU_SHOWS };

/** The transaction type each case name stands for. */
const TYPE_OF_PREFIX: [prefix: string, type: string][] = [
  ['escrow_create', 'EscrowCreate'],
  ['escrow_finish', 'EscrowFinish'],
  ['escrow_cancel', 'EscrowCancel'],
  ['check_create', 'CheckCreate'],
  ['check_cash', 'CheckCash'],
  ['check_cancel', 'CheckCancel'],
  ['channel_create', 'PaymentChannelCreate'],
  ['channel_fund', 'PaymentChannelFund'],
  ['channel_', 'PaymentChannelClaim'],
  ['delegate_set', 'DelegateSet'],
  ['delegated_payment', 'Payment'],
];
const typeOfCase = (name: string): string | undefined =>
  TYPE_OF_PREFIX.find(([prefix]) => name.startsWith(prefix))?.[1];

describe.each(NETS)('%s/objects fixtures', (net) => {
  const manifest = manifestOf(net);

  it('every case is recorded or listed as not found in FINDINGS.md', () => {
    expect(Object.keys(manifest.cases).filter((name) => !OBJECT_CASES[net].includes(name))).toEqual([]);
    const missing = OBJECT_CASES[net].filter((name) => manifest.cases[name] === undefined);
    expect(missing.sort()).toEqual(notFoundNames(net).sort());
  });

  it('every recorded ledger is a case ledger or a transaction the manifest records, and the files match the manifest', () => {
    const files = readdirSync(objectFixturesDir(net))
      .filter((name) => /^\d+\.json\.gz$/.test(name))
      .map((name) => Number(name.slice(0, name.indexOf('.'))))
      .sort((a, b) => a - b);
    expect(manifest.ledgers.map((l) => l.ledger).sort((a, b) => a - b)).toEqual(files);
    expect(objectLedgers(net).map((l) => l.header.ledger_index)).toEqual(files);
    const withTx = new Set(Object.values(manifest.txs).map((t) => t.ledger));
    for (const file of files) expect(withTx.has(file)).toBe(true);
    for (const c of Object.values(manifest.cases)) expect(withTx.has(c.ledger)).toBe(true);
  });

  it('the not-found names are real case names, and none of them is also a case', () => {
    for (const name of notFoundNames(net)) {
      expect(OBJECT_CASES[net]).toContain(name);
      expect(manifest.cases[name]).toBeUndefined();
    }
  });

  describe.each(casesOf(net))('case %s', (name) => {
    it('its ledger holds the hash with the manifest type and a tesSUCCESS result (delegated_tec: a tec)', () => {
      const c = manifest.cases[name];
      const { ledger, tx } = recorded(net, name);
      expect(ledger.header.ledger_index).toBe(c.ledger);
      expect(tx.hash).toBe(c.hash);
      expect(tx.hash).toMatch(/^[0-9A-F]{64}$/);
      expect(tx.tx.TransactionType).toBe(c.type);
      const expectedType = typeOfCase(name);
      if (expectedType !== undefined && net === 'xrpl') expect(c.type).toBe(expectedType);
      expect(manifest.txs[c.hash]).toEqual({ ledger: c.ledger, type: c.type, result: tx.meta.TransactionResult });
      const result = tx.meta.TransactionResult as string;
      // C21: a tesSUCCESS everywhere but the delegated tec; the close of an expired channel may be a tec too
      if (name === 'delegated_tec') expect(result).toMatch(/^tec/);
      else if (name === 'channel_close_expired') expect(result).toMatch(/^te[cs]/);
      else expect(result).toBe('tesSUCCESS');
      expect(c.note.length).toBeGreaterThan(40);
    });

    it('shows what the case is for', () => {
      const { ledger, tx } = recorded(net, name);
      expect(SHOWS[net][name]).toBeDefined();
      expect(SHOWS[net][name](tx, ledger)).toBeNull();
    });
  });
});

describe('what the cases say beyond their tables', () => {
  it('escrow_create_ticket has Sequence 0 and a TicketSequence', () => {
    if (!objectCase('xrpl', 'escrow_create_ticket'))
      return expect(isNotFound('xrpl', 'escrow_create_ticket')).toBe(true);
    const { tx } = recorded('xrpl', 'escrow_create_ticket');
    expect(tx.tx.Sequence).toBe(0);
    expect(typeof tx.tx.TicketSequence).toBe('number');
  });

  it('check_cash_deliver_min has DeliverMin and no Amount', () => {
    if (!objectCase('xrpl', 'check_cash_deliver_min'))
      return expect(isNotFound('xrpl', 'check_cash_deliver_min')).toBe(true);
    const { tx } = recorded('xrpl', 'check_cash_deliver_min');
    expect(tx.tx.DeliverMin).toBeDefined();
    expect(tx.tx.Amount).toBeUndefined();
  });

  it.each(['delegated_payment', 'delegated_tec'])('%s carries a Delegate other than Account', (name) => {
    if (!objectCase('xrpl', name)) return expect(isNotFound('xrpl', name)).toBe(true);
    const { tx } = recorded('xrpl', name);
    expect(typeof tx.tx.Delegate).toBe('string');
    expect(tx.tx.Delegate).not.toBe(tx.tx.Account);
  });

  it('escrow_finish_escrow_id carries EscrowID', () => {
    if (!objectCase('xahau', 'escrow_finish_escrow_id'))
      return expect(isNotFound('xahau', 'escrow_finish_escrow_id')).toBe(true);
    const { tx } = recorded('xahau', 'escrow_finish_escrow_id');
    expect(tx.tx.EscrowID).toMatch(/^[0-9A-F]{64}$/);
  });

  it('objectCase refuses a name that is not one of the set', () => {
    expect(() => objectCase('xrpl', 'no_such_case')).toThrow('no case named');
    expect(() => objectCase('xahau', 'channel_renew')).toThrow('no case named');
  });
});
