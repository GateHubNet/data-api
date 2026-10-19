import {
  ClickHouseService,
  getNetworkProfile,
  NodeClient,
  runMigrations,
  Table,
  ValidatorValidationsRow,
} from '@gatehub/data-api-shared';
import { EventEmitter, once } from 'node:events';
import { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { SyncerConfig } from '../src/config/syncer.config';
import { ValidationsCollector } from '../src/validations/validations-collector';

/**
 * The validations collector against a real ClickHouse (testcontainers):
 *  - what the unit specs cannot show: how `validations` (an AggregatingMergeTree of SimpleAggregateFunction columns) reads
 *    the rows the collector writes. Partial sightings of one validation are separate rows until a merge; summed with
 *    `GROUP BY` they are one, and after `OPTIMIZE ... FINAL` the table itself says the same;
 *  - the whole path, with real `NodeClient`s against websocket servers that talk like rippled: subscribe, `server_info`,
 *    the stream messages, the `manifest` RPC.
 */

const QUIET = { log: () => undefined, warn: () => undefined, error: () => undefined };
/** The node clients of the collector, as the collector makes them, without their log lines. */
const quietClient = (endpoint: string): NodeClient => new NodeClient({ endpoints: [endpoint], logger: QUIET });
const NO_FLUSH_TIMER = 3_600_000;
const REPORTER = 'n9KJb7NMxGySRcjCqh69xEPMUhwJx22qntYYXsnUqYgjsJhNoW7g';
const SIGNING = 'n9MzwWa4dwdZkRzj6XmihBG4ymGtMPd12cLjfhKwx5Hoqeu6WEgy';
const MASTER = 'nHUkp7WhouVMobBUKGrV5FNqjsdD9zKP5jpGnnLLnYxUQSGAwrZ6';
const SIGNING_2 = 'n9LbDLg9F7ExZCeMw1QZqsd1Ejs9uYpwd8bPUStF5hBJdd6B5aWj';
const MASTER_2 = 'nHUnhRJK3csknycNK5SXRFi8jvDp3sKoWvS9wKWLq1ATBBGgPBjp';

/**
 * Yesterday (UTC), the day the sightings of these tests are seen on: `validations` expires its rows 90 days after their
 * last datetime (TTL) and ClickHouse drops an expired row as it is written, so a fixed date would stop working one day.
 */
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

/** A hash that no other test uses: `n` as 64 hex digits. */
const hash = (n: number): string => n.toString(16).toUpperCase().padStart(64, '0');

/** Polls `probe` until it holds; a test waits for what it is waiting for, not for a time. */
async function waitFor(what: string, probe: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForAsync(what: string, probe: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Every feed of the collector has asked its node who it is (`server_info`) and has the answer. */
const reportersKnown = (collector: ValidationsCollector, feeds: number): Promise<void> =>
  waitFor(
    `the reporters of ${feeds} feed(s)`,
    () => collector.reporters.length === feeds && collector.reporters.every((reporter) => reporter !== undefined),
  );

function validation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'validationReceived',
    amendments: ['42426C4D4F1009EE67080A9B7965B44656D7714D104A72F9B4369F97ABF044EE'],
    base_fee: 10,
    flags: 2147483649,
    full: true,
    ledger_hash: hash(1),
    ledger_index: '46087342',
    load_fee: 256000,
    master_key: MASTER,
    reserve_base: 10000000,
    reserve_inc: 2000000,
    signature: '304402207D80F93D',
    signing_time: 606933920,
    validation_public_key: SIGNING,
    ...overrides,
  };
}

interface Grouped {
  validation_public_key: string;
  count: number;
  first: string;
  last: string;
  reporter: string;
  ephemeral: string;
}

describe('ValidationsCollector (e2e)', () => {
  let clickhouse: StartedClickHouse;
  let ch: ClickHouseService;

  beforeAll(async () => {
    clickhouse = await startClickHouse();
    const config = { ...clickhouse.config, database: 'validations_e2e' };
    await runMigrations({ config, log: () => undefined });
    ch = new ClickHouseService(config);
  });

  afterAll(async () => {
    await ch?.onModuleDestroy();
    await clickhouse?.container.stop();
  });

  const config = (endpoints: string) => ({ validationEndpoints: endpoints }) as SyncerConfig;
  const collectorFor = (
    endpoints = 'ws://127.0.0.1:1',
    network: 'xrpl' | 'xahau' = 'xrpl',
    clickhouse: ClickHouseService = ch,
  ) =>
    new ValidationsCollector(config(endpoints), getNetworkProfile(network), clickhouse, undefined, undefined, {
      logger: QUIET,
      flushIntervalMs: NO_FLUSH_TIMER,
      makeClient: quietClient,
    });

  /** What the API reads: the partial rows of one ledger summed per validator. */
  const grouped = (ledgerHash: string): Promise<Grouped[]> =>
    ch.query<Grouped>(
      `SELECT validation_public_key, sum(count) AS count,
              toString(min(first_datetime)) AS first, toString(max(last_datetime)) AS last,
              argMin(reporter_public_key, first_datetime) AS reporter,
              argMin(ephemeral_public_key, first_datetime) AS ephemeral
         FROM ${Table.Validations}
        WHERE ledger_hash = {h:String}
        GROUP BY ledger_hash, validation_public_key
        ORDER BY validation_public_key`,
      { h: ledgerHash },
    );
  const rawRows = (ledgerHash: string): Promise<{ count: number; part: string }[]> =>
    ch.query(
      `SELECT count, _part AS part FROM ${Table.Validations} WHERE ledger_hash = {h:String} ORDER BY first_datetime`,
      {
        h: ledgerHash,
      },
    );

  describe('rows in the table', () => {
    it('flush is idempotent across two flushes: the counts of the partial rows add up', async () => {
      const h = hash(100);
      const collector = collectorFor();
      const at = (ms: number) => new Date(Date.parse(`${YESTERDAY}T12:00:00.000Z`) + ms);

      for (const ms of [123, 456, 789]) collector.handleValidation(validation({ ledger_hash: h }), REPORTER, at(ms));
      expect(await collector.flush()).toBe(1);
      expect(await collector.flush()).toBe(0); // nothing new: not written again
      for (const ms of [20_100, 20_200]) {
        collector.handleValidation(validation({ ledger_hash: h }), REPORTER, at(ms));
      }
      expect(await collector.flush()).toBe(1);

      // two parts: the sightings of two flushes are two rows until the table merges them ...
      const raw = await rawRows(h);
      expect(raw.map((r) => Number(r.count))).toEqual([3, 2]);
      // ... and one validation, with the sum of their counts, when read the way the API reads
      expect(await grouped(h)).toEqual([
        {
          validation_public_key: MASTER,
          count: 5,
          first: `${YESTERDAY} 12:00:00.123`,
          last: `${YESTERDAY} 12:00:20.200`,
          reporter: REPORTER,
          ephemeral: SIGNING,
        },
      ]);

      // a merge gives the same answer: sum of counts, earliest first, latest last
      await ch.command(`OPTIMIZE TABLE ${Table.Validations} FINAL`);
      const merged = await ch.query<{ count: number; first: string; last: string; n: number }>(
        `SELECT count, toString(first_datetime) AS first, toString(last_datetime) AS last, count() OVER () AS n
           FROM ${Table.Validations} WHERE ledger_hash = {h:String}`,
        { h },
      );
      expect(merged).toEqual([
        { count: 5, first: `${YESTERDAY} 12:00:00.123`, last: `${YESTERDAY} 12:00:20.200`, n: 1 },
      ]);
      await collector.stop();
    });

    it('keeps the fractional seconds exactly, in a day partition of its own', async () => {
      const h = hash(101);
      const collector = collectorFor();
      collector.handleValidation(validation({ ledger_hash: h }), REPORTER, new Date('2031-05-06T23:59:59.999Z'));
      collector.handleValidation(
        validation({ ledger_hash: h, master_key: MASTER_2, validation_public_key: SIGNING_2 }),
        REPORTER,
        new Date('2031-05-07T00:00:00.001Z'),
      );
      await collector.flush();
      const rows = await ch.query<{ key: string; first: string; partition: string }>(
        `SELECT validation_public_key AS key, toString(first_datetime) AS first, _partition_id AS partition
           FROM ${Table.Validations} WHERE ledger_hash = {h:String} ORDER BY validation_public_key`,
        { h },
      );
      expect(rows).toEqual([
        { key: MASTER, first: '2031-05-06 23:59:59.999', partition: '20310506' },
        { key: MASTER_2, first: '2031-05-07 00:00:00.001', partition: '20310507' },
      ]);
      await collector.stop();
    });

    it('stores every field of a message, and reads the fee fields back as exact digits and NULLs', async () => {
      const h = hash(102);
      const collector = collectorFor();
      collector.handleValidation(
        validation({ ledger_hash: h, base_fee: '9007199254740993', load_fee: undefined, reserve_inc: 0, full: false }),
        REPORTER,
        new Date(`${YESTERDAY}T12:00:00.000Z`),
      );
      await collector.flush();
      const [row] = await ch.query<Record<string, unknown>>(
        `SELECT ledger_index, reporter_public_key, ephemeral_public_key, signature, signing_time, flags, full, amendments,
                toString(base_fee) AS base_fee, load_fee, toString(reserve_base) AS reserve_base, toString(reserve_inc) AS reserve_inc
           FROM ${Table.Validations} WHERE ledger_hash = {h:String}`,
        { h },
      );
      expect(row).toEqual({
        ledger_index: 46087342,
        reporter_public_key: REPORTER,
        ephemeral_public_key: SIGNING,
        signature: '304402207D80F93D',
        signing_time: 606933920,
        flags: 2147483649,
        full: 0,
        amendments: JSON.stringify(['42426C4D4F1009EE67080A9B7965B44656D7714D104A72F9B4369F97ABF044EE']),
        base_fee: '9007199254740993',
        load_fee: null,
        reserve_base: '10000000',
        reserve_inc: '0',
      });
      await collector.stop();
    });

    it('writes a batch of rows ClickHouse would take from nothing else: odd fields are defaults, not errors', async () => {
      const h = hash(103);
      const collector = collectorFor();
      collector.handleValidation(
        validation({ ledger_hash: h, ledger_index: 'x', flags: -1, signing_time: 2 ** 40, signature: undefined }),
        REPORTER,
        new Date(`${YESTERDAY}T12:00:00.000Z`),
      );
      expect(await collector.flush()).toBe(1);
      const [row] = await ch.query<Record<string, unknown>>(
        `SELECT ledger_index, flags, signing_time, signature FROM ${Table.Validations} WHERE ledger_hash = {h:String}`,
        { h },
      );
      expect(row).toEqual({ ledger_index: 0, flags: 0, signing_time: 0, signature: '' });
      await collector.stop();
    });

    it('is read in the order of the validators, whatever the order the sightings came in', async () => {
      const h = hash(104);
      const collector = collectorFor();
      const keys = [MASTER_2, MASTER, 'nHUon2tpyJEHHYGmxqeGu37cvPYHzrMtUNQFVdCgGNvEkjmCpTqK'];
      keys.forEach((key, i) =>
        collector.handleValidation(
          validation({ ledger_hash: h, master_key: key, validation_public_key: `n9${i}` }),
          REPORTER,
          new Date(Date.parse(`${YESTERDAY}T12:00:00Z`) + i),
        ),
      );
      await collector.flush();
      expect((await grouped(h)).map((r) => r.validation_public_key)).toEqual([...keys].sort());
      await collector.stop();
    });
  });

  describe('validator_manifests', () => {
    it('keeps the highest seq per ephemeral key, and a restarted collector maps through them', async () => {
      const collector = collectorFor();
      const a = 'n9ManifestKeyA11111111111111111111111111111111111111';
      const b = 'n9ManifestKeyB11111111111111111111111111111111111111';
      collector.handleManifest({ master_key: MASTER, signing_key: a, seq: 3 });
      collector.handleManifest({ master_key: MASTER_2, signing_key: b, seq: 1 });
      await collector.flush();
      collector.handleManifest({ master_key: MASTER, signing_key: a, seq: 2 }); // older: ignored
      collector.handleManifest({ master_key: 'nHUsomeoneElse', signing_key: a, seq: 9 });
      await collector.flush();

      await ch.command(`OPTIMIZE TABLE ${Table.ValidatorManifests} FINAL`);
      const stored = await ch.query<{ ephemeral_key: string; master_key: string; seq: number }>(
        `SELECT ephemeral_key, master_key, seq FROM ${Table.ValidatorManifests}
          WHERE ephemeral_key IN ({a:String}, {b:String}) ORDER BY ephemeral_key`,
        { a, b },
      );
      expect(stored).toEqual([
        { ephemeral_key: a, master_key: 'nHUsomeoneElse', seq: 9 },
        { ephemeral_key: b, master_key: MASTER_2, seq: 1 },
      ]);
      await collector.stop();

      // the next process reads them at start and needs no RPC to know the master key
      const h = hash(110);
      const idle = Object.assign(new EventEmitter(), {
        subscribe: async () => undefined,
        start: async () => new Promise<void>(() => undefined), // never connects: only the manifests are read here
        stop: async () => undefined,
      });
      const restarted = new ValidationsCollector(
        config('ws://127.0.0.1:1'),
        getNetworkProfile('xrpl'),
        ch,
        undefined,
        undefined,
        { logger: QUIET, flushIntervalMs: NO_FLUSH_TIMER, makeClient: () => idle as unknown as NodeClient },
      );
      restarted.onApplicationBootstrap();
      // the manifests are read before the feeds start: the feed is the sign that they are loaded
      await waitFor('the feed to start', () => idle.listenerCount('validationReceived') === 1);
      restarted.handleValidation(
        validation({ ledger_hash: h, master_key: undefined, validation_public_key: b }),
        REPORTER,
        new Date(`${YESTERDAY}T12:00:00Z`),
      );
      await restarted.flush();
      expect((await grouped(h)).map((r) => r.validation_public_key)).toEqual([MASTER_2]);
      await restarted.stop();
    });
  });

  describe('server_version and the per-validator tables', () => {
    const VERSION = '1745992596280311808'; // 0x183B..., more than 2^53: it must not pass through a JS number
    const at = (ms: number) => new Date(Date.parse(`${YESTERDAY}T12:00:00.000Z`) + ms);
    /** A key of its own for a test: the three tables are shared by the whole file. */
    const key = (prefix: string, name: string) => `${prefix}E2e${name}`.padEnd(52, '1');
    const sumCount = async (master: string, ledgerHash: string): Promise<number> => {
      const [row] = await ch.query<{ n: number }>(
        `SELECT sum(count) AS n FROM ${Table.ValidatorValidations}
          WHERE validation_public_key = {m:String} AND ledger_hash = {h:String}`,
        { m: master, h: ledgerHash },
      );
      return Number(row?.n ?? 0);
    };

    it('writes the four tables of a flush, and reads server_version back exactly', async () => {
      const master = key('nH', 'FourTablesMaster');
      const signing = key('n9', 'FourTablesSigning');
      const [h1, h2] = [hash(300), hash(301)];
      const collector = collectorFor();
      collector.handleManifest({
        master_key: master,
        signing_key: signing,
        seq: 7,
        domain: 'e2e.example.com',
        manifest: '24000000077121ed1f2e',
      });
      const msg = (overrides: Record<string, unknown>) =>
        validation({ master_key: master, validation_public_key: signing, ...overrides });
      collector.handleValidation(
        msg({ ledger_hash: h1, ledger_index: '300', server_version: VERSION }),
        REPORTER,
        at(100),
      );
      // the same validation seen by another node a little earlier: one row of two sightings
      collector.handleValidation(
        msg({ ledger_hash: h1, ledger_index: '300', server_version: VERSION }),
        'n9Other',
        at(40),
      );
      collector.handleValidation(msg({ ledger_hash: h2, ledger_index: '302', full: false }), REPORTER, at(900));
      expect(await collector.flush()).toBe(2);

      expect(
        await ch.query(
          `SELECT domain, manifest, source FROM ${Table.ValidatorManifests} WHERE ephemeral_key = {e:String}`,
          { e: signing },
        ),
      ).toEqual([{ domain: 'e2e.example.com', manifest: '24000000077121ED1F2E', source: 'stream' }]);

      // validations: the version as exact digits, NULL where the message had none
      expect(
        await ch.query(
          `SELECT ledger_hash, toString(server_version) AS server_version FROM ${Table.Validations}
            WHERE validation_public_key = {m:String} ORDER BY ledger_hash`,
          { m: master },
        ),
      ).toEqual([
        { ledger_hash: h1, server_version: VERSION },
        { ledger_hash: h2, server_version: null },
      ]);

      // validator_validations: the same two validations, narrow
      const byValidator = await ch.query(
        `SELECT ledger_index, ledger_hash, sum(count) AS count, toString(min(first_datetime)) AS first,
                toString(max(last_datetime)) AS last, any(ephemeral_public_key) AS ephemeral, max(full) AS full,
                any(signing_time) AS signing_time, toString(any(server_version)) AS server_version
           FROM ${Table.ValidatorValidations} WHERE validation_public_key = {m:String}
          GROUP BY ledger_index, ledger_hash ORDER BY ledger_index`,
        { m: master },
      );
      expect(byValidator).toEqual([
        {
          ledger_index: 300,
          ledger_hash: h1,
          count: 2,
          first: `${YESTERDAY} 12:00:00.040`,
          last: `${YESTERDAY} 12:00:00.100`,
          ephemeral: signing,
          full: 1,
          signing_time: 606933920,
          server_version: VERSION,
        },
        {
          ledger_index: 302,
          ledger_hash: h2,
          count: 1,
          first: `${YESTERDAY} 12:00:00.900`,
          last: `${YESTERDAY} 12:00:00.900`,
          ephemeral: signing,
          full: 0,
          signing_time: 606933920,
          server_version: null,
        },
      ]);

      // validator_seen: one row for the master key
      expect(
        await ch.query(
          `SELECT toString(min(first_seen)) AS first, toString(max(last_seen)) AS last, max(last_ledger_index) AS ledger,
                  count() AS rows
             FROM ${Table.ValidatorSeen} WHERE validation_public_key = {m:String}`,
          { m: master },
        ),
      ).toEqual([{ first: `${YESTERDAY} 12:00:00.040`, last: `${YESTERDAY} 12:00:00.900`, ledger: 302, rows: 1 }]);
      await collector.stop();
    });

    it('adds up the batches of several flushes: counts sum, the first time stays, the last moves on', async () => {
      const master = key('nH', 'TwoFlushesMaster');
      const signing = key('n9', 'TwoFlushesSigning');
      const h = hash(310);
      const collector = collectorFor();
      const see = (ms: number, ledger: string, ledgerHash = h) =>
        collector.handleValidation(
          validation({
            ledger_hash: ledgerHash,
            ledger_index: ledger,
            master_key: master,
            validation_public_key: signing,
          }),
          REPORTER,
          at(ms),
        );
      see(100, '310');
      see(200, '310');
      await collector.flush();
      see(20_100, '310');
      await collector.flush();
      see(40_000, '311', hash(311)); // another ledger of the same validator
      await collector.flush();

      expect(await sumCount(master, h)).toBe(3);
      const [seen] = await ch.query(
        `SELECT toString(min(first_seen)) AS first, toString(max(last_seen)) AS last, max(last_ledger_index) AS ledger
           FROM ${Table.ValidatorSeen} WHERE validation_public_key = {m:String}`,
        { m: master },
      );
      expect(seen).toEqual({ first: `${YESTERDAY} 12:00:00.100`, last: `${YESTERDAY} 12:00:40.000`, ledger: 311 });
      await collector.stop();
    });

    it('a replay of a batch with its token adds nothing', async () => {
      const master = key('nH', 'ReplayMaster');
      const signing = key('n9', 'ReplaySigning');
      const h = hash(320);
      // a ClickHouse whose first answer to each per-validator insert is lost: the rows are in, the collector is told not
      const lose = new Set<string>([Table.ValidatorValidations, Table.ValidatorSeen]);
      const attempts: [string, string | undefined][] = [];
      const flaky = {
        insert: async (table: string, rows: unknown[], opts?: { dedupToken?: string }) => {
          attempts.push([table, opts?.dedupToken]);
          await ch.insert(table, rows, opts);
          if (lose.delete(table)) throw new Error('socket hang up');
        },
        query: ch.query.bind(ch),
      } as unknown as ClickHouseService;
      const collector = collectorFor('ws://127.0.0.1:1', 'xrpl', flaky);
      const see = (ms: number) =>
        collector.handleValidation(
          validation({ ledger_hash: h, ledger_index: '320', master_key: master, validation_public_key: signing }),
          REPORTER,
          at(ms),
        );
      for (const ms of [100, 200, 300]) see(ms);
      await collector.flush(); // lands, but the collector does not know: both batches stay pending
      expect(await sumCount(master, h)).toBe(3);

      await collector.flush(); // the same batches, with the same tokens: the server drops them
      expect(await sumCount(master, h)).toBe(3); // not 6
      const rawSeen = () =>
        ch.query<{ rows: number }>(
          `SELECT count() AS rows FROM ${Table.ValidatorSeen} WHERE validation_public_key = {m:String}`,
          { m: master },
        );
      expect(await rawSeen()).toEqual([{ rows: 1 }]);
      // the second attempt of each batch carried the token of the first
      const tokens = (table: string) => attempts.filter(([t]) => t === table).map(([, token]) => token);
      for (const table of [Table.ValidatorValidations, Table.ValidatorSeen]) {
        const [first, second] = tokens(table);
        expect(first).toMatch(new RegExp(`^vc:[0-9a-f-]{36}:${table}:\\d+$`));
        expect(second).toBe(first);
      }

      // and a later batch has a token of its own, so it counts
      see(400);
      await collector.flush();
      expect(await sumCount(master, h)).toBe(4);
      await collector.stop();
    });

    it('drops a replayed token and counts a new one, in both tables', async () => {
      const master = key('nH', 'TokenMaster');
      const row: ValidatorValidationsRow = {
        validation_public_key: master,
        ledger_index: 330,
        ledger_hash: hash(330),
        count: 5,
        first_datetime: Date.parse(`${YESTERDAY}T12:00:00Z`) / 1000,
        last_datetime: Date.parse(`${YESTERDAY}T12:00:00Z`) / 1000,
        ephemeral_public_key: 'n9Token',
        signing_time: 1,
        full: 1,
        server_version: null,
      };
      await ch.insert(Table.ValidatorValidations, [row], { dedupToken: 'vc:e2e-token:validator_validations:1' });
      await ch.insert(Table.ValidatorValidations, [row], { dedupToken: 'vc:e2e-token:validator_validations:1' });
      expect(await sumCount(master, hash(330))).toBe(5);
      await ch.insert(Table.ValidatorValidations, [row], { dedupToken: 'vc:e2e-token:validator_validations:2' });
      expect(await sumCount(master, hash(330))).toBe(10);
    });
  });

  describe('with real node clients', () => {
    interface FakeNode {
      url: string;
      pubkey: string;
      server: WebSocketServer;
      subscribed: string[][];
      requests: Record<string, unknown>[];
      /** The `manifest` answers by public key (`manifest` is base64, as the node gives it). */
      manifests: Record<string, { master_key: string; seq: number; domain?: string; manifest?: string }>;
      sockets: Set<WebSocket>;
      push(message: Record<string, unknown>): void;
      stop(): Promise<void>;
    }

    /** A websocket server that answers like a rippled: `server_info`, `subscribe`, `manifest`; it can push stream messages. */
    async function startNode(pubkey: string, networkId?: number): Promise<FakeNode> {
      const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      await once(server, 'listening');
      const node: FakeNode = {
        url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
        pubkey,
        server,
        subscribed: [],
        requests: [],
        manifests: {},
        sockets: new Set(),
        push: (message) => {
          for (const socket of node.sockets) socket.send(JSON.stringify(message));
        },
        stop: () =>
          new Promise((resolve) => {
            for (const socket of server.clients) socket.terminate();
            server.close(() => resolve());
          }),
      };
      server.on('connection', (socket) => {
        node.sockets.add(socket);
        socket.on('close', () => node.sockets.delete(socket));
        socket.on('message', (raw) => {
          const request = JSON.parse(raw.toString()) as { id: number; command: string; [k: string]: unknown };
          node.requests.push(request);
          const respond = (result: object) =>
            socket.send(JSON.stringify({ id: request.id, type: 'response', status: 'success', result }));
          if (request.command === 'server_info') {
            respond({ info: { complete_ledgers: '1-100', pubkey_node: node.pubkey, network_id: networkId } });
          } else if (request.command === 'subscribe') {
            node.subscribed.push(request.streams as string[]);
            respond({});
          } else if (request.command === 'manifest') {
            const known = node.manifests[request.public_key as string];
            respond({
              requested: request.public_key,
              ...(known && {
                details: {
                  ephemeral_key: request.public_key,
                  master_key: known.master_key,
                  seq: known.seq,
                  ...(known.domain !== undefined && { domain: known.domain }),
                },
              }),
              ...(known?.manifest !== undefined && { manifest: known.manifest }),
            });
          } else {
            respond({});
          }
        });
      });
      return node;
    }

    it('subscribes to validations and manifests on every endpoint, and stamps each report with its node', async () => {
      const a = await startNode('n9NodeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      const b = await startNode('n9NodeBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
      const collector = collectorFor(`${a.url},${b.url}`);
      try {
        collector.onApplicationBootstrap();
        await waitFor('both nodes to be subscribed', () => a.subscribed.length > 0 && b.subscribed.length > 0);
        expect(a.subscribed).toEqual([['validations', 'manifests']]);
        expect(b.subscribed).toEqual([['validations', 'manifests']]);
        // the reporter is asked of server_info before anything is recorded
        await reportersKnown(collector, 2);

        const h = hash(200);
        /** Flushes until the table holds `n` reports of the given ledgers. */
        const reportsIn = (n: number, ...hashes: string[]) =>
          waitForAsync(`${n} reports`, async () => {
            await collector.flush();
            const [total] = await ch.query<{ n: number }>(
              `SELECT sum(count) AS n FROM ${Table.Validations} WHERE ledger_hash IN ({hashes:Array(String)})`,
              { hashes },
            );
            return Number(total.n) === n;
          });
        a.push(validation({ ledger_hash: h }));
        a.push(validation({ ledger_hash: h }));
        await reportsIn(2, h);
        b.push(validation({ ledger_hash: h })); // the same validation, reported by the other node
        b.push(validation({ ledger_hash: hash(201), master_key: MASTER_2, validation_public_key: SIGNING_2 }));
        await reportsIn(4, h, hash(201));

        const [row] = await grouped(h);
        expect(row).toMatchObject({ validation_public_key: MASTER, ephemeral: SIGNING, reporter: a.pubkey });
        expect(row.count).toBe(3);
        const [other] = await grouped(hash(201));
        expect(other).toMatchObject({ validation_public_key: MASTER_2, count: 1, reporter: b.pubkey });
      } finally {
        await collector.stop();
        await Promise.all([a.stop(), b.stop()]);
      }
    });

    it('maps an ephemeral key by a manifest of the stream, and by the manifest RPC when no manifest came', async () => {
      const node = await startNode(REPORTER);
      node.manifests[SIGNING_2] = {
        master_key: MASTER_2,
        seq: 12,
        domain: 'rpc.example.com',
        manifest: 'JAAAAAJxIe0fLg==', // 24000000027121ED1F2E
      };
      const collector = collectorFor(node.url);
      try {
        collector.onApplicationBootstrap();
        await waitFor('the subscription', () => node.subscribed.length > 0);
        await reportersKnown(collector, 1);

        const h = hash(210);
        // the messages of one connection arrive in order: the manifest is known when the validation behind it is handled
        node.push({
          type: 'manifestReceived',
          master_key: MASTER,
          seq: 5,
          signature: 'AA',
          signing_key: SIGNING,
          domain: 'stream.example.com',
          manifest: '24000000057121ed0a0b', // the stream gives hex
        });
        node.push(validation({ ledger_hash: h, master_key: undefined })); // mapped by the manifest of the stream
        node.push(validation({ ledger_hash: h, master_key: undefined, validation_public_key: SIGNING_2 })); // by the RPC
        node.push(validation({ ledger_hash: h, master_key: undefined, validation_public_key: 'n9Unknown' })); // by neither
        await waitFor('three validators', () => collector.bufferedRows === 3);
        await collector.flush();

        expect((await grouped(h)).map((r) => [r.validation_public_key, r.ephemeral, r.count])).toEqual(
          [
            [MASTER, SIGNING, 1],
            [MASTER_2, SIGNING_2, 1],
            ['n9Unknown', 'n9Unknown', 1],
          ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
        );
        expect(node.requests.filter((r) => r.command === 'manifest').map((r) => r.public_key)).toEqual([
          SIGNING_2,
          'n9Unknown',
        ]);
        expect(node.requests.find((r) => r.command === 'manifest')).not.toHaveProperty('api_version');

        // both manifests are in the table: the one of the stream and the one the RPC found
        const stored = await ch.query<{ ephemeral_key: string; master: string; highest: number }>(
          `SELECT ephemeral_key, argMax(master_key, seq) AS master, max(seq) AS highest
             FROM ${Table.ValidatorManifests} WHERE ephemeral_key IN ({a:String}, {b:String})
            GROUP BY ephemeral_key ORDER BY ephemeral_key`,
          { a: SIGNING, b: SIGNING_2 },
        );
        expect(stored.sort((x, y) => x.ephemeral_key.localeCompare(y.ephemeral_key))).toEqual(
          [
            { ephemeral_key: SIGNING, master: MASTER, highest: 5 },
            { ephemeral_key: SIGNING_2, master: MASTER_2, highest: 12 },
          ].sort((x, y) => x.ephemeral_key.localeCompare(y.ephemeral_key)),
        );

        // with the domain, the raw manifest as upper-case hex, and where each one came from
        const raw = await ch.query<Record<string, unknown>>(
          `SELECT ephemeral_key, argMax(domain, seq) AS domain, argMax(manifest, seq) AS manifest,
                  argMax(source, seq) AS source
             FROM ${Table.ValidatorManifests} WHERE ephemeral_key IN ({a:String}, {b:String})
            GROUP BY ephemeral_key ORDER BY ephemeral_key`,
          { a: SIGNING, b: SIGNING_2 },
        );
        expect(raw.sort((x, y) => String(x.ephemeral_key).localeCompare(String(y.ephemeral_key)))).toEqual(
          [
            {
              ephemeral_key: SIGNING,
              domain: 'stream.example.com',
              manifest: '24000000057121ED0A0B',
              source: 'stream',
            },
            {
              ephemeral_key: SIGNING_2,
              domain: 'rpc.example.com',
              manifest: '24000000027121ED1F2E',
              source: 'rpc',
            },
          ].sort((x, y) => x.ephemeral_key.localeCompare(y.ephemeral_key)),
        );
      } finally {
        await collector.stop();
        await node.stop();
      }
    });

    it('sends the subscription again on a new connection, and takes the reporter the node answers then', async () => {
      const node = await startNode('n9NodeBeforeReconnect');
      const collector = collectorFor(node.url);
      try {
        collector.onApplicationBootstrap();
        await waitFor('the subscription', () => node.subscribed.length === 1);
        await reportersKnown(collector, 1);
        expect(collector.reporters).toEqual(['n9NodeBeforeReconnect']);
        node.push(validation({ ledger_hash: hash(240) }));
        await waitFor('the validation', () => collector.bufferedRows === 1);
        await collector.flush();

        // the connection drops; the endpoint now answers as another server of the cluster
        node.pubkey = 'n9NodeAfterReconnect';
        for (const socket of node.server.clients) socket.terminate();
        await waitFor('the new reporter', () => collector.reporters[0] === 'n9NodeAfterReconnect', 30_000);
        expect(node.subscribed).toEqual([
          ['validations', 'manifests'],
          ['validations', 'manifests'],
        ]);
        expect(node.requests.filter((r) => r.command === 'server_info')).toHaveLength(2);

        node.push(validation({ ledger_hash: hash(241) }));
        await waitFor('the validation', () => collector.bufferedRows === 1);
        await collector.flush();
        expect((await grouped(hash(240))).map((r) => r.reporter)).toEqual(['n9NodeBeforeReconnect']);
        expect((await grouped(hash(241))).map((r) => r.reporter)).toEqual(['n9NodeAfterReconnect']);
      } finally {
        await collector.stop();
        await node.stop();
      }
    });

    it('follows a key rotation: the same master with a new signing key and a higher seq, both keys map to it', async () => {
      const node = await startNode(REPORTER);
      const old = 'n9RotationOldSigningKey1111111111111111111111111111';
      const next = 'n9RotationNewSigningKey2222222222222222222222222222';
      const collector = collectorFor(node.url);
      try {
        collector.onApplicationBootstrap();
        await waitFor('the subscription', () => node.subscribed.length > 0);
        await reportersKnown(collector, 1);

        node.push({ type: 'manifestReceived', master_key: MASTER, seq: 1, signature: 'AA', signing_key: old });
        node.push(validation({ ledger_hash: hash(250), master_key: undefined, validation_public_key: old }));
        node.push({ type: 'manifestReceived', master_key: MASTER, seq: 2, signature: 'AA', signing_key: next });
        node.push(validation({ ledger_hash: hash(251), master_key: undefined, validation_public_key: next }));
        // a straggler signed with the key that was rotated out is still the same validator
        node.push(validation({ ledger_hash: hash(252), master_key: undefined, validation_public_key: old }));
        await waitFor('three validations', () => collector.bufferedRows === 3);
        await collector.flush();

        expect((await grouped(hash(250))).map((r) => [r.validation_public_key, r.ephemeral])).toEqual([[MASTER, old]]);
        expect((await grouped(hash(251))).map((r) => [r.validation_public_key, r.ephemeral])).toEqual([[MASTER, next]]);
        expect((await grouped(hash(252))).map((r) => [r.validation_public_key, r.ephemeral])).toEqual([[MASTER, old]]);
        // the stream said all of it: the node was never asked
        expect(node.requests.filter((r) => r.command === 'manifest')).toEqual([]);

        // both manifests are in the table, each with its own seq
        const stored = await ch.query<{ ephemeral_key: string; master: string; highest: number }>(
          `SELECT ephemeral_key, argMax(master_key, seq) AS master, max(seq) AS highest
             FROM ${Table.ValidatorManifests} WHERE ephemeral_key IN ({old:String}, {next:String})
            GROUP BY ephemeral_key ORDER BY highest`,
          { old, next },
        );
        expect(stored).toEqual([
          { ephemeral_key: old, master: MASTER, highest: 1 },
          { ephemeral_key: next, master: MASTER, highest: 2 },
        ]);
      } finally {
        await collector.stop();
        await node.stop();
      }

      // a process that starts later reads both rows and maps both keys without asking anybody
      const idle = Object.assign(new EventEmitter(), {
        subscribe: async () => undefined,
        start: async () => new Promise<void>(() => undefined),
        stop: async () => undefined,
      });
      const restarted = new ValidationsCollector(
        config('ws://127.0.0.1:1'),
        getNetworkProfile('xrpl'),
        ch,
        undefined,
        undefined,
        { logger: QUIET, flushIntervalMs: NO_FLUSH_TIMER, makeClient: () => idle as unknown as NodeClient },
      );
      restarted.onApplicationBootstrap();
      await waitFor('the feed to start', () => idle.listenerCount('validationReceived') === 1);
      for (const [n, key] of [
        [260, old],
        [261, next],
      ] as const) {
        restarted.handleValidation(
          validation({ ledger_hash: hash(n), master_key: undefined, validation_public_key: key }),
          REPORTER,
          new Date(`${YESTERDAY}T12:00:00Z`),
        );
      }
      await restarted.flush();
      expect((await grouped(hash(260))).map((r) => r.validation_public_key)).toEqual([MASTER]);
      expect((await grouped(hash(261))).map((r) => r.validation_public_key)).toEqual([MASTER]);
      await restarted.stop();
    });

    it('refuses a node of the other network: it asks server_info, keeps no reporter for it and closes the connection', async () => {
      // What a refused node streams is kept out by the gate of its feed (`rejected`), which the unit tests drive
      // (validations-collector.spec.ts: 'refuses a node of another network: it is stopped and none of its messages is
      // recorded', 'is not believed from a node whose reporter is not known yet, or which was refused'). Here, against a
      // real connection, a message can only reach that gate in the moment between the refusal and the close, which no
      // test can hit reliably: pushing after the close (as this test did) asserted nothing (final review I3).
      const xahau = await startNode('n9XahauNode', 21337);
      const collector = collectorFor(xahau.url, 'xrpl');
      try {
        collector.onApplicationBootstrap();
        await waitFor('the subscription', () => xahau.subscribed.length > 0);
        await waitFor('server_info', () => xahau.requests.some((r) => r.command === 'server_info'));
        // refused: the collector stops the client, which closes the connection, and never knows a reporter for it
        await waitFor('the connection to be closed', () => xahau.sockets.size === 0);
        expect(collector.reporters).toEqual([undefined]);
        // and it does not come back: no reconnect within the time a reconnect would take
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(xahau.sockets.size).toBe(0);
        expect(xahau.requests.filter((r) => r.command === 'server_info')).toHaveLength(1);
      } finally {
        await collector.stop();
        await xahau.stop();
      }
    });

    it('works on Xahau unchanged', async () => {
      const xahau = await startNode('n9XahauNode', 21337);
      const collector = collectorFor(xahau.url, 'xahau');
      try {
        collector.onApplicationBootstrap();
        await waitFor('the subscription', () => xahau.subscribed.length > 0);
        await reportersKnown(collector, 1);
        xahau.push(validation({ ledger_hash: hash(221) }));
        await waitFor('the validation', () => collector.bufferedRows === 1);
        await collector.flush();
        expect((await grouped(hash(221))).map((r) => [r.validation_public_key, r.count, r.reporter])).toEqual([
          [MASTER, 1, 'n9XahauNode'],
        ]);
      } finally {
        await collector.stop();
        await xahau.stop();
      }
    });

    it('flushes what it has when it is stopped', async () => {
      const node = await startNode(REPORTER);
      const collector = collectorFor(node.url);
      try {
        collector.onApplicationBootstrap();
        await waitFor('the subscription', () => node.subscribed.length > 0);
        await reportersKnown(collector, 1);
        node.push(validation({ ledger_hash: hash(230) }));
        await waitFor('the validation', () => collector.bufferedRows === 1);
      } finally {
        await collector.stop(); // the final flush
        await node.stop();
      }
      expect((await grouped(hash(230))).map((r) => r.count)).toEqual([1]);
    });
  });
});
