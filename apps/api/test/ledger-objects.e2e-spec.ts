import { amendmentId, escrowId, OBJECT_PARSER_VERSION, ObjectChangesRow, Table } from '@gatehub/data-api-shared';
import { classicAddressToXAddress } from 'ripple-address-codec';
import { COVERAGE_KEYS } from '../src/common/feature-coverage.service';
import {
  CHECK_KEYS,
  DETAIL_BODY_KEYS,
  ESCROW_KEYS,
  EVENT_CSV_COLUMNS,
  EVENT_EXTRA_KEYS,
  EVENT_KEYS,
  HISTORY_BODY_KEYS,
  OBJECT_REF_KEYS,
  PAYMENT_CHANNEL_KEYS,
  REMOVED_KEYS,
} from '../src/ledger-objects/object-views';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { accountAt, cells, decodeMarker, hashOf, iso, lines } from './support/amm';
import { csvDisposition } from './support/csv';
import { COUNTERPARTY, insertObjects, jsonOf, objectRow, OWNER, seedObjects } from './support/objects';
import { markerOf } from './support/read-rows';
import { insertState, ledgerRow } from './support/validators-seed';

/**
 * `GET /v2/escrows/{id}`, `/v2/escrows/{id}/history` and `/v2/accounts/{address}/escrows/{sequence}` (D5, spec 5.3), and the
 * check and payment channel routes `GET /v2/checks/{id}`, `/v2/payment_channels/{id}` and their `/history` (spec 5.4, 5.5), on a
 * real ClickHouse: the recorded ledgers of the objects fixtures (`xrpl-objects`: escrows created, finished and cancelled, checks
 * created, cashed and cancelled, channels created, funded, claimed from and closed; `xahau-objects`: XAH and issued-token escrows
 * and channels, checks), written by the ledger writer as the syncer writes them, and the objects made by hand (their
 * transactions say `synthetic-…`) for what the recordings do not hold: a conditional escrow with a fulfillment, an escrow created
 * with a ticket, a check cancelled by a third party after its expiration, escrows and a payment channel with 120 to 1,200 events
 * to page through (a real one has two to a few; the paging code reads the rows of any object), rows written twice, and rows above
 * the committed head.
 *
 * Coverage depends on the amendments the api knows: Escrow, PayChan and Checks are retired or old, so the ledger state has to
 * list them (`network_state`) before the api gives them an enable ledger, and the api keeps both for seconds: the suites that
 * change them clear the caches (`/v2/test-cache/clear`, `cache-controllers.ts`) before they ask again.
 */

const RIPPLE_EPOCH = 946_684_800;
/** A Ripple-epoch time as the API writes it. */
const rippleIso = (seconds: number): string => iso(seconds + RIPPLE_EPOCH);

type Obj = Record<string, unknown>;

/** `entry` has the keys of `order` it has, and in that order: none out of place, none made up. */
function expectKeysInOrder(entry: object, order: readonly string[]): void {
  const keys = Object.keys(entry);
  expect(keys).toEqual(order.filter((k) => keys.includes(k)));
}

const CACHE_ROUTE = async () => (await import('./cache-controllers')).CACHE_CONTROLLERS;

/** The keys of an event of an escrow: the keys every event has, then what an escrow event adds. */
const ESCROW_EVENT_KEYS = [...EVENT_KEYS, ...EVENT_EXTRA_KEYS.escrow];

/** What the routes answer for the unknown and the malformed. */
const UNKNOWN = hashOf(0xdead01);
const X_ADDRESS = classicAddressToXAddress(OWNER, false, false);

/** Writes the ids of the amendments to the ledger state the api reads them from. */
async function listAmendments(h: Harness, names: string[], ledgerIndex: number): Promise<void> {
  await insertState(h.ch, [
    { ledger_index: ledgerIndex, polled_at: Date.now() / 1000 - 5, amendments: names.map((name) => amendmentId(name)) },
  ]);
}

/** The pages of a history walk, each followed by its marker, as `ApiClient.pages` gives them. */
interface HistoryPage {
  count: number;
  marker?: string;
  history: Obj[];
}

// =====================================================================================================================
// the recorded XRPL ledgers
// =====================================================================================================================

