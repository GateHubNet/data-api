import { amendmentId, ObjectChangesRow, Table } from '@gatehub/data-api-shared';
import { classicAddressToXAddress } from 'ripple-address-codec';
import { DELEGATION_IDS_CAP } from '../src/accounts/delegations.service';
import { COVERAGE_KEYS } from '../src/common/feature-coverage.service';
import {
  DELEGATION_CSV_COLUMNS,
  DELEGATION_KEYS,
  DELEGATIONS_BODY_KEYS,
  OBJECT_REF_KEYS,
  PERMISSION_KEYS,
} from '../src/ledger-objects/object-views';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { accountAt, cells, decodeMarker, hashOf, iso, lines } from './support/amm';
import { csvDisposition } from './support/csv';
import { insertObjects, jsonOf, objectRow, seedObjects, SYNTHETIC_CLOSE_TIME } from './support/objects';
import { markerOf, readsOf } from './support/read-rows';
import { insertState } from './support/validators-seed';

/**
 * `GET /v2/accounts/{address}/delegations` (D5, spec 5.6) on a real ClickHouse: the delegation the recorded ledgers of the
 * `xrpl-objects` set hold (`rnt8Pb…` authorizing `rw2X2G…` for OfferCreate and OfferCancel, a recorded `DelegateSet`), and the
 * delegations made by hand (their transactions say `synthetic-…`) for what no ledger recorded: a list replaced by a later
 * `DelegateSet`, a list emptied (the node deleted), an entry deleted and made again under the same ID, an entry whose creation
 * is older than the index, rows above the committed head, rows with the same place in the ledger, and accounts with 10,000 and
 * 10,001 delegations. The recorded `delegate_set_replace` and `delegate_set_empty` do not exist (FINDINGS of the objects
 * fixtures, "Not found"): their rows are built the way the parser writes them (events `set` and `delete`).
 *
 * The coverage of delegations is the amendment's (`PermissionDelegationV1_1`, enabled in 107,524,865 according to the metadata
 * of the network), and Xahau has no delegation: its list is empty and complete, and the tables are not read.
 */

const RIPPLE_EPOCH = 946_684_800;
const CACHE_ROUTE = async () => (await import('./cache-controllers')).CACHE_CONTROLLERS;

type Obj = Record<string, unknown>;

/** `entry` has the keys of `order` it has, and in that order: none out of place, none made up. */
function expectKeysInOrder(entry: object, order: readonly string[]): void {
  const keys = Object.keys(entry);
  expect(keys).toEqual(order.filter((k) => keys.includes(k)));
}

/**
 * Lists the amendment delegations start at in the ledger state the api reads the amendments from: the metadata of the network gives
 * it an enable ledger (107,524,865) only once the ledger state says it is enabled.
 */
async function listDelegation(h: Harness, ledgerIndex: number): Promise<void> {
  await insertState(h.ch, [
    {
      ledger_index: ledgerIndex,
      polled_at: Date.now() / 1000 - 5,
      amendments: [amendmentId('PermissionDelegationV1_1')],
    },
  ]);
}

const X_ADDRESS = classicAddressToXAddress(accountAt(0xd610), false, false);

/** One change of a delegation: the ledger and place it was made at, what the node became, and the permissions it then holds. */
interface Step {
  ledger: number;
  tx: number;
  action: 'created' | 'modified' | 'deleted';
  /** The `PermissionValue`s of the node after the change (a deleted node's are its last): a name or a number. */
  permissions: (string | number)[];
}

/** The close time of a ledger made by hand (a second a ledger from 107,900,000). */
const closeOf = (ledger: number): number => SYNTHETIC_CLOSE_TIME + (ledger - 107_900_000);

/** The hash of the transaction of a step: `objectRow`'s own. */
const hashAt = (id: string, step: Pick<Step, 'ledger' | 'tx'>): string =>
  `synthetic-${step.ledger}-${step.tx}-${id.slice(0, 8)}`;

/** The rows of `object_changes` a `DelegateSet` leaves for each step, as the parser writes them (`set` for a created or modified node, `delete` for a deleted). */
function delegation(id: string, owner: string, authorize: string, steps: Step[]): ObjectChangesRow[] {
  return steps.map((step) =>
    objectRow({
      object_type: 'Delegate',
      object_id: id,
      ledger_index: step.ledger,
      tx_index: step.tx,
      close_time: closeOf(step.ledger),
      tx_type: 'DelegateSet',
      sender: owner,
      action: step.action,
      event: step.action === 'deleted' ? 'delete' : 'set',
      owner,
      counterparty: authorize,
      fields: jsonOf({
        Account: owner,
        Authorize: authorize,
        Permissions: step.permissions.map((value) => ({ Permission: { PermissionValue: value } })),
      }),
    }),
  );
}

/** What a step is in an answer: `updated` and `created`. */
const refOf = (id: string, step: Step): Obj => ({
  ledger_index: step.ledger,
  time: iso(closeOf(step.ledger)),
  tx_hash: hashAt(id, step),
});

// =====================================================================================================================
// the recorded XRPL ledgers, and delegations made by hand
// =====================================================================================================================

