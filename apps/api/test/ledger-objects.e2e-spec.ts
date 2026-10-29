import { amendmentId, escrowId, OBJECT_PARSER_VERSION, Table } from '@gatehub/data-api-shared';
import { classicAddressToXAddress } from 'ripple-address-codec';
import { COVERAGE_KEYS } from '../src/common/feature-coverage.service';
import {
  DETAIL_BODY_KEYS,
  ESCROW_KEYS,
  EVENT_CSV_COLUMNS,
  EVENT_EXTRA_KEYS,
  EVENT_KEYS,
  HISTORY_BODY_KEYS,
  OBJECT_REF_KEYS,
  REMOVED_KEYS,
} from '../src/ledger-objects/object-views';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { accountAt, cells, decodeMarker, hashOf, iso, lines } from './support/amm';
import { csvDisposition } from './support/csv';
import { COUNTERPARTY, insertObjects, jsonOf, objectRow, OWNER, seedObjects } from './support/objects';
import { markerOf } from './support/read-rows';
import { insertState, ledgerRow } from './support/validators-seed';

/**
 * `GET /v2/escrows/{id}`, `/v2/escrows/{id}/history` and `/v2/accounts/{address}/escrows/{sequence}` (D5, spec 5.3) on a real
 * ClickHouse: the recorded ledgers of the objects fixtures (`xrpl-objects`: escrows created, finished and cancelled;
 * `xahau-objects`: XAH and issued-token escrows), written by the ledger writer as the syncer writes them, and the escrows made
 * by hand (their transactions say `synthetic-…`) for what the recordings do not hold: a conditional escrow with a fulfillment,
 * an escrow created with a ticket, an escrow with 120 events to page through (a real escrow has two; the paging code reads the
 * rows of any object), a row written twice, and rows above the committed head.
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