describe('the escrow routes over the recorded xrpl ledgers', () => {
  const HEAD = 107_972_102;
  const HEAD_CLOSE = 1_793_245_841;
  /** The oldest recorded ledger: where the coverage of the objects starts (every ledger is written by the parser of the objects). */
  const FIRST = 102_145_584;

  // recorded (xrpl-objects)
  /** A timed XRP escrow, created in 107897249 and still in the ledger (past its CancelAfter at the close time of HEAD). */
  const OPEN = 'B95064B1A92F02EE009E6BDFB369CF476FB925BB8615456970E38774034A5D30';
  const OPEN_OWNER = 'rNeJW71pMjKy42j5jn7vnWZAbmuU6SKs6V';
  const OPEN_SEQUENCE = 107_896_555;
  /** 75,000 XRB of rD9ixf… escrowed in 107945438 and finished in 107967068. */
  const FINISHED = 'FA8631A0C654F964699C8B9A1277DA0C3F62D034190E62062F2D662A9D23C1B4';
  /** An XRP escrow finished in 107670360 whose creation is older than the index. */
  const OLDER = '8993DA09444641A6BDA272A292157A0E8AF79F040AA4E551C48257F493228455';

  // made by hand
  const SEQUENCE = 7001;
  const FULFILLED = escrowId(OWNER, SEQUENCE);
  const TICKET = 3_000_123;
  const TICKET_OWNER = accountAt(0xd503);
  const TICKETED = escrowId(TICKET_OWNER, TICKET);
  const CHATTY = hashOf(0xe5c02);
  const CHATTY_EVENTS = 120;
  const TWICE = hashOf(0xe5c03);
  const ABOVE = hashOf(0xe5c04);
  const ABOVE_FINISH = hashOf(0xe5c05);
  /** A PREIMAGE-SHA-256 condition and the fulfillment it is the hash of (the shapes of the crypto-conditions of the ledger). */
  const CONDITION = `A0258020${'3A'.repeat(32)}810100`;
  const FULFILLMENT = `A0228020${'5B'.repeat(32)}`;

  const escrowFields = (extra: Obj = {}): string =>
    jsonOf({
      Account: OWNER,
      Amount: '2500000',
      Destination: COUNTERPARTY,
      FinishAfter: 846_000_000,
      Sequence: SEQUENCE,
      ...extra,
    });

  /** The rows made by hand, all in ledgers of the recorded range (the head is the newest recorded ledger). */
  const rows = [
    // a conditional escrow created and finished by a third party, with the fulfillment
    objectRow({
      object_type: 'Escrow',
      object_id: FULFILLED,
      ledger_index: 107_950_000,
      tx_index: 5,
      fields: escrowFields({ Condition: CONDITION, DestinationTag: 4242, CancelAfter: 846_100_000 }),
      event_fields: jsonOf({ sequence: SEQUENCE }),
    }),
    objectRow({
      object_type: 'Escrow',
      object_id: FULFILLED,
      ledger_index: 107_960_000,
      tx_index: 7,
      tx_type: 'EscrowFinish',
      sender: TICKET_OWNER,
      action: 'deleted',
      event: 'finish',
      fields: escrowFields({ Condition: CONDITION, DestinationTag: 4242, CancelAfter: 846_100_000 }),
      event_fields: jsonOf({ fulfillment: FULFILLMENT }),
    }),
    // an escrow created with a ticket: the node has no Sequence, the creating event says which sequence made the id
    objectRow({
      object_type: 'Escrow',
      object_id: TICKETED,
      ledger_index: 107_955_000,
      tx_index: 2,
      owner: TICKET_OWNER,
      sender: TICKET_OWNER,
      fields: jsonOf({ Account: TICKET_OWNER, Amount: '1000000', Destination: COUNTERPARTY, CancelAfter: 846_900_000 }),
      event_fields: jsonOf({ sequence: TICKET }),
    }),
    // an escrow with 120 events: the creation, then 119 changes by transactions the table does not expect, two to a ledger
    objectRow({
      object_type: 'Escrow',
      object_id: CHATTY,
      ledger_index: 107_900_000,
      tx_index: 1,
      fields: escrowFields({ Sequence: 9001 }),
      event_fields: jsonOf({ sequence: 9001 }),
    }),
    ...Array.from({ length: CHATTY_EVENTS - 1 }, (_, i) =>
      objectRow({
        object_type: 'Escrow',
        object_id: CHATTY,
        ledger_index: 107_901_000 + Math.floor(i / 2) * 10,
        tx_index: (i % 2) + 1,
        tx_type: 'Payment',
        action: 'modified',
        event: 'update',
        fields: escrowFields({ Sequence: 9001 }),
      }),
    ),
    // an escrow whose creation is in the ledger table twice, as a re-ingest can leave it
    objectRow({ object_type: 'Escrow', object_id: TWICE, ledger_index: 107_956_000, tx_index: 4 }),
    // above the committed head: the ledger is not committed, so none of the routes may serve it
    objectRow({ object_type: 'Escrow', object_id: ABOVE, ledger_index: HEAD + 1, tx_index: 1 }),
    objectRow({ object_type: 'Escrow', object_id: ABOVE_FINISH, ledger_index: 107_957_000, tx_index: 1 }),
    objectRow({
      object_type: 'Escrow',
      object_id: ABOVE_FINISH,
      ledger_index: HEAD + 1,
      tx_index: 2,
      tx_type: 'EscrowFinish',
      action: 'deleted',
      event: 'finish',
    }),
  ];

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];

  beforeAll(async () => {
    h = await startHarness({ seed: 'xrpl-objects', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
    get = api.get;
    await listAmendments(h, ['Escrow', 'PayChan', 'Checks'], HEAD);
    await insertObjects(h, rows);
    // TWICE is written twice, each time as a part of its own
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.ObjectChanges}`);
    await h.ch.command(
      `INSERT INTO ${Table.ObjectChanges} SELECT * FROM ${Table.ObjectChanges} WHERE object_id = {id:String}`,
      { id: TWICE },
      { settings: { insert_deduplicate: 0 } },
    );
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the data is as the tests assume', async () => {
    const head = await h.ch.queryOne<{ ledger_index: number; t: number; v: number }>(
      `SELECT ledger_index, toUnixTimestamp(close_time) AS t, parser_version AS v FROM ${Table.Ledgers}
        ORDER BY ledger_index DESC LIMIT 1`,
    );
    expect([head?.ledger_index, Number(head?.t), head?.v]).toEqual([HEAD, HEAD_CLOSE, OBJECT_PARSER_VERSION]);
    const first = await h.ch.queryOne<{ ledger_index: number }>(
      `SELECT ledger_index FROM ${Table.Ledgers} ORDER BY ledger_index LIMIT 1`,
    );
    expect(first?.ledger_index).toBe(FIRST);
    // the recorded escrows are in the index, the owner's key of an escrow is its keylet
    expect(escrowId(OPEN_OWNER, OPEN_SEQUENCE)).toBe(OPEN);
    const [count] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.ObjectChanges} WHERE object_id IN ({ids:Array(String)})`,
      { ids: [OPEN, FINISHED, OLDER] },
    );
    expect(Number(count.n)).toBe(4);
    // a row of the index by account for each side of an object row: the owner's and the counterparty's
    const [index] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.AccountObjectChanges} WHERE object_id = {id:String}`,
      { id: FULFILLED },
    );
    expect(Number(index.n)).toBe(4);
    // TWICE is there twice
    const [twice] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.ObjectChanges} WHERE object_id = {id:String}`,
      { id: TWICE },
    );
    expect(Number(twice.n)).toBe(2);
  });

  // -- the escrow ----------------------------------------------------------------------------------------------------

  it('serves an open escrow in ESCROW_KEYS order with its newest events and coverage first', async () => {
    const res = await api.ok(`/v2/escrows/${OPEN}`, 'escrow');
    expect(res.headers['cache-control']).toBe('private, max-age=60');
    const body = res.body as Obj;
    // the keys of the answer, in order: coverage and the point it is as of right after result; no more than 50 events
    expect(Object.keys(body)).toEqual(DETAIL_BODY_KEYS.escrow.filter((k) => k !== 'history_marker'));
    expect(body.coverage).toEqual({ from_ledger_index: FIRST, complete: true });
    expect(Object.keys(body.coverage as Obj)).toEqual([...COVERAGE_KEYS]);
    expect([body.ledger_index, body.close_time]).toEqual([HEAD, iso(HEAD_CLOSE)]);

    const escrow = body.escrow as Obj;
    expectKeysInOrder(escrow, ESCROW_KEYS);
    expect(escrow).toEqual({
      escrow_id: OPEN,
      account: OPEN_OWNER,
      sequence: OPEN_SEQUENCE,
      destination: 'rGtW2dWHmHQ3f65pfbjYF5PbFbdZwgwuqW',
      amount: { currency: 'XRP', value: '0.5' },
      finish_after: rippleIso(846_262_201),
      cancel_after: rippleIso(846_265_741),
      source_tag: 2_610_250_016,
      // the close time of HEAD is past its CancelAfter
      status: 'can_be_cancelled',
      created: {
        ledger_index: 107_897_249,
        time: iso(1_792_946_960),
        tx_hash: 'BF93E9B72AE372BCEB27781CA58C4ABE7E51EE9F5D254D02B83C92EC1A22AE53',
      },
    });
    expect(Object.keys(escrow.created as Obj)).toEqual([...OBJECT_REF_KEYS]);
    expect(escrow.removed).toBeUndefined();

    const history = body.history as Obj[];
    expect(history).toEqual([
      {
        event: 'create',
        ledger_index: 107_897_249,
        time: iso(1_792_946_960),
        tx_hash: 'BF93E9B72AE372BCEB27781CA58C4ABE7E51EE9F5D254D02B83C92EC1A22AE53',
        tx_type: 'EscrowCreate',
        account: OPEN_OWNER,
        result: 'tesSUCCESS',
        amount: { currency: 'XRP', value: '0.5' },
      },
    ]);
    for (const event of history) expectKeysInOrder(event, ESCROW_EVENT_KEYS);
  });

  it('serves a finished escrow with removed, fulfillment and status finished', async () => {
    // recorded: an issued-token escrow finished by a bot; the transaction has no Fulfillment
    const token = (await api.ok(`/v2/escrows/${FINISHED}`, 'escrow')).body as Obj;
    expect(token.coverage).toEqual({ from_ledger_index: FIRST, complete: true });
    const finished = token.escrow as Obj;
    expectKeysInOrder(finished, ESCROW_KEYS);
    expect(finished).toEqual({
      escrow_id: FINISHED,
      account: 'rfd4xkXuigdGJV2XYkbosFzBQaLsc6M8Vm',
      sequence: 107_945_427,
      destination: 'rHiwfnKJCwNePaTj8HmEYCx8G5NCsSEJSt',
      amount: { currency: 'XRB', issuer: 'rD9ixf7RRUKuKVFTsZa3fZGAN6HtNziPKa', value: '75000' },
      finish_after: rippleIso(846_540_887),
      status: 'finished',
      created: {
        ledger_index: 107_945_438,
        time: iso(1_793_139_291),
        tx_hash: '3D7F58900F76F6B50D7B5BB1988D9E3C4E33744928B14DE1106848FFA9A3343C',
      },
      removed: {
        ledger_index: 107_967_068,
        time: iso(1_793_225_691),
        tx_hash: '375202E930018352EA63F82A1DCAF7795916DC5117C74D013119E67955C157DA',
        tx_type: 'EscrowFinish',
      },
    });
    expect(Object.keys(finished.removed as Obj)).toEqual([...REMOVED_KEYS]);
    // newest first: the finish by the bot (its account is the sender, not the owner), then the creation with its amount
    const events = token.history as Obj[];
    expect(events.map((e) => [e.event, e.ledger_index, e.account])).toEqual([
      ['finish', 107_967_068, 'rPw6JAdM9BGwH4y4LxJQBDybaGNhFLCspU'],
      ['create', 107_945_438, 'rfd4xkXuigdGJV2XYkbosFzBQaLsc6M8Vm'],
    ]);
    expect(events[0].fulfillment).toBeUndefined();
    expect(events[1].amount).toEqual(finished.amount);
    for (const event of events) expectKeysInOrder(event, ESCROW_EVENT_KEYS);

    // made by hand: a conditional escrow finished with its fulfillment
    const body = (await api.ok(`/v2/escrows/${FULFILLED}`, 'escrow')).body as Obj;
    const escrow = body.escrow as Obj;
    expectKeysInOrder(escrow, ESCROW_KEYS);
    expect(escrow).toMatchObject({
      escrow_id: FULFILLED,
      sequence: SEQUENCE,
      condition: CONDITION,
      fulfillment: FULFILLMENT,
      destination_tag: 4242,
      cancel_after: rippleIso(846_100_000),
      status: 'finished',
      removed: { ledger_index: 107_960_000, tx_type: 'EscrowFinish' },
    });
    const history = body.history as Obj[];
    expect(history.map((e) => e.event)).toEqual(['finish', 'create']);
    expect(history[0].fulfillment).toBe(FULFILLMENT);
    expect(history[0].account).toBe(TICKET_OWNER);
    expect(history[1].fulfillment).toBeUndefined();
    expect((body.escrow as Obj).created).toMatchObject({ ledger_index: 107_950_000 });
  });

  it('answers an escrow created before the coverage with complete false and no created', async () => {
    const body = (await api.ok(`/v2/escrows/${OLDER}`, 'escrow')).body as Obj;
    // its creation is older than the first indexed ledger: the coverage is the feature's, which starts above the enable ledger
    expect(body.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
    const escrow = body.escrow as Obj;
    expect(escrow.created).toBeUndefined();
    expectKeysInOrder(escrow, ESCROW_KEYS);
    expect(escrow).toEqual({
      escrow_id: OLDER,
      account: 'r3pzUULRxwRF1m5DjBWMk6FMEMwViRMCN5',
      destination: 'r4FJShwnFTdcJDHacuAtGFd5KLWNbvUJ88',
      amount: { currency: 'XRP', value: '50' },
      finish_after: rippleIso(845_373_600),
      status: 'finished',
      removed: {
        ledger_index: 107_670_360,
        time: iso(1_792_058_402),
        tx_hash: '92EC1EA8B38B7242F07591AB4BF1AAB5E6B2E3015CE6E15AAAADAC05E6B74046',
        tx_type: 'EscrowFinish',
      },
    });
    expect((body.history as Obj[]).map((e) => e.event)).toEqual(['finish']);
    // the same for its history
    const history = (await api.ok(`/v2/escrows/${OLDER}/history`, 'history')).body as Obj;
    expect(history.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
  });

  it('answers a lower-case id in upper case', async () => {
    const body = (await api.ok(`/v2/escrows/${OPEN.toLowerCase()}`, 'escrow')).body as Obj;
    expect((body.escrow as Obj).escrow_id).toBe(OPEN);
    expect(((await api.ok(`/v2/escrows/${OPEN.toLowerCase()}/history`, 'history')).body as Obj).history).toHaveLength(
      1,
    );
  });

  it('serves the same escrow at /v2/accounts/{owner}/escrows/{sequence}', async () => {
    const byId = (await api.ok(`/v2/escrows/${OPEN}`, 'escrow')).body;
    const bySequence = (await api.ok(`/v2/accounts/${OPEN_OWNER}/escrows/${OPEN_SEQUENCE}`, 'escrow')).body;
    expect(bySequence).toEqual(byId);
    expect(Object.keys(bySequence as Obj)).toEqual(Object.keys(byId as Obj));
    // a conditional escrow, by its sequence
    const fulfilled = (await api.ok(`/v2/accounts/${OWNER}/escrows/${SEQUENCE}`, 'escrow')).body as Obj;
    expect((fulfilled.escrow as Obj).escrow_id).toBe(FULFILLED);
    // one created with a ticket is named by the TicketSequence: the node has no Sequence, the creating event has it
    const ticketed = (await api.ok(`/v2/accounts/${TICKET_OWNER}/escrows/${TICKET}`, 'escrow')).body as Obj;
    expect(ticketed.escrow).toEqual({
      escrow_id: TICKETED,
      account: TICKET_OWNER,
      sequence: TICKET,
      destination: COUNTERPARTY,
      amount: { currency: 'XRP', value: '1' },
      cancel_after: rippleIso(846_900_000),
      // no FinishAfter, and the close time of HEAD is before its CancelAfter
      status: 'can_be_finished',
      created: expect.objectContaining({ ledger_index: 107_955_000 }),
    });
    // a sequence is a decimal number: leading zeros name the same escrow
    const padded = (await api.ok(`/v2/accounts/${TICKET_OWNER}/escrows/0${TICKET}`, 'escrow')).body as Obj;
    expect((padded.escrow as Obj).escrow_id).toBe(TICKETED);
  });

  it('serves nothing above the committed head, and an escrow with a row above it as it was at the head', async () => {
    const res = await get(`/v2/escrows/${ABOVE}`);
    expect([res.status, res.body]).toEqual([404, { result: 'error', message: 'escrow not found' }]);
    expect((await get(`/v2/escrows/${ABOVE}/history`)).status).toBe(404);
    const body = (await api.ok(`/v2/escrows/${ABOVE_FINISH}`, 'escrow')).body as Obj;
    expect((body.escrow as Obj).status).toBe('can_be_finished');
    expect((body.escrow as Obj).removed).toBeUndefined();
    expect((body.history as Obj[]).map((e) => e.event)).toEqual(['create']);
  });

  it('shows a row that is stored twice once', async () => {
    const body = (await api.ok(`/v2/escrows/${TWICE}`, 'escrow')).body as Obj;
    expect(body.history).toHaveLength(1);
    expect(((await api.ok(`/v2/escrows/${TWICE}/history`, 'history')).body as Obj).count).toBe(1);
  });

  // -- the history -----------------------------------------------------------------------------------------------------

  /** The key of every event of CHATTY and its transaction, oldest first, as the table has them. */
  async function chattyKeys(): Promise<{ key: [number, number]; tx_hash: string }[]> {
    const stored = await h.ch.query<{ ledger_index: number; tx_index: number; tx_hash: string }>(
      `SELECT ledger_index, tx_index, tx_hash FROM ${Table.ObjectChanges}
        WHERE object_id = {id:String} ORDER BY ledger_index, tx_index`,
      { id: CHATTY },
    );
    return stored.map((r) => ({ key: [Number(r.ledger_index), Number(r.tx_index)], tx_hash: r.tx_hash }));
  }

  it('pages history oldest first and newest first; the pages concatenate to the whole list', async () => {
    const all = await chattyKeys();
    expect(all).toHaveLength(CHATTY_EVENTS);
    for (const descending of [false, true]) {
      const want = descending ? [...all].reverse() : all;
      const path = `/v2/escrows/${CHATTY}/history?descending=${descending}`;
      for (const limit of [7, 50, 119, 120, 121]) {
        const pages = await api.pages<HistoryPage>(path, limit, 'history');
        // the events come in the order of the key, each once (two to a ledger: the transaction tells the order within one)
        expect([path, limit, pages.flatMap((p) => p.history.map((e) => e.tx_hash))]).toEqual([
          path,
          limit,
          want.map((r) => r.tx_hash),
        ]);
        expect(pages.map((p) => p.count)).toEqual(
          Array.from({ length: Math.ceil(CHATTY_EVENTS / limit) }, (_, i) =>
            Math.min(limit, CHATTY_EVENTS - i * limit),
          ),
        );
        // only the last page has no marker
        expect(pages.map((p) => p.marker === undefined)).toEqual(pages.map((_, i) => i === pages.length - 1));
      }
      // the marker is the key of the last row of its page
      const first = (await api.ok(`${path}&limit=3`)).body as HistoryPage;
      expect(decodeMarker(first.marker as string)).toEqual(want[2].key);
    }
  });

  it('answers the whole list in the keys of the history answer, and the keys of every event', async () => {
    const body = (await api.ok(`/v2/escrows/${CHATTY}/history?limit=7`, 'history')).body as Obj;
    expect(Object.keys(body)).toEqual([...HISTORY_BODY_KEYS]);
    expect(body.coverage).toEqual({ from_ledger_index: FIRST, complete: true });
    expect([body.ledger_index, body.close_time, body.count]).toEqual([HEAD, iso(HEAD_CLOSE), 7]);
    for (const event of body.history as Obj[]) expectKeysInOrder(event, ESCROW_EVENT_KEYS);
    // the first is the creation, with its amount
    expect((body.history as Obj[])[0]).toMatchObject({
      event: 'create',
      ledger_index: 107_900_000,
      amount: { currency: 'XRP', value: '2.5' },
    });
    // a page without a marker is the last: no marker key
    const last = (await api.ok(`/v2/escrows/${CHATTY}/history?limit=1000`, 'history')).body as Obj;
    expect(Object.keys(last)).toEqual(HISTORY_BODY_KEYS.filter((k) => k !== 'marker'));
    expect(last.count).toBe(CHATTY_EVENTS);
  });

  it("embeds the newest 50 events in the detail and continues the detail's history_marker at /history?descending=true", async () => {
    const all = await chattyKeys();
    const res = await api.ok(`/v2/escrows/${CHATTY}`, 'escrow');
    const body = res.body as Obj;
    expect(Object.keys(body)).toEqual([...DETAIL_BODY_KEYS.escrow]);
    const embedded = body.history as Obj[];
    expect(embedded).toHaveLength(50);
    const newest = [...all].reverse();
    expect(embedded.map((e) => e.tx_hash)).toEqual(newest.slice(0, 50).map((r) => r.tx_hash));
    // the marker is the key of the 50th event
    expect(decodeMarker(body.history_marker as string)).toEqual(newest[49].key);
    // the creation is older than the newest 50 events: found by its own read, so created and the coverage are there
    const escrow = body.escrow as Obj;
    expect(escrow.created).toMatchObject({ ledger_index: 107_900_000 });
    expect(body.coverage).toEqual({ from_ledger_index: FIRST, complete: true });
    expect(escrow.status).toBe('can_be_finished');
    expect(escrow.sequence).toBe(9001);

    // the rest is the history from there, newest first: 70 events, the detail's 50 and these are the whole list
    const rest = (
      await api.ok(`/v2/escrows/${CHATTY}/history?descending=true&marker=${body.history_marker}`, 'history')
    ).body as HistoryPage;
    expect(rest.count).toBe(CHATTY_EVENTS - 50);
    expect(rest.marker).toBeUndefined();
    expect([...embedded, ...rest.history].map((e) => e.tx_hash)).toEqual(newest.map((r) => r.tx_hash));
    // the events of an escrow of 50 events or fewer have no history_marker
    expect(((await api.ok(`/v2/escrows/${OPEN}`, 'escrow')).body as Obj).history_marker).toBeUndefined();
  });

  it('answers a page past the end with count 0, and a marker for an escrow that is not there with 404', async () => {
    const past = (await api.ok(`/v2/escrows/${OPEN}/history?marker=${markerOf([HEAD, 0])}`, 'history')).body as Obj;
    expect(past).toMatchObject({ count: 0, history: [], coverage: { complete: true } });
    expect(Object.keys(past)).toEqual(HISTORY_BODY_KEYS.filter((k) => k !== 'marker'));
    const unknown = await get(`/v2/escrows/${UNKNOWN}/history?marker=${markerOf([HEAD, 0])}`);
    expect([unknown.status, unknown.body]).toEqual([404, { result: 'error', message: 'escrow not found' }]);
  });

  it('serves history as CSV with Link', async () => {
    const path = `/v2/escrows/${CHATTY.toLowerCase()}/history`;
    const csv = await get(`${path}?format=csv&limit=50`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers['content-disposition']).toBe(csvDisposition(`${CHATTY} - escrow history`));
    const header = EVENT_CSV_COLUMNS.escrow.map((c) => `"${c}"`);
    const table = lines(csv.text).map(cells);
    expect(table).toHaveLength(1 + 50);
    expect(table[0]).toEqual(header);
    expect(csv.text).not.toContain('coverage');
    expect(csv.text).not.toContain('from_ledger_index');
    // the creation is the first row: its amount is flattened into columns, the finish-only columns are empty
    const create = table[1];
    expect(create[header.indexOf('"event"')]).toBe('"create"');
    expect(create[header.indexOf('"amount.currency"')]).toBe('"XRP"');
    expect(create[header.indexOf('"amount.value"')]).toBe('"2.5"');
    expect(create[header.indexOf('"fulfillment"')]).toBe('""');
    expect(table[2][header.indexOf('"amount.value"')]).toBe('""');
    // the Link header carries the marker of the page, with the query as it was asked
    const json = (await api.ok(`${path}?limit=50`, 'history')).body as HistoryPage;
    const origin = new URL(csv.request.url).origin;
    expect(csv.headers.link).toBe(`<${origin}${path}?format=csv&limit=50&marker=${json.marker}>; rel="next"`);
    // every page of a walk has the same header, whatever its events hold; the last page has no Link
    const next = await get(`${path}?format=csv&limit=70&marker=${json.marker}`);
    expect(lines(next.text)[0].split(',')).toEqual(header);
    expect(lines(next.text)).toHaveLength(1 + 70);
    expect(next.headers.link).toBeUndefined();
    // a finish has its fulfillment in its column
    const finish = await get(`/v2/escrows/${FULFILLED}/history?format=csv&descending=true`);
    const row = lines(finish.text).map(cells)[1];
    expect(row[header.indexOf('"event"')]).toBe('"finish"');
    expect(row[header.indexOf('"fulfillment"')]).toBe(`"${FULFILLMENT}"`);
  });

  // -- the errors ------------------------------------------------------------------------------------------------------

  it.each([
    ['/v2/escrows/XYZ', 400, 'invalid escrow id'],
    [`/v2/escrows/${'A'.repeat(63)}`, 400, 'invalid escrow id'],
    [`/v2/escrows/${'G'.repeat(64)}`, 400, 'invalid escrow id'],
    [`/v2/escrows/${UNKNOWN}`, 404, 'escrow not found'],
    ['/v2/escrows/XYZ/history', 400, 'invalid escrow id'],
    [`/v2/escrows/${UNKNOWN}/history`, 404, 'escrow not found'],
    [`/v2/escrows/${OPEN}/history?marker=%%`, 400, 'invalid marker'],
    [`/v2/escrows/${OPEN}/history?marker=e30`, 400, 'invalid marker'],
    [`/v2/escrows/${UNKNOWN}/history?marker=%%`, 400, 'invalid marker'],
    [`/v2/accounts/${X_ADDRESS}/escrows/5`, 400, 'invalid ripple address'],
    ['/v2/accounts/rNotAnAddress/escrows/5', 400, 'invalid ripple address'],
    [`/v2/accounts/${OWNER}/escrows/4294967296`, 400, 'invalid sequence number'],
    [`/v2/accounts/${OWNER}/escrows/99999999999999999999`, 400, 'invalid sequence number'],
    [`/v2/accounts/${OWNER}/escrows/abc`, 400, 'invalid sequence number'],
    [`/v2/accounts/${OWNER}/escrows/-1`, 400, 'invalid sequence number'],
    [`/v2/accounts/${OWNER}/escrows/1.5`, 400, 'invalid sequence number'],
    [`/v2/accounts/${OWNER}/escrows/4294967295`, 404, 'escrow not found'],
    [`/v2/accounts/${OWNER}/escrows/0`, 404, 'escrow not found'],
  ])('%s → %i %s', async (path, status, message) => {
    const res = await get(path);
    expect([res.status, res.body]).toEqual([status, { result: 'error', message }]);
    // an error is not kept by a cache
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers 500 with the message of the route when a read fails', async () => {
    jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('clickhouse is down'));
    const detail = await get(`/v2/escrows/${OPEN}`);
    expect([detail.status, detail.body]).toEqual([500, { result: 'error', message: 'unable to retrieve escrow' }]);
    const bySequence = await get(`/v2/accounts/${OPEN_OWNER}/escrows/${OPEN_SEQUENCE}`);
    expect([bySequence.status, bySequence.body]).toEqual([
      500,
      { result: 'error', message: 'unable to retrieve escrow' },
    ]);
    const history = await get(`/v2/escrows/${OPEN}/history`);
    expect([history.status, history.body]).toEqual([
      500,
      { result: 'error', message: 'unable to retrieve escrow history' },
    ]);
  });

  it('answers 401 without a key', async () => {
    for (const path of [
      `/v2/escrows/${OPEN}`,
      `/v2/escrows/${OPEN}/history`,
      `/v2/accounts/${OPEN_OWNER}/escrows/${OPEN_SEQUENCE}`,
    ]) {
      const res = await h.http().get(path);
      expect([path, res.status, res.body]).toEqual([
        path,
        401,
        { result: 'error', message: 'Missing or invalid API key.' },
      ]);
    }
  });
});