describe('the delegations of an account over the recorded xrpl ledgers', () => {
  const HEAD = 107_972_102;
  const HEAD_CLOSE = 1_793_245_841;
  /** The oldest recorded ledger: where the coverage of the objects starts (every ledger is written by the parser of the objects). */
  const FIRST = 102_145_584;

  // recorded (xrpl-objects): the DelegateSet of ledger 107558036
  const RECORDED = 'E63226B764F4D7C198DBF8E4DE0F5DA4F9C1AC449C2927F2150C0B731E020851';
  const DELEGATOR = 'rnt8PbBFT7idcLyj9PNgxjZi9Z1RiRX3QL';
  const DELEGATE = 'rw2X2GFePFiLDdcQw6iELFfUEw1hPqAGcK';
  const RECORDED_TX = '4250B72A5AB63CEB5501CFDDA3B4C9765B85941BB6AECE9720FC6C0D5F524B66';
  const RECORDED_LEDGER = 107_558_036;
  const RECORDED_TIME = 844_938_200 + RIPPLE_EPOCH;
  const RECORDED_REF = { ledger_index: RECORDED_LEDGER, time: iso(RECORDED_TIME), tx_hash: RECORDED_TX };

  // made by hand
  const GIVER = accountAt(0xd610);
  const OTHER = accountAt(0xd620);
  const authorized = (n: number): string => accountAt(0xd700 + n);

  const REPLACED = hashOf(0xde0001);
  const EMPTIED = hashOf(0xde0002);
  const RECREATED = hashOf(0xde0003);
  const NO_CREATION = hashOf(0xde0004);
  const ABOVE_CHANGED = hashOf(0xde0005);
  const ABOVE_CREATED = hashOf(0xde0006);
  const HELD = hashOf(0xde0007);

  const REPLACED_STEPS: Step[] = [
    { ledger: 107_900_000, tx: 1, action: 'created', permissions: ['Payment'] },
    // the list replaced: a granular permission, a transaction type by name, by number (Payment is 0, so 1), and a value that is none
    { ledger: 107_910_000, tx: 3, action: 'modified', permissions: [65537, 'OfferCreate', 1, 70000] },
  ];
  const EMPTIED_STEPS: Step[] = [
    { ledger: 107_901_000, tx: 2, action: 'created', permissions: ['Payment'] },
    { ledger: 107_920_000, tx: 1, action: 'deleted', permissions: ['Payment'] },
  ];
  const RECREATED_STEPS: Step[] = [
    { ledger: 107_902_000, tx: 1, action: 'created', permissions: ['Payment'] },
    { ledger: 107_930_000, tx: 1, action: 'deleted', permissions: ['Payment'] },
    { ledger: 107_940_000, tx: 2, action: 'created', permissions: ['TrustSet'] },
    { ledger: 107_950_000, tx: 4, action: 'modified', permissions: ['TrustSet', 'AccountSet'] },
  ];
  const NO_CREATION_STEPS: Step[] = [{ ledger: 107_905_000, tx: 6, action: 'modified', permissions: ['Payment'] }];
  const ABOVE_CHANGED_STEPS: Step[] = [
    { ledger: 107_960_000, tx: 1, action: 'created', permissions: ['Payment'] },
    // above the committed head: the ledger is not committed, so the list is as it was
    { ledger: HEAD + 1, tx: 2, action: 'modified', permissions: ['OfferCreate'] },
  ];
  const ABOVE_CREATED_STEPS: Step[] = [{ ledger: HEAD + 1, tx: 1, action: 'created', permissions: ['Payment'] }];
  const HELD_STEPS: Step[] = [{ ledger: 107_935_000, tx: 2, action: 'created', permissions: ['Payment'] }];

  /** The delegations the giver has now, by `updated` newest first (the emptied one is gone). */
  const GIVEN = [ABOVE_CHANGED, RECREATED, REPLACED, NO_CREATION];

  const rows = [
    ...delegation(REPLACED, GIVER, authorized(1), REPLACED_STEPS),
    ...delegation(EMPTIED, GIVER, authorized(2), EMPTIED_STEPS),
    ...delegation(RECREATED, GIVER, authorized(3), RECREATED_STEPS),
    ...delegation(NO_CREATION, GIVER, authorized(4), NO_CREATION_STEPS),
    ...delegation(ABOVE_CHANGED, GIVER, authorized(5), ABOVE_CHANGED_STEPS),
    ...delegation(ABOVE_CREATED, GIVER, authorized(6), ABOVE_CREATED_STEPS),
    // the giver holds one too, from another account
    ...delegation(HELD, OTHER, GIVER, HELD_STEPS),
  ];

  /** The answer of each delegation of the giver, from its steps. */
  const expected: Record<string, Obj> = {
    [REPLACED]: {
      delegation_id: REPLACED,
      account: GIVER,
      authorize: authorized(1),
      permissions: [
        { permission: 'TrustlineAuthorize', kind: 'granular', transaction_type: 'TrustSet' },
        { permission: 'OfferCreate', kind: 'transaction' },
        { permission: 'Payment', kind: 'transaction' },
        { permission: '70000', kind: 'unknown' },
      ],
      updated: refOf(REPLACED, REPLACED_STEPS[1]),
      created: refOf(REPLACED, REPLACED_STEPS[0]),
    },
    [RECREATED]: {
      delegation_id: RECREATED,
      account: GIVER,
      authorize: authorized(3),
      permissions: [
        { permission: 'TrustSet', kind: 'transaction' },
        { permission: 'AccountSet', kind: 'transaction' },
      ],
      updated: refOf(RECREATED, RECREATED_STEPS[3]),
      // the creation of the entry it is now: the one after the delete, not the first
      created: refOf(RECREATED, RECREATED_STEPS[2]),
    },
    [NO_CREATION]: {
      delegation_id: NO_CREATION,
      account: GIVER,
      authorize: authorized(4),
      permissions: [{ permission: 'Payment', kind: 'transaction' }],
      updated: refOf(NO_CREATION, NO_CREATION_STEPS[0]),
    },
    [ABOVE_CHANGED]: {
      delegation_id: ABOVE_CHANGED,
      account: GIVER,
      authorize: authorized(5),
      permissions: [{ permission: 'Payment', kind: 'transaction' }],
      updated: refOf(ABOVE_CHANGED, ABOVE_CHANGED_STEPS[0]),
      created: refOf(ABOVE_CHANGED, ABOVE_CHANGED_STEPS[0]),
    },
    [HELD]: {
      delegation_id: HELD,
      account: OTHER,
      authorize: GIVER,
      permissions: [{ permission: 'Payment', kind: 'transaction' }],
      updated: refOf(HELD, HELD_STEPS[0]),
      created: refOf(HELD, HELD_STEPS[0]),
    },
  };

  // the pager: seven delegations, one of them emptied, two with the same place in the ledger
  const PAGER = accountAt(0xd630);
  /** The IDs of the two delegations changed by the same transaction (the same ledger and place): the lower ID comes first. */
  const TIE_LOW = hashOf(0xde0101);
  const TIE_HIGH = hashOf(0xde0102);
  const PAGER_OLD = hashOf(0xde0103);
  const PAGER_3 = hashOf(0xde0104);
  const PAGER_4 = hashOf(0xde0105);
  const PAGER_5 = hashOf(0xde0106);
  const PAGER_6 = hashOf(0xde0107);
  const pagerRows = (() => {
    const at = (ledger: number, tx: number): Step => ({ ledger, tx, action: 'created', permissions: ['Payment'] });
    return [
      // inserted out of the order they are served in: the order is the read's, not the table's
      ...delegation(PAGER_6, PAGER, authorized(16), [at(107_940_000, 0)]),
      ...delegation(TIE_HIGH, PAGER, authorized(12), [at(107_960_000, 5)]),
      ...delegation(PAGER_4, PAGER, authorized(14), [at(107_950_000, 9)]),
      ...delegation(TIE_LOW, PAGER, authorized(11), [at(107_960_000, 5)]),
      ...delegation(PAGER_OLD, PAGER, authorized(17), [
        at(107_930_000, 1),
        { ledger: 107_970_000, tx: 1, action: 'deleted', permissions: ['Payment'] },
      ]),
      ...delegation(PAGER_5, PAGER, authorized(15), [at(107_950_000, 1)]),
      ...delegation(PAGER_3, PAGER, authorized(13), [at(107_960_000, 2)]),
    ];
  })();
  /** What the pager gives, from the newest to the oldest. */
  const PAGER_ORDER = [TIE_LOW, TIE_HIGH, PAGER_3, PAGER_4, PAGER_5, PAGER_6];

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];

  beforeAll(async () => {
    h = await startHarness({ seed: 'xrpl-objects', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
    get = api.get;
    await listDelegation(h, HEAD);
    await insertObjects(h, [...rows, ...pagerRows]);
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  /** The ids of the delegations of a body, in order. */
  const idsOf = (body: Obj): string[] => (body.delegations as Obj[]).map((d) => String(d.delegation_id));

  it('the data is as the tests assume', async () => {
    const head = await h.ch.queryOne<{ ledger_index: number; t: number }>(
      `SELECT ledger_index, toUnixTimestamp(close_time) AS t FROM ${Table.Ledgers} ORDER BY ledger_index DESC LIMIT 1`,
    );
    expect([head?.ledger_index, Number(head?.t)]).toEqual([HEAD, HEAD_CLOSE]);
    // the recorded delegation: one row of the object, one of each side in the index by account
    const [recorded] = await h.ch.query<{ n: string; roles: string }>(
      `SELECT count() AS n, groupArray(role) AS roles FROM ${Table.AccountObjectChanges}
        WHERE object_type = 'Delegate' AND object_id = {id:String}`,
      { id: RECORDED },
    );
    expect(Number(recorded.n)).toBe(2);
    const [object] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.ObjectChanges} WHERE object_type = 'Delegate' AND object_id = {id:String}`,
      { id: RECORDED },
    );
    expect(Number(object.n)).toBe(1);
  });

  // -- given and held ---------------------------------------------------------------------------------------------------

  it('lists the delegations an account gave and those it holds', async () => {
    // recorded: the delegator gave one, the delegate holds it; the other direction of each is empty
    const given = await api.ok(`/v2/accounts/${DELEGATOR}/delegations`, 'delegations');
    expect(given.headers['cache-control']).toBe('private, max-age=60');
    const body = given.body as Obj;
    expect(Object.keys(body)).toEqual(DELEGATIONS_BODY_KEYS.filter((k) => k !== 'marker'));
    expect(body.coverage).toEqual({ from_ledger_index: FIRST, complete: true });
    expect(Object.keys(body.coverage as Obj)).toEqual([...COVERAGE_KEYS]);
    expect([body.ledger_index, body.close_time, body.count]).toEqual([HEAD, iso(HEAD_CLOSE), 1]);
    expect(body.delegations).toEqual([
      {
        delegation_id: RECORDED,
        account: DELEGATOR,
        authorize: DELEGATE,
        permissions: [
          { permission: 'OfferCreate', kind: 'transaction' },
          { permission: 'OfferCancel', kind: 'transaction' },
        ],
        // one transaction made it: it is both when it was last changed and when it was created
        updated: RECORDED_REF,
        created: RECORDED_REF,
      },
    ]);
    const [delegation] = body.delegations as Obj[];
    expectKeysInOrder(delegation, DELEGATION_KEYS);
    expectKeysInOrder(delegation.updated as Obj, OBJECT_REF_KEYS);
    expectKeysInOrder(delegation.created as Obj, OBJECT_REF_KEYS);
    for (const permission of delegation.permissions as Obj[]) expectKeysInOrder(permission, PERMISSION_KEYS);

    const held = (await api.ok(`/v2/accounts/${DELEGATE}/delegations?direction=held`, 'delegations')).body as Obj;
    expect(held.delegations).toEqual(body.delegations);
    expect(held.coverage).toEqual(body.coverage);
    for (const path of [
      `/v2/accounts/${DELEGATOR}/delegations?direction=held`,
      `/v2/accounts/${DELEGATE}/delegations`,
      `/v2/accounts/${DELEGATE}/delegations?direction=given`,
    ]) {
      const none = (await api.ok(path, 'delegations')).body as Obj;
      expect([path, none.count, none.delegations]).toEqual([path, 0, []]);
      expect(Object.keys(none)).toEqual(DELEGATIONS_BODY_KEYS.filter((k) => k !== 'marker'));
    }
    // `direction` is given unless it says held, and an empty one is the default too
    expect(((await api.ok(`/v2/accounts/${DELEGATOR}/delegations?direction=`, 'delegations')).body as Obj).count).toBe(
      1,
    );

    // made: the giver gave four (the emptied one is gone) and holds one, which is not one it gave
    const giverGave = (await api.ok(`/v2/accounts/${GIVER}/delegations`, 'delegations')).body as Obj;
    expect(idsOf(giverGave)).toEqual(GIVEN);
    expect(giverGave.delegations).toEqual(GIVEN.map((id) => expected[id]));
    const giverHolds = (await api.ok(`/v2/accounts/${GIVER}/delegations?direction=held`, 'delegations')).body as Obj;
    expect(giverHolds.delegations).toEqual([expected[HELD]]);
    // and the account that gave that one has it as given
    const otherGave = (await api.ok(`/v2/accounts/${OTHER}/delegations`, 'delegations')).body as Obj;
    expect(otherGave.delegations).toEqual([expected[HELD]]);
    // an account no delegation names has none, whether or not it exists
    const stranger = (await api.ok(`/v2/accounts/${accountAt(0xd6ff)}/delegations`, 'delegations')).body as Obj;
    expect([stranger.count, stranger.delegations]).toEqual([0, []]);
  });

  it('shows a replaced list as its newest permissions and drops an emptied one', async () => {
    const body = (await api.ok(`/v2/accounts/${GIVER}/delegations`, 'delegations')).body as Obj;
    const replaced = (body.delegations as Obj[]).find((d) => d.delegation_id === REPLACED);
    // not the list the entry was created with (Payment), and updated is the replacing transaction, created the first
    expect(replaced).toEqual(expected[REPLACED]);
    expect((replaced?.permissions as Obj[]).map((p) => p.kind)).toEqual([
      'granular',
      'transaction',
      'transaction',
      'unknown',
    ]);
    expectKeysInOrder((replaced?.permissions as Obj[])[0], PERMISSION_KEYS);
    // the emptied one (deleted by a DelegateSet with no permissions) is not listed, from either side
    expect(idsOf(body)).not.toContain(EMPTIED);
    const heldBy = (await api.ok(`/v2/accounts/${authorized(2)}/delegations?direction=held`, 'delegations'))
      .body as Obj;
    expect([heldBy.count, heldBy.delegations]).toEqual([0, []]);
    // the delegate of the replaced one holds it with the newest permissions too
    const heldReplaced = (await api.ok(`/v2/accounts/${authorized(1)}/delegations?direction=held`, 'delegations'))
      .body as Obj;
    expect(heldReplaced.delegations).toEqual([expected[REPLACED]]);
  });

  it('keeps the created of the current entry after a delete and a new DelegateSet', async () => {
    // synthetic: the same ID made again after it was deleted (a DelegateSet for the same pair of accounts)
    const body = (await api.ok(`/v2/accounts/${GIVER}/delegations`, 'delegations')).body as Obj;
    const again = (body.delegations as Obj[]).find((d) => d.delegation_id === RECREATED);
    expect(again).toEqual(expected[RECREATED]);
    const created = (again as Obj).created as Obj;
    // the first creation (107,902,000) is of the entry that was deleted
    expect(created.ledger_index).toBe(107_940_000);
    // and while it stands as it was made, updated and created are one transaction
    const [rowsOfId] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.ObjectChanges} WHERE object_id = {id:String} AND action = 'created'`,
      { id: RECREATED },
    );
    expect(Number(rowsOfId.n)).toBe(2);
  });

  it('leaves out the created of an entry whose creation is older than the index', async () => {
    const body = (await api.ok(`/v2/accounts/${GIVER}/delegations`, 'delegations')).body as Obj;
    const old = (body.delegations as Obj[]).find((d) => d.delegation_id === NO_CREATION) as Obj;
    expect(old).toEqual(expected[NO_CREATION]);
    expect('created' in old).toBe(false);
  });

  it('serves nothing above the committed head: a change above it is not seen, an entry made above it is not there', async () => {
    const body = (await api.ok(`/v2/accounts/${GIVER}/delegations`, 'delegations')).body as Obj;
    expect(idsOf(body)).not.toContain(ABOVE_CREATED);
    const changed = (body.delegations as Obj[]).find((d) => d.delegation_id === ABOVE_CHANGED);
    // as it was at the head: Payment, last changed in 107,960,000
    expect(changed).toEqual(expected[ABOVE_CHANGED]);
    const held = (await api.ok(`/v2/accounts/${authorized(6)}/delegations?direction=held`, 'delegations')).body as Obj;
    expect(held.delegations).toEqual([]);
  });

  // -- paging ----------------------------------------------------------------------------------------------------------

  it('pages by marker in the order updated newest first, then delegation_id', async () => {
    const whole = (await api.ok(`/v2/accounts/${PAGER}/delegations`, 'delegations')).body as Obj;
    // the emptied one is gone, and the two changed by the same transaction come in the order of their IDs
    expect(idsOf(whole)).toEqual(PAGER_ORDER);
    expect(whole.marker).toBeUndefined();

    const path = `/v2/accounts/${PAGER}/delegations`;
    const pages = await api.pages<Obj & { marker?: string }>(path, 2, 'delegations');
    expect(pages.map(idsOf)).toEqual([
      [TIE_LOW, TIE_HIGH],
      [PAGER_3, PAGER_4],
      [PAGER_5, PAGER_6],
    ]);
    expect(pages.map((p) => p.count)).toEqual([2, 2, 2]);
    expect(pages.map((p) => p.marker !== undefined)).toEqual([true, true, false]);
    // the pages concatenate to the whole list
    expect(pages.flatMap((p) => p.delegations as Obj[])).toEqual(whole.delegations);
    // every page says the same of itself
    for (const page of pages) {
      expect(Object.keys(page)).toEqual(
        DELEGATIONS_BODY_KEYS.filter((k) => k !== 'marker' || page.marker !== undefined),
      );
      expect(page.coverage).toEqual(whole.coverage);
      expect([page.ledger_index, page.close_time]).toEqual([HEAD, iso(HEAD_CLOSE)]);
    }
    // the marker holds the place and the ID of the last row of the page
    expect(decodeMarker(pages[0].marker as string)).toEqual([107_960_000, 5, TIE_HIGH]);
    expect(decodeMarker(pages[1].marker as string)).toEqual([107_950_000, 9, PAGER_4]);
    expect(pages[0].marker).toBe(markerOf([107_960_000, 5, TIE_HIGH]));

    // a marker in the middle of the two that share a place continues with the second, a page of the exact size has no marker
    const afterLow = (await api.ok(`${path}?limit=1&marker=${markerOf([107_960_000, 5, TIE_LOW])}`, 'delegations'))
      .body as Obj;
    expect(idsOf(afterLow)).toEqual([TIE_HIGH]);
    expect(decodeMarker(afterLow.marker as string)).toEqual([107_960_000, 5, TIE_HIGH]);
    const exact = (await api.ok(`${path}?limit=6`, 'delegations')).body as Obj;
    expect([exact.count, exact.marker]).toEqual([6, undefined]);
    const nearly = (await api.ok(`${path}?limit=5`, 'delegations')).body as Obj;
    expect([nearly.count, decodeMarker(nearly.marker as string)]).toEqual([5, [107_950_000, 1, PAGER_5]]);
    // a marker past the last row gives an empty page, and one before the first gives the whole list
    const past = (await api.ok(`${path}?marker=${markerOf([107_940_000, 0, PAGER_6])}`, 'delegations')).body as Obj;
    expect([past.count, past.delegations, past.marker]).toEqual([0, [], undefined]);
    const before = (await api.ok(`${path}?marker=${markerOf([HEAD, 0, ''])}`, 'delegations')).body as Obj;
    expect(idsOf(before)).toEqual(PAGER_ORDER);
    // descending is not a parameter of this list: it is always newest first
    expect(idsOf((await api.ok(`${path}?descending=false`, 'delegations')).body as Obj)).toEqual(PAGER_ORDER);

    // the Link header continues the query as it was asked
    const first = await get(`${path}?limit=2`);
    const origin = new URL(first.request.url).origin;
    expect(first.headers.link).toBe(`<${origin}${path}?limit=2&marker=${pages[0].marker}>; rel="next"`);
    expect((await get(`${path}?limit=6`)).headers.link).toBeUndefined();
  });

  // -- CSV -------------------------------------------------------------------------------------------------------------

  it('serves CSV with permissions in one cell', async () => {
    const path = `/v2/accounts/${GIVER}/delegations`;
    const csv = await get(`${path}?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers['content-disposition']).toBe(csvDisposition(`${GIVER} - delegations given`));
    const header = DELEGATION_CSV_COLUMNS.map((c) => `"${c}"`);
    expect(header).toEqual([
      '"delegation_id"',
      '"account"',
      '"authorize"',
      '"permissions"',
      '"updated.ledger_index"',
      '"updated.time"',
      '"updated.tx_hash"',
      '"created.ledger_index"',
      '"created.time"',
      '"created.tx_hash"',
    ]);
    const table = lines(csv.text).map(cells);
    expect(table).toHaveLength(1 + GIVEN.length);
    expect(table[0]).toEqual(header);
    expect(csv.text).not.toContain('coverage');
    expect(csv.text).not.toContain('from_ledger_index');
    // no count, no result, no marker among the cells; one row for each delegation, in the order of the list
    expect(table.slice(1).map((row) => row[0])).toEqual(GIVEN.map((id) => `"${id}"`));
    const cell = (row: string[], column: string): string => row[header.indexOf(`"${column}"`)];
    // the permissions of a delegation are the names, separated by a space, in one cell
    const replaced = table[1 + GIVEN.indexOf(REPLACED)];
    expect(cell(replaced, 'permissions')).toBe('"TrustlineAuthorize OfferCreate Payment 70000"');
    expect(cell(replaced, 'updated.ledger_index')).toBe('"107910000"');
    expect(cell(replaced, 'created.tx_hash')).toBe(`"${hashAt(REPLACED, REPLACED_STEPS[0])}"`);
    const recreated = table[1 + GIVEN.indexOf(RECREATED)];
    expect(cell(recreated, 'permissions')).toBe('"TrustSet AccountSet"');
    expect(cell(recreated, 'created.ledger_index')).toBe('"107940000"');
    // the columns are the same whether the delegation has a created or not: the cells are empty
    const old = table[1 + GIVEN.indexOf(NO_CREATION)];
    expect(old).toHaveLength(header.length);
    expect(['created.ledger_index', 'created.time', 'created.tx_hash'].map((c) => cell(old, c))).toEqual([
      '""',
      '""',
      '""',
    ]);

    // held: the file says so, and the recorded delegation's two names are in a cell
    const held = await get(`/v2/accounts/${DELEGATE}/delegations?direction=held&format=csv`);
    expect(held.headers['content-disposition']).toBe(csvDisposition(`${DELEGATE} - delegations held`));
    const heldTable = lines(held.text).map(cells);
    expect(heldTable).toHaveLength(2);
    expect(heldTable[0]).toEqual(header);
    expect(cell(heldTable[1], 'permissions')).toBe('"OfferCreate OfferCancel"');
    expect(cell(heldTable[1], 'account')).toBe(`"${DELEGATOR}"`);

    // every page has the header and the Link header carries the marker, as in JSON
    const page = await get(`/v2/accounts/${PAGER}/delegations?format=csv&limit=2`);
    expect(lines(page.text)[0].split(',')).toEqual(header);
    expect(lines(page.text)).toHaveLength(3);
    const json = (await api.ok(`/v2/accounts/${PAGER}/delegations?limit=2`, 'delegations')).body as Obj;
    const origin = new URL(page.request.url).origin;
    expect(page.headers.link).toBe(
      `<${origin}/v2/accounts/${PAGER}/delegations?format=csv&limit=2&marker=${json.marker}>; rel="next"`,
    );
    const second = await get(`/v2/accounts/${PAGER}/delegations?format=csv&limit=2&marker=${json.marker}`);
    expect(lines(second.text)[0].split(',')).toEqual(header);
  });

  // -- the errors ------------------------------------------------------------------------------------------------------

  it.each([
    [`/v2/accounts/${X_ADDRESS}/delegations`, 400, 'invalid ripple address'],
    ['/v2/accounts/rNotAnAddress/delegations', 400, 'invalid ripple address'],
    [`/v2/accounts/${GIVER}/delegations?direction=x`, 400, 'invalid direction'],
    [`/v2/accounts/${GIVER}/delegations?direction=GIVEN`, 400, 'invalid direction'],
    [`/v2/accounts/${GIVER}/delegations?direction=given,held`, 400, 'invalid direction'],
    [`/v2/accounts/${GIVER}/delegations?marker=%%`, 400, 'invalid marker'],
    [`/v2/accounts/${GIVER}/delegations?marker=e30`, 400, 'invalid marker'],
    [`/v2/accounts/${GIVER}/delegations?marker=${markerOf([1, 2])}`, 400, 'invalid marker'],
    [`/v2/accounts/${GIVER}/delegations?marker=${markerOf(['x', 2, 'A'])}`, 400, 'invalid marker'],
    [`/v2/accounts/${GIVER}/delegations?marker=${markerOf([1, 2, 3])}`, 400, 'invalid marker'],
    [`/v2/accounts/${GIVER}/delegations?marker=${markerOf([-1, 2, 'A'])}`, 400, 'invalid marker'],
    // the checks come in the order of the parameters: the address, the direction, the marker
    [`/v2/accounts/rNotAnAddress/delegations?direction=x&marker=%%`, 400, 'invalid ripple address'],
    [`/v2/accounts/${GIVER}/delegations?direction=x&marker=%%`, 400, 'invalid direction'],
  ])('%s → %i %s', async (path, status, message) => {
    const res = await get(path);
    expect([res.status, res.body]).toEqual([status, { result: 'error', message }]);
    // an error is not kept by a cache
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('checks the marker and the direction before any read', async () => {
    const spy = jest.spyOn(h.ch, 'query');
    await get(`/v2/accounts/${GIVER}/delegations?marker=%%`);
    await get(`/v2/accounts/${GIVER}/delegations?direction=x`);
    await get(`/v2/accounts/${X_ADDRESS}/delegations`);
    expect(spy).not.toHaveBeenCalled();
  });

  it('answers 500 with the message of the route when a read fails', async () => {
    jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('clickhouse is down'));
    for (const path of [`/v2/accounts/${GIVER}/delegations`, `/v2/accounts/${GIVER}/delegations?format=csv`]) {
      const res = await get(path);
      expect([path, res.status, res.body]).toEqual([
        path,
        500,
        { result: 'error', message: 'unable to retrieve delegations' },
      ]);
    }
  });

  it('answers 401 without a key', async () => {
    const path = `/v2/accounts/${GIVER}/delegations`;
    const res = await h.http().get(path);
    expect([res.status, res.body]).toEqual([401, { result: 'error', message: 'Missing or invalid API key.' }]);
  });
});

// =====================================================================================================================
// before a ledger is committed, and the coverage of an index that starts after the amendment
// =====================================================================================================================

describe('the delegations of an account before a ledger is committed, and with an index that starts after the amendment', () => {
  const GIVER = accountAt(0xd640);
  const ID = hashOf(0xde0201);
  /** After the ledger the amendment was enabled in (107,524,865, from the metadata of the network). */
  const FIRST = 107_600_000;
  const steps: Step[] = [{ ledger: FIRST + 100, tx: 1, action: 'created', permissions: ['Payment'] }];

  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it('answers 500 before a ledger is committed, whatever the rows say, and the list once one is', async () => {
    await insertObjects(h, delegation(ID, GIVER, accountAt(0xd641), steps));
    const path = `/v2/accounts/${GIVER}/delegations`;
    const before = await api.get(path);
    expect([before.status, before.body]).toEqual([500, { result: 'error', message: 'unable to retrieve delegations' }]);

    // the first ledger of the index is after the ledger the amendment was enabled in (the ledger state lists it): the history
    // is incomplete
    await listDelegation(h, FIRST);
    await seedObjects(h, [], { ledger_index: FIRST + 200, close_time: closeOf(FIRST + 200) });
    await seedObjects(h, [], { ledger_index: FIRST, close_time: closeOf(FIRST) });
    await api.ok('/v2/test-cache/clear', 'result');
    const body = (await api.ok(path, 'delegations')).body as Obj;
    expect(body.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
    expect([body.ledger_index, body.close_time, body.count]).toEqual([FIRST + 200, iso(closeOf(FIRST + 200)), 1]);
    expect((body.delegations as Obj[])[0].delegation_id).toBe(ID);
  });
});

// =====================================================================================================================
// the recorded Xahau ledgers: no delegation
// =====================================================================================================================

describe('the delegations of an account over the recorded xahau ledgers', () => {
  const HEAD = 26_399_329;
  const HEAD_CLOSE = 1_791_550_172;
  const FIRST = 8_852_809;
  const ACCOUNT = 'rKqZCLrHu8dMPj444xPrDQCXUpZr6U2VWi';

  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: 'xahau-objects', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it("answers Xahau's delegations empty and complete without a read", async () => {
    const paths = [
      `/v2/accounts/${ACCOUNT}/delegations`,
      `/v2/accounts/${ACCOUNT}/delegations?direction=held`,
      `/v2/accounts/${ACCOUNT}/delegations?format=csv`,
    ];
    // system.query_log: no SELECT on either table of the objects, whatever the three requests ask
    for (const table of [Table.ObjectChanges, Table.AccountObjectChanges]) {
      const reads = await readsOf(h, table, async () => {
        for (const path of paths) await api.ok(path);
      });
      expect([table, reads.map((r) => r.query)]).toEqual([table, []]);
    }
    const body = (await api.ok(paths[0], 'delegations')).body as Obj;
    // the feature the network cannot have is complete: nothing can be missing
    expect(body).toEqual({
      result: 'success',
      coverage: { from_ledger_index: FIRST, complete: true },
      ledger_index: HEAD,
      close_time: iso(HEAD_CLOSE),
      count: 0,
      delegations: [],
    });
    expect(Object.keys(body)).toEqual(DELEGATIONS_BODY_KEYS.filter((k) => k !== 'marker'));
    const held = (await api.ok(paths[1], 'delegations')).body as Obj;
    expect(held).toEqual(body);
    // CSV is empty, and named all the same
    const csv = await api.get(paths[2]);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toBe(csvDisposition(`${ACCOUNT} - delegations given`));
    expect(csv.text).toBe('');
  });

  it('checks the address, the direction and the marker on Xahau too, and a failed read is the 500 of the route', async () => {
    for (const [path, status, message] of [
      [`/v2/accounts/${X_ADDRESS}/delegations`, 400, 'invalid ripple address'],
      [`/v2/accounts/${ACCOUNT}/delegations?direction=x`, 400, 'invalid direction'],
      [`/v2/accounts/${ACCOUNT}/delegations?marker=%%`, 400, 'invalid marker'],
    ] as const) {
      const res = await api.get(path);
      expect([path, res.status, res.body]).toEqual([path, status, { result: 'error', message }]);
    }
    jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('clickhouse is down'));
    const failed = await api.get(`/v2/accounts/${ACCOUNT}/delegations`);
    expect([failed.status, failed.body]).toEqual([500, { result: 'error', message: 'unable to retrieve delegations' }]);
  });
});

// =====================================================================================================================
// the most an account can have
// =====================================================================================================================

describe('the delegations of an account at and past DELEGATION_IDS_CAP', () => {
  const HEAD = 107_900_000;
  const AT_CAP = accountAt(0xd650);
  const PAST_CAP = accountAt(0xd651);
  const HELD_PAST_CAP = accountAt(0xd652);
  /** The ledger of the n-th delegation of an account: one a ledger, below the head. */
  const ledgerOf = (n: number): number => 107_800_000 + n;
  const idOf = (base: number, n: number): string => hashOf(base + n);

  /** `count` delegations of an owner to as many authorized accounts; `counterparty` is the one account that holds them all when given. */
  function delegations(base: number, count: number, o: { owner?: string; holder?: string }): ObjectChangesRow[] {
    return Array.from({ length: count }, (_, n) =>
      delegation(idOf(base, n), o.owner ?? accountAt(0xe0000 + n), o.holder ?? accountAt(0xf0000 + n), [
        { ledger: ledgerOf(n), tx: 0, action: 'created', permissions: ['Payment'] },
      ]),
    ).flat();
  }

  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
    await seedObjects(
      h,
      [
        ...delegations(0xca000000, DELEGATION_IDS_CAP, { owner: AT_CAP }),
        ...delegations(0xcb000000, DELEGATION_IDS_CAP + 1, { owner: PAST_CAP }),
        ...delegations(0xcc000000, DELEGATION_IDS_CAP + 1, { holder: HELD_PAST_CAP }),
      ],
      { ledger_index: HEAD, close_time: closeOf(HEAD) },
    );
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the data is as the tests assume', async () => {
    const [counts] = await h.ch.query<{ at: string; past: string; held: string }>(
      `SELECT uniqExactIf(object_id, account = {at:String} AND role = 'owner') AS at,
              uniqExactIf(object_id, account = {past:String} AND role = 'owner') AS past,
              uniqExactIf(object_id, account = {held:String} AND role = 'counterparty') AS held
         FROM ${Table.AccountObjectChanges} WHERE object_type = 'Delegate'`,
      { at: AT_CAP, past: PAST_CAP, held: HELD_PAST_CAP },
    );
    expect([Number(counts.at), Number(counts.past), Number(counts.held)]).toEqual([
      DELEGATION_IDS_CAP,
      DELEGATION_IDS_CAP + 1,
      DELEGATION_IDS_CAP + 1,
    ]);
  });

  it('serves an account with DELEGATION_IDS_CAP delegations, newest first, to the last page', async () => {
    const path = `/v2/accounts/${AT_CAP}/delegations`;
    const body = (await api.ok(`${path}?limit=1000`, 'delegations')).body as Obj;
    expect(body.count).toBe(1000);
    const listed = body.delegations as Obj[];
    // the newest are the last ones made, a ledger each
    expect(listed[0].delegation_id).toBe(idOf(0xca000000, DELEGATION_IDS_CAP - 1));
    expect(listed[999].delegation_id).toBe(idOf(0xca000000, DELEGATION_IDS_CAP - 1000));
    expect(decodeMarker(body.marker as string)).toEqual([
      ledgerOf(DELEGATION_IDS_CAP - 1000),
      0,
      idOf(0xca000000, DELEGATION_IDS_CAP - 1000),
    ]);
    // the last 1,000 are the page after the marker of the 1,001st from the end: exactly them, so no marker
    const last = (
      await api.ok(`${path}?limit=1000&marker=${markerOf([ledgerOf(1000), 0, idOf(0xca000000, 1000)])}`, 'delegations')
    ).body as Obj;
    expect(last.count).toBe(1000);
    expect((last.delegations as Obj[])[999].delegation_id).toBe(idOf(0xca000000, 0));
    expect(last.marker).toBeUndefined();
  });

  it('answers the limit as the other lists do: 200 by default, 1000 at most, a number that is none is the default', async () => {
    const path = `/v2/accounts/${AT_CAP}/delegations`;
    for (const [query, count] of [
      ['', 200],
      ['?limit=0', 200],
      ['?limit=abc', 200],
      ['?limit=100000', 1000],
      ['?limit=1.9', 1],
    ] as const) {
      const body = (await api.ok(`${path}${query}`, 'delegations')).body as Obj;
      expect([query, body.count, body.marker !== undefined]).toEqual([query, count, true]);
    }
  });

  it('answers 500 past DELEGATION_IDS_CAP, given and held, and reads no row of the objects for it', async () => {
    for (const path of [
      `/v2/accounts/${PAST_CAP}/delegations`,
      `/v2/accounts/${HELD_PAST_CAP}/delegations?direction=held`,
    ]) {
      const reads = await readsOf(h, Table.ObjectChanges, async () => {
        const res = await api.get(path);
        expect([path, res.status, res.body]).toEqual([
          path,
          500,
          { result: 'error', message: 'unable to retrieve delegations' },
        ]);
      });
      expect([path, reads]).toEqual([path, []]);
    }
    // the same accounts the other way round have nothing, and are served
    const none = (await api.ok(`/v2/accounts/${PAST_CAP}/delegations?direction=held`, 'delegations')).body as Obj;
    expect([none.count, none.delegations]).toEqual([0, []]);
  });
});