// =====================================================================================================================
// the close time of the newest ledger, and the amendments the coverage is read from
// =====================================================================================================================

describe('the status of an escrow is the one at the close time of the newest ledger; the coverage follows the amendments', () => {
  const ID = hashOf(0xe5c10);
  /** `FinishAfter` and `CancelAfter` of the escrow, Ripple-epoch seconds, and the unix seconds they are. */
  const FINISH_AFTER = 800_000_000;
  const CANCEL_AFTER = FINISH_AFTER + 1000;
  const FINISH_UNIX = FINISH_AFTER + RIPPLE_EPOCH;
  const CANCEL_UNIX = CANCEL_AFTER + RIPPLE_EPOCH;
  /** An escrow created before the first stored ledger: nothing but its finish is indexed. */
  const OLD = hashOf(0xe5c11);
  /** The first ledger of the database (the ledger before is numbered 999, `statusAt` counts from it). */
  const FIRST = 1000;

  let h: Harness;
  let api: ApiClient;
  let ledger = FIRST - 1;

  /** The status of the escrow after a ledger that closed at `closeTime`, and the point the answer says it is as of. */
  async function statusAt(closeTime: number): Promise<{ status: unknown; asOf: unknown[] }> {
    ledger += 1;
    await seedObjects(h, [], { ledger_index: ledger, close_time: closeTime });
    const body = (await api.ok(`/v2/escrows/${ID}`, 'escrow')).body as Obj;
    return { status: (body.escrow as Obj).status, asOf: [body.ledger_index, body.close_time] };
  }

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it('answers 404 before a ledger is committed, whatever the rows say', async () => {
    await insertObjects(h, [
      objectRow({
        object_type: 'Escrow',
        object_id: ID,
        ledger_index: FIRST,
        fields: jsonOf({
          Account: OWNER,
          Amount: '1000000',
          Destination: COUNTERPARTY,
          FinishAfter: FINISH_AFTER,
          CancelAfter: CANCEL_AFTER,
        }),
      }),
    ]);
    for (const path of [`/v2/escrows/${ID}`, `/v2/escrows/${ID}/history`, `/v2/accounts/${OWNER}/escrows/1`]) {
      const res = await api.get(path);
      expect([path, res.status, res.body]).toEqual([path, 404, { result: 'error', message: 'escrow not found' }]);
    }
  });

  it('evaluates status at the close time of H', async () => {
    // H closed at FinishAfter: it cannot be finished yet (rippled tests a transaction against the close time of its parent
    // ledger, which is the close time of H for the next ledger, and a finish needs a time after FinishAfter)
    expect(await statusAt(FINISH_UNIX)).toEqual({ status: 'pending', asOf: [FIRST, iso(FINISH_UNIX)] });
    // one more ledger, a second later: it can be finished
    expect(await statusAt(FINISH_UNIX + 1)).toEqual({
      status: 'can_be_finished',
      asOf: [FIRST + 1, iso(FINISH_UNIX + 1)],
    });
    // at CancelAfter it cannot be cancelled yet, a second later it can
    expect((await statusAt(CANCEL_UNIX)).status).toBe('can_be_finished');
    expect(await statusAt(CANCEL_UNIX + 1)).toEqual({
      status: 'can_be_cancelled',
      asOf: [FIRST + 3, iso(CANCEL_UNIX + 1)],
    });
    // the history is as of the same point
    const history = (await api.ok(`/v2/escrows/${ID}/history`, 'history')).body as Obj;
    expect([history.ledger_index, history.close_time]).toEqual([FIRST + 3, iso(CANCEL_UNIX + 1)]);
  });

  it('follows the amendments the ledger state lists: complete false until Escrow is listed, then true', async () => {
    // created before the first stored ledger, finished after it: its coverage is the feature's, from the first stored ledger
    await insertObjects(h, [
      objectRow({
        object_type: 'Escrow',
        object_id: OLD,
        ledger_index: FIRST + 2,
        tx_index: 3,
        tx_type: 'EscrowFinish',
        action: 'deleted',
        event: 'finish',
        fields: jsonOf({ Account: OWNER, Amount: '1000000', Destination: COUNTERPARTY }),
      }),
    ]);
    const coverageOf = async (id: string): Promise<unknown> => {
      const body = (await api.ok(`/v2/escrows/${id}`, 'escrow')).body as Obj;
      expect(Object.keys(body.coverage as Obj)).toEqual([...COVERAGE_KEYS]);
      return body.coverage;
    };
    // the ledger state lists no amendment: nothing says when Escrow was enabled
    await api.ok('/v2/test-cache/clear', 'result');
    expect(await coverageOf(OLD)).toEqual({ from_ledger_index: FIRST, complete: false });

    // the ledger lists Escrow, a retired amendment, which gets its enable ledger (28,685,313, from the metadata) only then
    await listAmendments(h, ['Escrow'], FIRST + 3);
    await api.ok('/v2/test-cache/clear', 'result');
    expect(await coverageOf(OLD)).toEqual({ from_ledger_index: FIRST, complete: true });
    // the escrow whose creation is indexed is complete in both cases
    expect(await coverageOf(ID)).toEqual({ from_ledger_index: FIRST, complete: true });
  });

  it('is complete for an escrow whose creation is indexed even when the feature is not', async () => {
    // a ledger written by an older parser above the enable ledger moves the start of the objects above it, and past Escrow's
    const OLDER_PARSER = 30_000_000;
    await h.ch.insert(Table.Ledgers, [
      { ...ledgerRow(OLDER_PARSER, 1_800_000_000), parser_version: OBJECT_PARSER_VERSION - 1 },
    ]);
    const young = hashOf(0xe5c12);
    await insertObjects(h, [
      objectRow({
        object_type: 'Escrow',
        object_id: young,
        ledger_index: OLDER_PARSER + 50,
        fields: jsonOf({ Account: OWNER }),
      }),
    ]);
    await seedObjects(h, [], { ledger_index: OLDER_PARSER + 100, close_time: 1_800_000_500 });
    await api.ok('/v2/test-cache/clear', 'result');
    const old = (await api.ok(`/v2/escrows/${OLD}`, 'escrow')).body as Obj;
    expect(old.coverage).toEqual({ from_ledger_index: OLDER_PARSER + 1, complete: false });
    const created = (await api.ok(`/v2/escrows/${young}`, 'escrow')).body as Obj;
    expect(created.coverage).toEqual({ from_ledger_index: OLDER_PARSER + 1, complete: true });
    expect((created.escrow as Obj).created).toMatchObject({ ledger_index: OLDER_PARSER + 50 });
  });
});

// =====================================================================================================================
// the recorded Xahau ledgers
// =====================================================================================================================

describe('the escrow routes over the recorded xahau ledgers', () => {
  const HEAD = 26_399_329;
  const FIRST = 8_852_809;
  /** 200 XAH to itself, created in 14634228 and in the ledger still. */
  const XAH = 'B7083D00A118CFF42E9DC482BC84322C101D95EDA2BB8D06C70A9AB8839C3554';
  const XAH_OWNER = 'rKqZCLrHu8dMPj444xPrDQCXUpZr6U2VWi';
  /** 80,875 CLV of rK8rYU… to itself, created in 25229443. */
  const TOKEN = '04CE36B38E978993BEC1DC2EAC552C3083E3B2EB98C0DC9DD47A15DDEAE57971';
  const TOKEN_OWNER = 'rNyv2vcKQiR3UqsFBrjWR2MpjACJDFhcJT';
  /** An escrow finished in 20555633 whose creation is older than the index. */
  const OLDER = '685D816CD83F38184E774ABB4A8C552F4C4C375931F200C954BA7972C3D2B19D';

  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: 'xahau-objects', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });

  it('serves a Xahau XAH escrow and an issued-token escrow with its issuer', async () => {
    const xah = (await api.ok(`/v2/escrows/${XAH}`, 'escrow')).body as Obj;
    expect(Object.keys(xah)).toEqual(DETAIL_BODY_KEYS.escrow.filter((k) => k !== 'history_marker'));
    // Xahau starts its features at its first ledger; the stored history starts later, so the feature is incomplete and this escrow,
    // whose creation is indexed, is not
    expect(xah.coverage).toEqual({ from_ledger_index: FIRST, complete: true });
    expect([xah.ledger_index, xah.close_time]).toEqual([HEAD, iso(1_791_550_172)]);
    const escrow = xah.escrow as Obj;
    expectKeysInOrder(escrow, ESCROW_KEYS);
    expect(escrow).toEqual({
      escrow_id: XAH,
      account: XAH_OWNER,
      // a Hook's escrow has no Sequence in its node: the sequence the creating event says, which made the id
      sequence: 756_253_178,
      destination: XAH_OWNER,
      amount: { currency: 'XAH', value: '200' },
      finish_after: rippleIso(922_161_600),
      transfer_rate: 1_000_000_000,
      status: 'pending',
      created: expect.objectContaining({ ledger_index: 14_634_228 }),
    });
    expect((xah.history as Obj[])[0]).toMatchObject({ event: 'create', amount: { currency: 'XAH', value: '200' } });

    const token = (await api.ok(`/v2/escrows/${TOKEN}`, 'escrow')).body as Obj;
    expect(token.escrow).toEqual({
      escrow_id: TOKEN,
      account: TOKEN_OWNER,
      sequence: 758_570_558,
      destination: TOKEN_OWNER,
      amount: { currency: 'CLV', issuer: 'rK8rYUs6gFH4QJ9JS814EF9112gKuYZZT', value: '80875' },
      finish_after: rippleIso(1_009_904_400),
      cancel_after: rippleIso(1_109_602_800),
      transfer_rate: 1_000_000_000,
      status: 'pending',
      created: expect.objectContaining({ ledger_index: 25_229_443 }),
    });
    expect(((token.history as Obj[])[0].amount as Obj).issuer).toBe('rK8rYUs6gFH4QJ9JS814EF9112gKuYZZT');
  });

  it('answers the coverage of Xahau: the first ledger of the network, which an escrow created before the index does not have', async () => {
    const older = (await api.ok(`/v2/escrows/${OLDER}`, 'escrow')).body as Obj;
    expect(older.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
    expect((older.escrow as Obj).created).toBeUndefined();
    expect((older.escrow as Obj).status).toBe('finished');
  });

  it('serves the escrow of an account by its sequence on Xahau, and its history as CSV with the XAH amount', async () => {
    const sequence = 756_253_178;
    // the creating event says the sequence (the node has none), so the escrow by sequence is the escrow by id
    expect(escrowId(XAH_OWNER, sequence)).toBe(XAH);
    const bySequence = (await api.ok(`/v2/accounts/${XAH_OWNER}/escrows/${sequence}`, 'escrow')).body as Obj;
    expect((bySequence.escrow as Obj).escrow_id).toBe(XAH);
    const csv = await api.get(`/v2/escrows/${XAH}/history?format=csv`);
    const header = EVENT_CSV_COLUMNS.escrow.map((c) => `"${c}"`);
    const table = lines(csv.text).map(cells);
    expect(table).toHaveLength(2);
    expect(table[0]).toEqual(header);
    expect(table[1][header.indexOf('"amount.currency"')]).toBe('"XAH"');
    expect(table[1][header.indexOf('"amount.value"')]).toBe('"200"');
  });
});

// =====================================================================================================================
// the recorded XRPL ledgers: checks and payment channels
// =====================================================================================================================

/** The key of every stored row of an object and its transaction, oldest first, as the table has them. */
async function storedKeys(h: Harness, id: string): Promise<{ key: [number, number]; tx_hash: string }[]> {
  const stored = await h.ch.query<{ ledger_index: number; tx_index: number; tx_hash: string }>(
    `SELECT ledger_index, tx_index, tx_hash FROM ${Table.ObjectChanges}
      WHERE object_id = {id:String} ORDER BY ledger_index, tx_index`,
    { id },
  );
  return stored.map((r) => ({ key: [Number(r.ledger_index), Number(r.tx_index)], tx_hash: r.tx_hash }));
}

/** The keys of an event of a check and of a payment channel: the keys every event has, then what the type's event adds. */
const CHECK_EVENT_KEYS = [...EVENT_KEYS, ...EVENT_EXTRA_KEYS.check];
const CHANNEL_EVENT_KEYS = [...EVENT_KEYS, ...EVENT_EXTRA_KEYS.payment_channel];

describe('the check and payment channel routes over the recorded xrpl ledgers', () => {
  const HEAD = 107_972_102;
  const HEAD_CLOSE = 1_793_245_841;
  /** The oldest recorded ledger: where the coverage of the objects starts. */
  const FIRST = 102_145_584;

  // recorded checks (xrpl-objects)
  /** 1,000 XRP, created in the head ledger itself; no expiration. */
  const OPEN_CHECK = 'DA6BE1644276D17524D4C5645D322D4A0249B444C0A3C320EA941597243F30EA';
  /** 1 RLUSD with an invoice and an expiration (845,488,191) that the close time of the head has passed; created in 107698980. */
  const EXPIRED_CHECK = '60FCB1E8C72A695CBB6BDF718D30AF2310A9BED6D3F6D92F54C0E429186D1A42';
  /** A check for 1 RLUSD cashed for 0.438027 in 107703707 whose creation is older than the index. */
  const CASHED_TOKEN = 'AEE1BCC3B4C8EA870EF61879D9BCA66C07F6E717F8F80F6C93DEB7533C01A822';
  /** A check for 51 XRP cashed for 50 XRP in 107671568 whose creation is older than the index. */
  const CASHED_XRP = 'A13EFD941DB3E97F09C1985099A0CF89767CC34F56DB1A06595720F13B743923';
  /** A check cancelled by its own source in 107968411. */
  const CANCELLED_CHECK = '2C0D06B6A0D7FC898B4761E20220ECBC68515725AECC982BA9238B3BBA735341';

  // recorded channels
  /** 1 XRP from rQQQrU… to rLggTE…, created in 107624182 and claimed from once (32,185 drops). */
  const OPEN_CHANNEL = 'E22CCE8FA636C8BDF1C3C4AA17FD604B8FDE268E4F6BF9022B5336536F5B69EA';
  /** 0.01 XRP with a CancelAfter (843,879,905) that the close time of the head has passed; only its creation is indexed. */
  const CANCEL_AFTER_CHANNEL = '416E3F2B081C7ABBA0774A8AEE81B5577CBF707A1D1D5B26F55DC15201EC35BA';
  /** 5 XRP: a close request, a renew and a fund with an Expiration (844,841,098) are indexed; its creation is older than the index. */
  const EXPIRING_CHANNEL = '494E75E70AAFD8E655C4EBEA9541991367C038EC2251BEB4ABEBAC2AED8B0B7F';
  /** Closed by a claim that moved nothing (balance 0 of 5 XRP) in 102145584, the first recorded ledger. */
  const CLOSED_CHANNEL = 'BA23FAA9CBFBCFF6DBDD19CFA3F91BA59500C5C34763C750B7813EB4FFAC37ED';
  /** 10 XRP closed by its destination with a last claim (154,373 to 154,393 drops) in 107296498. */
  const CLAIMED_CLOSE_CHANNEL = 'FF3614BED282162CD5A8D2DDDA8C6672C519DF4F674ECF6E8EC457C820092FAF';
  /** A channel of 118 XRP whose only indexed event is a claim (107,573,214 to 111,494,161 drops). */
  const CLAIMED_CHANNEL = '6627244AA2ADD455670B38A43256DA3856B53FDBD1A92BA72D11293F34F53F02';

  // made by hand
  const THIRD_PARTY = accountAt(0xd504);
  const BY_THIRD_PARTY = hashOf(0xc4ec01);
  const CHECK_EXPIRATION = 846_000_000;
  const ABOVE_CHECK = hashOf(0xc4ec02);
  const BIG = hashOf(0xc4a001);
  const BIG_EVENTS = 1200;
  /** The events (counted from the creation, 0) that fund the big channel; every other event after the creation is a claim. */
  const BIG_FUNDS = [300, 600, 900];
  const BIG_SEQUENCE = 5001;
  const BIG_PUBLIC_KEY = `ED${'7'.repeat(64)}`;
  const TWICE_CHANNEL = hashOf(0xc4a002);
  const ABOVE_CHANNEL = hashOf(0xc4a003);

  /** The 1,200 events of the big channel: a creation (10 XRP), three funds (1 XRP each) and 1,196 claims (0.001 XRP each), two to a ledger. */
  function bigChannelRows(): ObjectChangesRow[] {
    let amount = 10_000_000;
    let balance = 0;
    return Array.from({ length: BIG_EVENTS }, (_, e) => {
      const at = { ledger_index: 107_800_000 + Math.floor(e / 2) * 10, tx_index: (e % 2) + 1 };
      const node = (): string =>
        jsonOf({
          Account: OWNER,
          Amount: String(amount),
          ...(balance > 0 && { Balance: String(balance) }),
          Destination: COUNTERPARTY,
          PublicKey: BIG_PUBLIC_KEY,
          Sequence: BIG_SEQUENCE,
          SettleDelay: 86_400,
        });
      if (e === 0) {
        return objectRow({
          object_type: 'PayChannel',
          object_id: BIG,
          ...at,
          tx_type: 'PaymentChannelCreate',
          fields: node(),
          event_fields: jsonOf({ sequence: BIG_SEQUENCE }),
        });
      }
      if (BIG_FUNDS.includes(e)) {
        const before = amount;
        amount += 1_000_000;
        return objectRow({
          object_type: 'PayChannel',
          object_id: BIG,
          ...at,
          tx_type: 'PaymentChannelFund',
          action: 'modified',
          event: 'fund',
          fields: node(),
          previous: jsonOf({ Amount: String(before) }),
        });
      }
      const before = balance;
      balance += 1_000;
      return objectRow({
        object_type: 'PayChannel',
        object_id: BIG,
        ...at,
        tx_type: 'PaymentChannelClaim',
        sender: COUNTERPARTY,
        action: 'modified',
        event: 'claim',
        fields: node(),
        previous: jsonOf({ Balance: String(before) }),
      });
    });
  }

  const checkFields = (extra: Obj = {}): string =>
    jsonOf({ Account: OWNER, Destination: COUNTERPARTY, SendMax: '5000000', Sequence: 777, ...extra });

  /** The node of a small channel of the small channels made by hand: `balance` '' is a node with no Balance (a created one, on the XRP Ledger). */
  const smallChannelNode = (amount: string, balance: string): string =>
    jsonOf({
      Account: OWNER,
      Amount: amount,
      ...(balance !== '' && { Balance: balance }),
      Destination: COUNTERPARTY,
      PublicKey: BIG_PUBLIC_KEY,
      SettleDelay: 86_400,
    });

  const rows = [
    // a check cancelled by a third party after its expiration: the expiration passed a day before the cancel
    objectRow({
      object_type: 'Check',
      object_id: BY_THIRD_PARTY,
      ledger_index: 107_930_000,
      tx_index: 3,
      tx_type: 'CheckCreate',
      close_time: CHECK_EXPIRATION + RIPPLE_EPOCH - 86_400,
      fields: checkFields({ Expiration: CHECK_EXPIRATION }),
      event_fields: jsonOf({ sequence: 777 }),
    }),
    objectRow({
      object_type: 'Check',
      object_id: BY_THIRD_PARTY,
      ledger_index: 107_960_000,
      tx_index: 9,
      tx_type: 'CheckCancel',
      sender: THIRD_PARTY,
      action: 'deleted',
      event: 'cancel',
      close_time: CHECK_EXPIRATION + RIPPLE_EPOCH + 3_600,
      fields: checkFields({ Expiration: CHECK_EXPIRATION }),
    }),
    // a check with its only row above the committed head, and a channel claimed from only above it
    objectRow({ object_type: 'Check', object_id: ABOVE_CHECK, ledger_index: HEAD + 1, tx_index: 1 }),
    objectRow({
      object_type: 'PayChannel',
      object_id: ABOVE_CHANNEL,
      ledger_index: 107_958_000,
      tx_index: 1,
      tx_type: 'PaymentChannelCreate',
      fields: smallChannelNode('2000000', ''),
    }),
    objectRow({
      object_type: 'PayChannel',
      object_id: ABOVE_CHANNEL,
      ledger_index: HEAD + 1,
      tx_index: 1,
      tx_type: 'PaymentChannelClaim',
      action: 'modified',
      event: 'claim',
      fields: smallChannelNode('2000000', '500000'),
      previous: jsonOf({ Balance: '0' }),
    }),
    // a channel whose fund and claim are in the table twice, as a re-ingest can leave them
    objectRow({
      object_type: 'PayChannel',
      object_id: TWICE_CHANNEL,
      ledger_index: 107_810_000,
      tx_index: 1,
      tx_type: 'PaymentChannelCreate',
      fields: smallChannelNode('1000000', ''),
    }),
    objectRow({
      object_type: 'PayChannel',
      object_id: TWICE_CHANNEL,
      ledger_index: 107_810_010,
      tx_index: 1,
      tx_type: 'PaymentChannelFund',
      action: 'modified',
      event: 'fund',
      fields: smallChannelNode('2000000', ''),
      previous: jsonOf({ Amount: '1000000' }),
    }),
    objectRow({
      object_type: 'PayChannel',
      object_id: TWICE_CHANNEL,
      ledger_index: 107_810_020,
      tx_index: 1,
      tx_type: 'PaymentChannelClaim',
      sender: COUNTERPARTY,
      action: 'modified',
      event: 'claim',
      fields: smallChannelNode('2000000', '250000'),
      previous: jsonOf({ Balance: '0' }),
    }),
    ...bigChannelRows(),
  ];

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];

  beforeAll(async () => {
    h = await startHarness({ seed: 'xrpl-objects', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
    get = api.get;
    await listAmendments(h, ['Escrow', 'PayChan', 'Checks'], HEAD);
    await insertObjects(h, rows);
    // the fund and the claim of TWICE_CHANNEL are written twice, each time as a part of its own
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.ObjectChanges}`);
    await h.ch.command(
      `INSERT INTO ${Table.ObjectChanges} SELECT * FROM ${Table.ObjectChanges}
        WHERE object_id = {id:String} AND event != 'create'`,
      { id: TWICE_CHANNEL },
      { settings: { insert_deduplicate: 0 } },
    );
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the data is as the tests assume', async () => {
    const head = await h.ch.queryOne<{ ledger_index: number; t: number }>(
      `SELECT ledger_index, toUnixTimestamp(close_time) AS t FROM ${Table.Ledgers} ORDER BY ledger_index DESC LIMIT 1`,
    );
    expect([head?.ledger_index, Number(head?.t)]).toEqual([HEAD, HEAD_CLOSE]);
    // the recorded objects: the rows each has, one per event
    const recorded: [string, number][] = [
      [OPEN_CHECK, 1],
      [EXPIRED_CHECK, 1],
      [CASHED_TOKEN, 1],
      [CASHED_XRP, 1],
      [CANCELLED_CHECK, 1],
      [OPEN_CHANNEL, 2],
      [CANCEL_AFTER_CHANNEL, 1],
      [EXPIRING_CHANNEL, 3],
      [CLOSED_CHANNEL, 1],
      [CLAIMED_CLOSE_CHANNEL, 1],
      [CLAIMED_CHANNEL, 1],
    ];
    for (const [id, n] of recorded) expect([id, (await storedKeys(h, id)).length]).toEqual([id, n]);
    // the made channels
    expect((await storedKeys(h, BIG)).length).toBe(BIG_EVENTS);
    expect((await storedKeys(h, TWICE_CHANNEL)).length).toBe(5);
  });

  // -- checks ----------------------------------------------------------------------------------------------------------

  it('serves an open check, a cashed one with delivered from DeliveredAmount, and an expired one still in the ledger', async () => {
    // open: 1,000 XRP, created in the head ledger, no expiration
    const open = (await api.ok(`/v2/checks/${OPEN_CHECK}`, 'check')).body as Obj;
    expect(open.coverage).toEqual({ from_ledger_index: FIRST, complete: true });
    expect(Object.keys(open)).toEqual(DETAIL_BODY_KEYS.check.filter((k) => k !== 'history_marker'));
    expect([open.ledger_index, open.close_time]).toEqual([HEAD, iso(HEAD_CLOSE)]);
    expect(open.check).toEqual({
      check_id: OPEN_CHECK,
      account: 'rfv3Z8pqTzWdB6L6EV6bRpgsUGeSfCjS1N',
      sequence: 106_663_196,
      destination: 'rNWDKX2qk6ZiFvJD3aTkLDmqE681PVvMAM',
      send_max: { currency: 'XRP', value: '1000' },
      status: 'open',
      created: {
        ledger_index: HEAD,
        time: iso(HEAD_CLOSE),
        tx_hash: 'DE0C4334780CE8115BCCB7E41371B85D13D284F82F48EFB98BE8D2F894207E0E',
      },
    });
    expectKeysInOrder(open.check as Obj, CHECK_KEYS);
    expect(Object.keys((open.check as Obj).created as Obj)).toEqual([...OBJECT_REF_KEYS]);
    expect(open.history).toEqual([
      {
        event: 'create',
        ledger_index: HEAD,
        time: iso(HEAD_CLOSE),
        tx_hash: 'DE0C4334780CE8115BCCB7E41371B85D13D284F82F48EFB98BE8D2F894207E0E',
        tx_type: 'CheckCreate',
        account: 'rfv3Z8pqTzWdB6L6EV6bRpgsUGeSfCjS1N',
        result: 'tesSUCCESS',
        send_max: { currency: 'XRP', value: '1000' },
      },
    ]);
    expect(open.history_marker).toBeUndefined();

    // expired: 1 RLUSD with an invoice, an expiration the close time of the head has passed, and the check is still in the ledger
    const expired = (await api.ok(`/v2/checks/${EXPIRED_CHECK}`, 'check')).body as Obj;
    expect(expired.coverage).toEqual({ from_ledger_index: FIRST, complete: true });
    expectKeysInOrder(expired.check as Obj, CHECK_KEYS);
    expect(expired.check).toEqual({
      check_id: EXPIRED_CHECK,
      account: 'r9CaVb4X1JVQoi6Q8Gw5cznAMRFARJDWyN',
      sequence: 106_635_339,
      destination: 'rBi1QrVjwaNofisZAQnovoXdHkS73FG1tJ',
      send_max: {
        currency: '524C555344000000000000000000000000000000',
        issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
        value: '1',
      },
      expiration: rippleIso(845_488_191),
      invoice_id: 'AB9E9A322F4A89059C5402523B218CA53745DE3672A109BD14BB1A186640AD36',
      source_tag: 804_681_468,
      status: 'expired',
      created: {
        ledger_index: 107_698_980,
        time: iso(1_792_169_402),
        tx_hash: 'CCDBCADF2DE0EF5E85A3332C4CADE9A0C28F3B5E7220C4890E27D196415D0326',
      },
    });
    const create = (expired.history as Obj[])[0];
    expectKeysInOrder(create, CHECK_EVENT_KEYS);
    expect(create).toMatchObject({
      event: 'create',
      send_max: { currency: '524C555344000000000000000000000000000000', value: '1' },
      expiration: rippleIso(845_488_191),
    });

    // cashed: the delivered amount is the DeliveredAmount of the metadata (0.438027 of the 1 RLUSD it could take), on the
    // check and on the cash event; the creation is older than the index, so the check has no created and its coverage is incomplete
    const cashed = (await api.ok(`/v2/checks/${CASHED_TOKEN}`, 'check')).body as Obj;
    expect(cashed.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
    expectKeysInOrder(cashed.check as Obj, CHECK_KEYS);
    const delivered = {
      currency: '524C555344000000000000000000000000000000',
      issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
      value: '0.438027',
    };
    expect(cashed.check).toEqual({
      check_id: CASHED_TOKEN,
      account: 'r3f6bMRipu5zneH4k7ieERt4PGhXCJkVDH',
      sequence: 106_641_443,
      destination: 'rBi1QrVjwaNofisZAQnovoXdHkS73FG1tJ',
      send_max: { currency: '524C555344000000000000000000000000000000', issuer: delivered.issuer, value: '1' },
      expiration: rippleIso(845_506_521),
      invoice_id: 'CAFA37B4E24B58A46C1E5FCADF76C5E6429F4B793473EA582C186DF795E38107',
      source_tag: 804_681_468,
      delivered,
      status: 'cashed',
      removed: {
        ledger_index: 107_703_707,
        time: iso(1_792_187_842),
        tx_hash: '3ABD7BA6DA173F446AFA31C5C2D4EA51FC73A3BDA6E9ED7BBC557A215E33B330',
        tx_type: 'CheckCash',
      },
    });
    expect(Object.keys((cashed.check as Obj).removed as Obj)).toEqual([...REMOVED_KEYS]);
    expect(cashed.history).toEqual([
      {
        event: 'cash',
        ledger_index: 107_703_707,
        time: iso(1_792_187_842),
        tx_hash: '3ABD7BA6DA173F446AFA31C5C2D4EA51FC73A3BDA6E9ED7BBC557A215E33B330',
        tx_type: 'CheckCash',
        // the destination cashed it
        account: 'rBi1QrVjwaNofisZAQnovoXdHkS73FG1tJ',
        result: 'tesSUCCESS',
        delivered,
      },
    ]);

    // cashed in drops: 50 of the 51 XRP, in whole units
    const xrp = (await api.ok(`/v2/checks/${CASHED_XRP}`, 'check')).body as Obj;
    expect(xrp.check).toMatchObject({
      send_max: { currency: 'XRP', value: '51' },
      delivered: { currency: 'XRP', value: '50' },
      status: 'cashed',
    });
    expect(((xrp.history as Obj[])[0] as Obj).delivered).toEqual({ currency: 'XRP', value: '50' });

    // cancelled by its source: no delivered
    const cancelled = (await api.ok(`/v2/checks/${CANCELLED_CHECK}`, 'check')).body as Obj;
    expectKeysInOrder(cancelled.check as Obj, CHECK_KEYS);
    expect(cancelled.check).toMatchObject({
      account: 'rPP3R33zpehB5hTy2jSYZek5ntq3HQym68',
      status: 'cancelled',
      removed: { ledger_index: 107_968_411, tx_type: 'CheckCancel' },
    });
    expect((cancelled.check as Obj).delivered).toBeUndefined();
    expect((cancelled.history as Obj[]).map((e) => [e.event, e.account])).toEqual([
      ['cancel', 'rPP3R33zpehB5hTy2jSYZek5ntq3HQym68'],
    ]);
  });

  it('serves a check cancelled by a third party after its expiration', async () => {
    const body = (await api.ok(`/v2/checks/${BY_THIRD_PARTY}`, 'check')).body as Obj;
    // the expiration had passed when it was cancelled and the check is not in the ledger: it was cancelled, not expired
    expectKeysInOrder(body.check as Obj, CHECK_KEYS);
    expect(body.check).toEqual({
      check_id: BY_THIRD_PARTY,
      account: OWNER,
      sequence: 777,
      destination: COUNTERPARTY,
      send_max: { currency: 'XRP', value: '5' },
      expiration: rippleIso(CHECK_EXPIRATION),
      status: 'cancelled',
      created: {
        ledger_index: 107_930_000,
        time: iso(CHECK_EXPIRATION + RIPPLE_EPOCH - 86_400),
        tx_hash: expect.any(String),
      },
      removed: {
        ledger_index: 107_960_000,
        time: iso(CHECK_EXPIRATION + RIPPLE_EPOCH + 3_600),
        tx_hash: expect.any(String),
        tx_type: 'CheckCancel',
      },
    });
    expect(body.coverage).toEqual({ from_ledger_index: FIRST, complete: true });
    // the cancel is the sender's own: the account that cancelled it, not the owner
    const history = body.history as Obj[];
    expect(history.map((e) => [e.event, e.tx_type, e.account])).toEqual([
      ['cancel', 'CheckCancel', THIRD_PARTY],
      ['create', 'CheckCreate', OWNER],
    ]);
    for (const event of history) expectKeysInOrder(event, CHECK_EVENT_KEYS);
    expect(history[1]).toMatchObject({
      send_max: { currency: 'XRP', value: '5' },
      expiration: rippleIso(CHECK_EXPIRATION),
    });
    expect(history[0].delivered).toBeUndefined();
  });

  // -- payment channels -------------------------------------------------------------------------------------------------

  it('serves an open channel, a closing one (expiration set; CancelAfter passed) and a closed one', async () => {
    // open: created and claimed from once, with the first claim of a channel carrying a previous balance of "0"
    const open = (await api.ok(`/v2/payment_channels/${OPEN_CHANNEL}`, 'payment_channel')).body as Obj;
    expect(Object.keys(open)).toEqual(DETAIL_BODY_KEYS.payment_channel.filter((k) => k !== 'history_marker'));
    expect(open.coverage).toEqual({ from_ledger_index: FIRST, complete: true });
    expect([open.ledger_index, open.close_time]).toEqual([HEAD, iso(HEAD_CLOSE)]);
    expectKeysInOrder(open.payment_channel as Obj, PAYMENT_CHANNEL_KEYS);
    expect(open.payment_channel).toEqual({
      channel_id: OPEN_CHANNEL,
      account: 'rQQQrUdN1cLdNmxH4dHfKgmX5P4kf3ZrM',
      sequence: 61_531_741,
      destination: 'rLggTEwmTe3eJgyQbCSk4wQazow2TeKrtR',
      amount: { currency: 'XRP', value: '1' },
      balance: { currency: 'XRP', value: '0.032185' },
      remaining: { currency: 'XRP', value: '0.967815' },
      settle_delay: 1_209_600,
      public_key: '03D63CA73239D94AAF52574A20E3BC26CBDB811CA55A5914FAA28836F079CE0DC3',
      status: 'open',
      opened_with: { currency: 'XRP', value: '1' },
      funds: 0,
      claims: 1,
      created: {
        ledger_index: 107_624_182,
        time: iso(1_791_878_731),
        tx_hash: 'E8A8466AF9E1E5E6339F1EAC64A9B8AD7AB4BE42613605511EDC80E1FCD34127',
      },
    });
    const events = open.history as Obj[];
    // newest first: the claim, then the creation, whose node has no Balance (zero in the channel's currency)
    expect(events).toEqual([
      {
        event: 'claim',
        ledger_index: 107_641_123,
        time: iso(1_791_944_730),
        tx_hash: '886A9054CD78D4C2F1250999F8D65DB3048F8FC9AFB24523AD755B29797AC790',
        tx_type: 'PaymentChannelClaim',
        account: 'rLggTEwmTe3eJgyQbCSk4wQazow2TeKrtR',
        result: 'tesSUCCESS',
        amount: { currency: 'XRP', value: '1' },
        balance: { currency: 'XRP', value: '0.032185' },
        balance_change: { currency: 'XRP', value: '0.032185' },
      },
      {
        event: 'create',
        ledger_index: 107_624_182,
        time: iso(1_791_878_731),
        tx_hash: 'E8A8466AF9E1E5E6339F1EAC64A9B8AD7AB4BE42613605511EDC80E1FCD34127',
        tx_type: 'PaymentChannelCreate',
        account: 'rQQQrUdN1cLdNmxH4dHfKgmX5P4kf3ZrM',
        result: 'tesSUCCESS',
        amount: { currency: 'XRP', value: '1' },
        balance: { currency: 'XRP', value: '0' },
        settle_delay: 1_209_600,
      },
    ]);
    for (const event of events) expectKeysInOrder(event, CHANNEL_EVENT_KEYS);

    // closing by its expiration (a fund set 844,841,098): a close request, a renew and a fund are indexed, not its creation
    const expiring = (await api.ok(`/v2/payment_channels/${EXPIRING_CHANNEL}`, 'payment_channel')).body as Obj;
    expect(expiring.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
    expectKeysInOrder(expiring.payment_channel as Obj, PAYMENT_CHANNEL_KEYS);
    expect(expiring.payment_channel).toEqual({
      channel_id: EXPIRING_CHANNEL,
      account: 'rfn1iu8peiUtayZMqXcpL8rt7x4cfk1Qfu',
      destination: 'rLggTEwmTe3eJgyQbCSk4wQazow2TeKrtR',
      amount: { currency: 'XRP', value: '5.000002' },
      balance: { currency: 'XRP', value: '5' },
      remaining: { currency: 'XRP', value: '0.000002' },
      settle_delay: 1_209_600,
      public_key: '03A6C6BED4F26E1EBD97A7A4AE82560D3BA21C465F95A350FEAFC1BF17574CD306',
      expiration: rippleIso(844_841_098),
      status: 'closing',
      funds: 1,
      claims: 0,
    });
    const expiringEvents = expiring.history as Obj[];
    expect(expiringEvents.map((e) => e.event)).toEqual(['fund', 'renew', 'close_request']);
    for (const event of expiringEvents) expectKeysInOrder(event, CHANNEL_EVENT_KEYS);
    // the fund added 1 drop (and has the expiration after it); the renew removed the expiration: it has none after it
    expect(expiringEvents[0]).toMatchObject({
      amount: { currency: 'XRP', value: '5.000002' },
      balance: { currency: 'XRP', value: '5' },
      amount_change: { currency: 'XRP', value: '0.000001' },
      expiration: rippleIso(844_841_098),
    });
    expect(expiringEvents[0].balance_change).toBeUndefined();
    expect(expiringEvents[1].expiration).toBeUndefined();
    expect(expiringEvents[2]).toMatchObject({ expiration: rippleIso(844_406_430), balance: { value: '0.002469' } });

    // closing by its CancelAfter (the close time of the head is after it), nothing else indexed than its creation
    const cancelAfter = (await api.ok(`/v2/payment_channels/${CANCEL_AFTER_CHANNEL}`, 'payment_channel')).body as Obj;
    expect(cancelAfter.coverage).toEqual({ from_ledger_index: FIRST, complete: true });
    expect(cancelAfter.payment_channel).toEqual({
      channel_id: CANCEL_AFTER_CHANNEL,
      account: 'rUQqjyFbrzwaEFyKywS1xeWWWseJMch4jm',
      sequence: 106_562_599,
      destination: 'rLggTEwmTe3eJgyQbCSk4wQazow2TeKrtR',
      amount: { currency: 'XRP', value: '0.01' },
      balance: { currency: 'XRP', value: '0' },
      remaining: { currency: 'XRP', value: '0.01' },
      settle_delay: 1_209_600,
      public_key: 'EDD572DC0C52BE99DE671A585FBBD0840B953C9765A5B50873B27DF930AA3BC144',
      cancel_after: rippleIso(843_879_905),
      status: 'closing',
      opened_with: { currency: 'XRP', value: '0.01' },
      funds: 0,
      claims: 0,
      created: {
        ledger_index: 106_970_128,
        time: iso(1_789_351_510),
        tx_hash: '04BF7DE957E5E2EE8BB67EF00CEB2EFF7A72496FAED3442CA9680E8ECF2EAFB7',
      },
    });

    // closed by a claim that moved nothing: what was deposited is returned, remaining is all of it
    const closed = (await api.ok(`/v2/payment_channels/${CLOSED_CHANNEL}`, 'payment_channel')).body as Obj;
    expect(closed.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
    expect(closed.payment_channel).toEqual({
      channel_id: CLOSED_CHANNEL,
      account: 'rBJmvoyhs9Z7tmXTuViYvpPBDTw9hGJGfz',
      destination: 'rLggTEwmTe3eJgyQbCSk4wQazow2TeKrtR',
      amount: { currency: 'XRP', value: '5' },
      balance: { currency: 'XRP', value: '0' },
      remaining: { currency: 'XRP', value: '5' },
      settle_delay: 1_209_600,
      public_key: 'ED8C2FE733BB415BB51C470344905E12965CE1429A6586AF345A8953980B33E02F',
      expiration: rippleIso(823_998_390),
      status: 'closed',
      funds: 0,
      claims: 0,
      removed: {
        ledger_index: 102_145_584,
        time: iso(1_770_699_681),
        tx_hash: '9E365C57A2C57EFD0C2E46907E6E8625972350BE0A929005FB3F3A68922B20B9',
        tx_type: 'PaymentChannelClaim',
      },
    });
    expectKeysInOrder(closed.payment_channel as Obj, PAYMENT_CHANNEL_KEYS);

    // closed by its destination with a last claim: the claim is an event that moved the balance, and the channel counts it
    const claimedClose = (await api.ok(`/v2/payment_channels/${CLAIMED_CLOSE_CHANNEL}`, 'payment_channel')).body as Obj;
    expect(claimedClose.payment_channel).toMatchObject({
      amount: { currency: 'XRP', value: '10' },
      balance: { currency: 'XRP', value: '0.154393' },
      remaining: { currency: 'XRP', value: '9.845607' },
      status: 'closed',
      funds: 0,
      claims: 1,
      removed: { ledger_index: 107_296_498, tx_type: 'PaymentChannelClaim' },
    });
    expect((claimedClose.history as Obj[])[0]).toMatchObject({
      event: 'close',
      account: 'rLggTEwmTe3eJgyQbCSk4wQazow2TeKrtR',
      balance_change: { currency: 'XRP', value: '0.00002' },
    });

    // a channel whose creation is older than the index and whose first indexed event is a claim: no creation to open with
    const claimed = (await api.ok(`/v2/payment_channels/${CLAIMED_CHANNEL}`, 'payment_channel')).body as Obj;
    const claimedChannel = claimed.payment_channel as Obj;
    expect(claimedChannel).toMatchObject({
      sequence: 93_214_305,
      amount: { currency: 'XRP', value: '118' },
      balance: { currency: 'XRP', value: '111.494161' },
      remaining: { currency: 'XRP', value: '6.505839' },
      status: 'open',
      funds: 0,
      claims: 1,
    });
    expect(claimedChannel.opened_with).toBeUndefined();
    expect(claimedChannel.created).toBeUndefined();
    expect((claimed.history as Obj[])[0].balance_change).toEqual({ currency: 'XRP', value: '3.920947' });
  });

  it('counts the funds and the claims, each transaction once and none above the committed head', async () => {
    // a fund and a claim that are in the table twice count once; the events are each once too
    const twice = (await api.ok(`/v2/payment_channels/${TWICE_CHANNEL}`, 'payment_channel')).body as Obj;
    expect(twice.payment_channel).toMatchObject({
      amount: { currency: 'XRP', value: '2' },
      balance: { currency: 'XRP', value: '0.25' },
      funds: 1,
      claims: 1,
    });
    expect((twice.history as Obj[]).map((e) => e.event)).toEqual(['claim', 'fund', 'create']);
    // the claim above the head is not counted, and the channel is as it was at the head
    const above = (await api.ok(`/v2/payment_channels/${ABOVE_CHANNEL}`, 'payment_channel')).body as Obj;
    expect(above.payment_channel).toMatchObject({
      balance: { currency: 'XRP', value: '0' },
      funds: 0,
      claims: 0,
    });
    expect((above.history as Obj[]).map((e) => e.event)).toEqual(['create']);
  });

  it('a channel with 1,200 events: detail, marker, counts and creation', async () => {
    const stored = await storedKeys(h, BIG);
    const newest = [...stored].reverse();
    const body = (await api.ok(`/v2/payment_channels/${BIG}`, 'payment_channel')).body as Obj;
    expect(Object.keys(body)).toEqual([...DETAIL_BODY_KEYS.payment_channel]);
    expect(body.coverage).toEqual({ from_ledger_index: FIRST, complete: true });
    const channel = body.payment_channel as Obj;
    expectKeysInOrder(channel, PAYMENT_CHANNEL_KEYS);
    // 1 creation of 10 XRP, 3 funds of 1 XRP, 1,196 claims of 0.001 XRP: the counts are of all 1,200 events though the page holds 50
    expect(channel).toEqual({
      channel_id: BIG,
      account: OWNER,
      sequence: BIG_SEQUENCE,
      destination: COUNTERPARTY,
      amount: { currency: 'XRP', value: '13' },
      balance: { currency: 'XRP', value: '1.196' },
      remaining: { currency: 'XRP', value: '11.804' },
      settle_delay: 86_400,
      public_key: BIG_PUBLIC_KEY,
      status: 'open',
      // the creation is older than the newest 50 events: found by its own read, with the 10 XRP it opened with
      opened_with: { currency: 'XRP', value: '10' },
      funds: 3,
      claims: 1196,
      created: { ledger_index: 107_800_000, time: iso(1_793_226_600), tx_hash: stored[0].tx_hash },
    });
    const embedded = body.history as Obj[];
    expect(embedded).toHaveLength(50);
    expect(embedded.map((e) => e.tx_hash)).toEqual(newest.slice(0, 50).map((r) => r.tx_hash));
    for (const event of embedded) expectKeysInOrder(event, CHANNEL_EVENT_KEYS);
    // the newest event is the last claim: the balance after it and what it added
    expect(embedded[0]).toMatchObject({
      event: 'claim',
      account: COUNTERPARTY,
      amount: { currency: 'XRP', value: '13' },
      balance: { currency: 'XRP', value: '1.196' },
      balance_change: { currency: 'XRP', value: '0.001' },
    });
    // the marker is the key of the 50th event and continues the history newest first, to the creation
    expect(decodeMarker(body.history_marker as string)).toEqual(newest[49].key);
    const rest: HistoryPage[] = [];
    for (let marker = body.history_marker as string | undefined; marker !== undefined; ) {
      const page = (
        await api.ok(`/v2/payment_channels/${BIG}/history?descending=true&limit=500&marker=${marker}`, 'history')
      ).body as HistoryPage;
      rest.push(page);
      marker = page.marker;
    }
    expect(rest.map((p) => p.count)).toEqual([500, 500, 150]);
    expect([...embedded, ...rest.flatMap((p) => p.history)].map((e) => e.tx_hash)).toEqual(
      newest.map((r) => r.tx_hash),
    );
    // a fund and the creation, as they are in the history
    const events = rest.flatMap((p) => p.history);
    expect(events.find((e) => e.event === 'fund')).toMatchObject({
      tx_type: 'PaymentChannelFund',
      account: OWNER,
      amount_change: { currency: 'XRP', value: '1' },
    });
    expect(events[events.length - 1]).toMatchObject({
      event: 'create',
      amount: { currency: 'XRP', value: '10' },
      balance: { currency: 'XRP', value: '0' },
      settle_delay: 86_400,
    });
  });

  it('pages of a 1,200-event history concatenate both ways', async () => {
    const all = await storedKeys(h, BIG);
    expect(all).toHaveLength(BIG_EVENTS);
    for (const descending of [false, true]) {
      const want = descending ? [...all].reverse() : all;
      const path = `/v2/payment_channels/${BIG}/history?descending=${descending}`;
      for (const limit of [37, 200, 599, 600, 601, 1000]) {
        const pages = await api.pages<HistoryPage>(path, limit, 'history');
        expect([path, limit, pages.flatMap((p) => p.history.map((e) => e.tx_hash))]).toEqual([
          path,
          limit,
          want.map((r) => r.tx_hash),
        ]);
        expect(pages.map((p) => p.count)).toEqual(
          Array.from({ length: Math.ceil(BIG_EVENTS / limit) }, (_, i) => Math.min(limit, BIG_EVENTS - i * limit)),
        );
        // only the last page has no marker
        expect(pages.map((p) => p.marker === undefined)).toEqual(pages.map((_, i) => i === pages.length - 1));
      }
      // the marker is the key of the last row of its page
      const first = (await api.ok(`${path}&limit=3`)).body as HistoryPage;
      expect(decodeMarker(first.marker as string)).toEqual(want[2].key);
    }
    // the answer of a page has the keys of the history answer and the coverage of the channel
    const body = (await api.ok(`/v2/payment_channels/${BIG}/history?limit=7`, 'history')).body as Obj;
    expect(Object.keys(body)).toEqual([...HISTORY_BODY_KEYS]);
    expect(body.coverage).toEqual({ from_ledger_index: FIRST, complete: true });
    expect([body.ledger_index, body.close_time, body.count]).toEqual([HEAD, iso(HEAD_CLOSE), 7]);
    // the creation first, with the channel's currency in every amount
    expect((body.history as Obj[])[0]).toMatchObject({ event: 'create', amount: { currency: 'XRP', value: '10' } });
  });

  // -- the history as CSV ------------------------------------------------------------------------------------------------

  it('serves the history of a channel as CSV with Link, the same columns on every page', async () => {
    const path = `/v2/payment_channels/${BIG.toLowerCase()}/history`;
    const csv = await get(`${path}?format=csv&limit=50`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers['content-disposition']).toBe(csvDisposition(`${BIG} - payment channel history`));
    const header = EVENT_CSV_COLUMNS.payment_channel.map((c) => `"${c}"`);
    const table = lines(csv.text).map(cells);
    expect(table).toHaveLength(1 + 50);
    expect(table[0]).toEqual(header);
    expect(csv.text).not.toContain('coverage');
    const column = (row: string[], name: string): string => row[header.indexOf(`"${name}"`)];
    // the creation: its amount and balance flattened, no change
    expect(column(table[1], 'event')).toBe('"create"');
    expect(column(table[1], 'amount.currency')).toBe('"XRP"');
    expect(column(table[1], 'amount.value')).toBe('"10"');
    expect(column(table[1], 'balance.value')).toBe('"0"');
    expect(column(table[1], 'settle_delay')).toBe('"86400"');
    expect(column(table[1], 'balance_change.value')).toBe('""');
    // a claim
    expect(column(table[2], 'event')).toBe('"claim"');
    expect(column(table[2], 'balance_change.value')).toBe('"0.001"');
    expect(column(table[2], 'settle_delay')).toBe('""');
    // the Link header carries the marker of the page, with the query as it was asked
    const json = (await api.ok(`${path}?limit=50`, 'history')).body as HistoryPage;
    const origin = new URL(csv.request.url).origin;
    expect(csv.headers.link).toBe(`<${origin}${path}?format=csv&limit=50&marker=${json.marker}>; rel="next"`);
    // a page of claims alone has the header of a page with a creation in it; so does the page of a fund
    const claims = await get(`${path}?format=csv&limit=5&descending=true`);
    expect(lines(claims.text)[0].split(',')).toEqual(header);
    expect(cells(lines(claims.text)[1])[header.indexOf('"event"')]).toBe('"claim"');
    const fund = await get(`${path}?format=csv&limit=1&marker=${markerOf([107_801_490, 2])}`);
    expect(lines(fund.text)[0].split(',')).toEqual(header);
    const fundRow = cells(lines(fund.text)[1]);
    expect(column(fundRow, 'event')).toBe('"fund"');
    expect(column(fundRow, 'amount_change.value')).toBe('"1"');
    expect(column(fundRow, 'balance_change.value')).toBe('""');
  });

  it('serves the history of a check as CSV with the delivered amount in its columns', async () => {
    const csv = await get(`/v2/checks/${CASHED_TOKEN}/history?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toBe(csvDisposition(`${CASHED_TOKEN} - check history`));
    const header = EVENT_CSV_COLUMNS.check.map((c) => `"${c}"`);
    const table = lines(csv.text).map(cells);
    expect(table).toHaveLength(2);
    expect(table[0]).toEqual(header);
    const row = table[1];
    expect(row[header.indexOf('"event"')]).toBe('"cash"');
    expect(row[header.indexOf('"delivered.currency"')]).toBe('"524C555344000000000000000000000000000000"');
    expect(row[header.indexOf('"delivered.issuer"')]).toBe('"rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"');
    expect(row[header.indexOf('"delivered.value"')]).toBe('"0.438027"');
    expect(row[header.indexOf('"send_max.value"')]).toBe('""');
    expect(csv.headers.link).toBeUndefined();
    // the creation of a check has its send_max and expiration and no delivered
    const created = lines((await get(`/v2/checks/${EXPIRED_CHECK}/history?format=csv`)).text).map(cells);
    expect(created[0]).toEqual(header);
    expect(created[1][header.indexOf('"send_max.value"')]).toBe('"1"');
    expect(created[1][header.indexOf('"expiration"')]).toBe(`"${rippleIso(845_488_191)}"`);
    expect(created[1][header.indexOf('"delivered.value"')]).toBe('""');
  });

  // -- ids, heads and errors ---------------------------------------------------------------------------------------------

  it('answers a lower-case id in upper case', async () => {
    const check = (await api.ok(`/v2/checks/${OPEN_CHECK.toLowerCase()}`, 'check')).body as Obj;
    expect((check.check as Obj).check_id).toBe(OPEN_CHECK);
    const channel = (await api.ok(`/v2/payment_channels/${OPEN_CHANNEL.toLowerCase()}`, 'payment_channel')).body as Obj;
    expect((channel.payment_channel as Obj).channel_id).toBe(OPEN_CHANNEL);
    expect(((await api.ok(`/v2/checks/${OPEN_CHECK.toLowerCase()}/history`, 'history')).body as Obj).count).toBe(1);
    expect(
      ((await api.ok(`/v2/payment_channels/${OPEN_CHANNEL.toLowerCase()}/history`, 'history')).body as Obj).count,
    ).toBe(2);
  });

  it('serves nothing above the committed head', async () => {
    for (const path of [`/v2/checks/${ABOVE_CHECK}`, `/v2/checks/${ABOVE_CHECK}/history`]) {
      const res = await get(path);
      expect([path, res.status, res.body]).toEqual([path, 404, { result: 'error', message: 'check not found' }]);
    }
  });

  it.each([
    ['checks', OPEN_CHECK, 'check not found'],
    ['payment_channels', OPEN_CHANNEL, 'payment channel not found'],
  ])(
    '/v2/%s: a page past the end is count 0, a marker for an object that is not there is 404',
    async (route, id, message) => {
      // (the key after every row of the object, whatever its transaction index)
      const end = markerOf([HEAD, 1_000_000]);
      const past = (await api.ok(`/v2/${route}/${id}/history?marker=${end}`, 'history')).body as Obj;
      expect(past).toMatchObject({ count: 0, history: [], coverage: { complete: true } });
      expect(Object.keys(past)).toEqual(HISTORY_BODY_KEYS.filter((k) => k !== 'marker'));
      const unknown = await get(`/v2/${route}/${UNKNOWN}/history?marker=${end}`);
      expect([unknown.status, unknown.body]).toEqual([404, { result: 'error', message }]);
    },
  );

  it.each([
    ['/v2/checks/XYZ', 400, 'invalid check id'],
    [`/v2/checks/${'A'.repeat(63)}`, 400, 'invalid check id'],
    [`/v2/checks/${'A'.repeat(65)}`, 400, 'invalid check id'],
    [`/v2/checks/${'G'.repeat(64)}`, 400, 'invalid check id'],
    [`/v2/checks/${UNKNOWN}`, 404, 'check not found'],
    ['/v2/checks/XYZ/history', 400, 'invalid check id'],
    [`/v2/checks/${UNKNOWN}/history`, 404, 'check not found'],
    [`/v2/checks/${OPEN_CHECK}/history?marker=%%`, 400, 'invalid marker'],
    [`/v2/checks/${OPEN_CHECK}/history?marker=e30`, 400, 'invalid marker'],
    [`/v2/checks/${UNKNOWN}/history?marker=%%`, 400, 'invalid marker'],
    ['/v2/payment_channels/XYZ', 400, 'invalid channel id'],
    [`/v2/payment_channels/${'A'.repeat(63)}`, 400, 'invalid channel id'],
    [`/v2/payment_channels/${'A'.repeat(65)}`, 400, 'invalid channel id'],
    [`/v2/payment_channels/${'G'.repeat(64)}`, 400, 'invalid channel id'],
    [`/v2/payment_channels/${UNKNOWN}`, 404, 'payment channel not found'],
    ['/v2/payment_channels/XYZ/history', 400, 'invalid channel id'],
    [`/v2/payment_channels/${UNKNOWN}/history`, 404, 'payment channel not found'],
    [`/v2/payment_channels/${OPEN_CHANNEL}/history?marker=%%`, 400, 'invalid marker'],
    [`/v2/payment_channels/${OPEN_CHANNEL}/history?marker=e30`, 400, 'invalid marker'],
    [`/v2/payment_channels/${UNKNOWN}/history?marker=%%`, 400, 'invalid marker'],
    // a check id is no channel: each route reads its own type
    [`/v2/payment_channels/${OPEN_CHECK}`, 404, 'payment channel not found'],
    [`/v2/checks/${OPEN_CHANNEL}`, 404, 'check not found'],
    [`/v2/checks/${EXPIRING_CHANNEL}/history`, 404, 'check not found'],
  ])('%s → %i %s', async (path, status, message) => {
    const res = await get(path);
    expect([res.status, res.body]).toEqual([status, { result: 'error', message }]);
    // an error is not kept by a cache
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers 500 with the message of the route when a read fails', async () => {
    jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('clickhouse is down'));
    for (const [path, message] of [
      [`/v2/checks/${OPEN_CHECK}`, 'unable to retrieve check'],
      [`/v2/checks/${OPEN_CHECK}/history`, 'unable to retrieve check history'],
      [`/v2/payment_channels/${OPEN_CHANNEL}`, 'unable to retrieve payment channel'],
      [`/v2/payment_channels/${OPEN_CHANNEL}/history`, 'unable to retrieve payment channel history'],
    ]) {
      const res = await get(path);
      expect([path, res.status, res.body]).toEqual([path, 500, { result: 'error', message }]);
    }
  });

  it('answers 401 without a key', async () => {
    for (const path of [
      `/v2/checks/${OPEN_CHECK}`,
      `/v2/checks/${OPEN_CHECK}/history`,
      `/v2/payment_channels/${OPEN_CHANNEL}`,
      `/v2/payment_channels/${OPEN_CHANNEL}/history`,
    ]) {
      const res = await h.http().get(path);
      expect([path, res.status, res.body]).toEqual([
        path,
        401,
        { result: 'error', message: 'Missing or invalid API key.' },
      ]);
    }
  });
});

// =====================================================================================================================
// the close time of the newest ledger: the status of a check and of a channel
// =====================================================================================================================

describe('the status of a check and of a payment channel is the one at the close time of the newest ledger', () => {
  const CHECK = hashOf(0xc4ec10);
  const CHANNEL = hashOf(0xc4a010);
  const EXPIRING = hashOf(0xc4a011);
  /** The `Expiration` of the check and the `CancelAfter` of the channel (Ripple-epoch seconds), and the unix seconds they are. */
  const EXPIRATION = 800_000_000;
  const CANCEL_AFTER = 800_000_500;
  const EXPIRATION_UNIX = EXPIRATION + RIPPLE_EPOCH;
  const CANCEL_UNIX = CANCEL_AFTER + RIPPLE_EPOCH;
  const FIRST = 1000;

  let h: Harness;
  let api: ApiClient;
  let ledger = FIRST - 1;

  /** The statuses after a ledger that closed at `closeTime`: the check, the channel and the channel that has an Expiration. */
  async function statusesAt(closeTime: number): Promise<unknown[]> {
    ledger += 1;
    await seedObjects(h, [], { ledger_index: ledger, close_time: closeTime });
    const check = (await api.ok(`/v2/checks/${CHECK}`, 'check')).body as Obj;
    const channel = (await api.ok(`/v2/payment_channels/${CHANNEL}`, 'payment_channel')).body as Obj;
    const expiring = (await api.ok(`/v2/payment_channels/${EXPIRING}`, 'payment_channel')).body as Obj;
    expect([check.ledger_index, channel.close_time]).toEqual([ledger, iso(closeTime)]);
    return [
      (check.check as Obj).status,
      (channel.payment_channel as Obj).status,
      (expiring.payment_channel as Obj).status,
    ];
  }

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
    const channelFields = (extra: Obj = {}): string =>
      jsonOf({
        Account: OWNER,
        Amount: '1000000',
        Destination: COUNTERPARTY,
        PublicKey: `ED${'7'.repeat(64)}`,
        SettleDelay: 86_400,
        ...extra,
      });
    await insertObjects(h, [
      objectRow({
        object_type: 'Check',
        object_id: CHECK,
        ledger_index: FIRST,
        tx_type: 'CheckCreate',
        fields: jsonOf({ Account: OWNER, Destination: COUNTERPARTY, Expiration: EXPIRATION, SendMax: '1000000' }),
      }),
      objectRow({
        object_type: 'PayChannel',
        object_id: CHANNEL,
        ledger_index: FIRST,
        tx_type: 'PaymentChannelCreate',
        fields: channelFields({ CancelAfter: CANCEL_AFTER }),
      }),
      // a channel with an Expiration is closing whatever the time is, as long as it is in the ledger
      objectRow({
        object_type: 'PayChannel',
        object_id: EXPIRING,
        ledger_index: FIRST,
        tx_type: 'PaymentChannelClaim',
        action: 'modified',
        event: 'close_request',
        fields: channelFields({ Expiration: CANCEL_AFTER + 10_000_000 }),
      }),
    ]);
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it('answers 404 before a ledger is committed, whatever the rows say', async () => {
    for (const [path, message] of [
      [`/v2/checks/${CHECK}`, 'check not found'],
      [`/v2/checks/${CHECK}/history`, 'check not found'],
      [`/v2/payment_channels/${CHANNEL}`, 'payment channel not found'],
      [`/v2/payment_channels/${CHANNEL}/history`, 'payment channel not found'],
    ]) {
      const res = await api.get(path);
      expect([path, res.status, res.body]).toEqual([path, 404, { result: 'error', message }]);
    }
  });

  it('evaluates a check at its expiration and a channel at its CancelAfter against the close time of H', async () => {
    // the check expires at its expiration (a cash needs a time before it), the channel is closing from its CancelAfter on
    expect(await statusesAt(EXPIRATION_UNIX - 1)).toEqual(['open', 'open', 'closing']);
    expect(await statusesAt(EXPIRATION_UNIX)).toEqual(['expired', 'open', 'closing']);
    expect(await statusesAt(CANCEL_UNIX - 1)).toEqual(['expired', 'open', 'closing']);
    expect(await statusesAt(CANCEL_UNIX)).toEqual(['expired', 'closing', 'closing']);
    expect(await statusesAt(CANCEL_UNIX + 1)).toEqual(['expired', 'closing', 'closing']);
  });
});

// =====================================================================================================================
// the recorded Xahau ledgers: checks and payment channels
// =====================================================================================================================

describe('the check and payment channel routes over the recorded xahau ledgers', () => {
  const HEAD = 26_399_329;
  const FIRST = 8_852_809;
  /** 1 DHA of rDyz9r… in a channel from rL6rwN… to rLggTE…, created in 11056548 and claimed from once (0.023506 DHA). */
  const TOKEN_CHANNEL = '29FE7315A85998E7039B0E97AEEB0C1ACA4CE72D6D0DD25C79CCC26466988AF0';
  /** 0.3 XAH in a channel of the same pair, created in 8852809 (its node has a Balance "0") and claimed from once (15,838 drops). */
  const XAH_CHANNEL = '760841CB48554EC05365E201E3C1E50001701835BA3E71384DEFC7055BE79F04';
  /** 1 XAH, created in 12064511 and cashed with a DeliverMin and no Amount in 12064524. */
  const XAH_CHECK = 'F3B54B771F9269A2381A227CC01386C651C3A5AE7EE2234BD2A958EFDAE81716';
  /** A check of 0.001 EVR cashed in 26399329. */
  const TOKEN_CHECK = '789B10B1CB6CC875D569AC6FF17B4AB7F60EBA180305665AB6AC5FF4A321139E';
  const DHA = { currency: 'DHA', issuer: 'rDyz9rX7eGJRdVDC8NGxMxqh9U14qduqzS' };

  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: 'xahau-objects', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });

  it('serves a Xahau issued-token channel in token amounts', async () => {
    const body = (await api.ok(`/v2/payment_channels/${TOKEN_CHANNEL}`, 'payment_channel')).body as Obj;
    expect(Object.keys(body)).toEqual(DETAIL_BODY_KEYS.payment_channel.filter((k) => k !== 'history_marker'));
    // Xahau starts its features at its first ledger, and the creation of this channel is indexed
    expect(body.coverage).toEqual({ from_ledger_index: FIRST, complete: true });
    expect([body.ledger_index, body.close_time]).toEqual([HEAD, iso(1_791_550_172)]);
    expectKeysInOrder(body.payment_channel as Obj, PAYMENT_CHANNEL_KEYS);
    expect(body.payment_channel).toEqual({
      channel_id: TOKEN_CHANNEL,
      account: 'rL6rwNe6puyoN5X1BUy8pEQb6Un23m2f1m',
      sequence: 777_987_460,
      destination: 'rLggTEwmTe3eJgyQbCSk4wQazow2TeKrtR',
      amount: { ...DHA, value: '1' },
      balance: { ...DHA, value: '0.023506' },
      remaining: { ...DHA, value: '0.976494' },
      settle_delay: 1_209_600,
      public_key: 'ED3E65C66F452D4C5029F4B338213FC6691C43ED04FCBC5AB88850471C9979F425',
      status: 'open',
      opened_with: { ...DHA, value: '1' },
      funds: 0,
      claims: 1,
      created: {
        ledger_index: 11_056_548,
        time: iso(1_735_850_951),
        tx_hash: '658229F6A67A15A316105775DF582A3211B519874CADF899623D121735FE30CC',
      },
    });
    const events = body.history as Obj[];
    for (const event of events) expectKeysInOrder(event, CHANNEL_EVENT_KEYS);
    // the first claim: the previous balance is a token amount of zero, and the change is in the token
    expect(events[0]).toMatchObject({
      event: 'claim',
      ledger_index: 11_083_603,
      account: 'rLggTEwmTe3eJgyQbCSk4wQazow2TeKrtR',
      amount: { ...DHA, value: '1' },
      balance: { ...DHA, value: '0.023506' },
      balance_change: { ...DHA, value: '0.023506' },
    });
    // the creation's node has a Balance of zero tokens
    expect(events[1]).toMatchObject({
      event: 'create',
      amount: { ...DHA, value: '1' },
      balance: { ...DHA, value: '0' },
      settle_delay: 1_209_600,
    });
    // and the CSV flattens the token amounts
    const csv = await api.get(`/v2/payment_channels/${TOKEN_CHANNEL}/history?format=csv`);
    const header = EVENT_CSV_COLUMNS.payment_channel.map((c) => `"${c}"`);
    const table = lines(csv.text).map(cells);
    expect(table[0]).toEqual(header);
    expect(table[2][header.indexOf('"balance_change.currency"')]).toBe('"DHA"');
    expect(table[2][header.indexOf('"balance_change.issuer"')]).toBe(`"${DHA.issuer}"`);
    expect(table[2][header.indexOf('"balance_change.value"')]).toBe('"0.023506"');
  });

  it('serves a Xahau XAH channel, whose created node has a Balance of "0", and its checks in XAH and in a token', async () => {
    const xah = (await api.ok(`/v2/payment_channels/${XAH_CHANNEL}`, 'payment_channel')).body as Obj;
    expect(xah.payment_channel).toMatchObject({
      amount: { currency: 'XAH', value: '0.3' },
      balance: { currency: 'XAH', value: '0.015838' },
      remaining: { currency: 'XAH', value: '0.284162' },
      opened_with: { currency: 'XAH', value: '0.3' },
      funds: 0,
      claims: 1,
    });
    expect((xah.history as Obj[]).map((e) => [e.event, e.balance])).toEqual([
      ['claim', { currency: 'XAH', value: '0.015838' }],
      ['create', { currency: 'XAH', value: '0' }],
    ]);
    expect((xah.history as Obj[])[0].balance_change).toEqual({ currency: 'XAH', value: '0.015838' });

    // a check cashed with a DeliverMin: the cash delivered what the metadata says
    const check = (await api.ok(`/v2/checks/${XAH_CHECK}`, 'check')).body as Obj;
    expect(check.coverage).toEqual({ from_ledger_index: FIRST, complete: true });
    expectKeysInOrder(check.check as Obj, CHECK_KEYS);
    expect(check.check).toMatchObject({
      send_max: { currency: 'XAH', value: '1' },
      delivered: { currency: 'XAH', value: '1' },
      status: 'cashed',
      created: { ledger_index: 12_064_511 },
      removed: { ledger_index: 12_064_524, tx_type: 'CheckCash' },
    });
    expect((check.history as Obj[]).map((e) => e.event)).toEqual(['cash', 'create']);
    // a token check whose creation is older than the index
    const token = (await api.ok(`/v2/checks/${TOKEN_CHECK}`, 'check')).body as Obj;
    expect(token.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
    expect(token.check).toMatchObject({
      send_max: { currency: 'EVR', issuer: 'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8', value: '0.001' },
      delivered: { currency: 'EVR', issuer: 'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8', value: '0.001' },
      status: 'cashed',
    });
  });
});
