import {
  ClickHouseService,
  getNetworkProfile,
  NetworkName,
  NodeClient,
  ShutdownSignals,
  Table,
  ValidationsRow,
  ValidatorManifestsRow,
  ValidatorSeenRow,
  ValidatorValidationsRow,
} from '@gatehub/data-api-shared';
import { EventEmitter } from 'node:events';
import { SyncerConfig } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import {
  byValidatorRowFrom,
  MANIFEST_FAILURE_TTL_MS,
  MANIFEST_MISS_TTL_MS,
  MANIFEST_RPC_TIMEOUT_MS,
  MAX_BUFFERED_ROWS,
  mergeByValidatorRows,
  mergeSeenRows,
  REPORTER_RETRY_MS,
  seenRowFrom,
  validationRowFrom,
  VALIDATIONS_FLUSH_INTERVAL_MS,
  VALIDATIONS_LOOKUP_SHUTDOWN_WAIT_MS,
  VALIDATIONS_SHUTDOWN_WAIT_MS,
  ValidationsCollector,
  ValidationsCollectorOptions,
} from './validations-collector';

const HASH = '9373383605D0994AF33ACECA206693B331BA61C3CDA511AF3E7DD569593E126C';
const OTHER_HASH = 'E1D8E7B2FE7B8A15B7AE3B1D4F0B6C0A7E5B9C3D2A1F0E9D8C7B6A5F4E3D2C1B';
/** The key a validator signs validations with (rotates), and the master key it is known by. */
const SIGNING = 'n9MzwWa4dwdZkRzj6XmihBG4ymGtMPd12cLjfhKwx5Hoqeu6WEgy';
const MASTER = 'nHUkp7WhouVMobBUKGrV5FNqjsdD9zKP5jpGnnLLnYxUQSGAwrZ6';
const SIGNING_2 = 'n9LbDLg9F7ExZCeMw1QZqsd1Ejs9uYpwd8bPUStF5hBJdd6B5aWj';
const MASTER_2 = 'nHUnhRJK3csknycNK5SXRFi8jvDp3sKoWvS9wKWLq1ATBBGgPBjp';
const REPORTER = 'n9KJb7NMxGySRcjCqh69xEPMUhwJx22qntYYXsnUqYgjsJhNoW7g';
const AMENDMENT = '42426C4D4F1009EE67080A9B7965B44656D7714D104A72F9B4369F97ABF044EE';

const T0 = new Date('2026-10-16T12:00:00.123Z');
const T0_SECONDS = 1_792_152_000.123;

/** A `validationReceived` message as rippled sends it (`master_key` is there since rippled 1.5 when it knows the manifest). */
function validation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'validationReceived',
    amendments: [AMENDMENT],
    base_fee: 10,
    flags: 2147483649,
    full: true,
    ledger_hash: HASH,
    ledger_index: '46087342',
    load_fee: 256000,
    master_key: MASTER,
    reserve_base: 10000000,
    reserve_inc: 2000000,
    signature:
      '304402207D80F93D2C184D6ACBE543DF71586DE0326684ECC8F1CCC927899717C3F6F7CF022013105248E34F0A0DBDD1ED437F49CBBFB39BC65EC11E07F45A6CD1418F9B9244',
    signing_time: 606933920,
    validation_public_key: SIGNING,
    ...overrides,
  };
}

/** The same without a `master_key`: what a node that does not know the manifest (or an older one) sends. */
function bare(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { master_key: _master, ...rest } = validation(overrides);
  return rest;
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'manifestReceived',
    master_key: MASTER,
    seq: 4,
    signature: 'AA',
    signing_key: SIGNING,
    ...overrides,
  };
}

/** A `NodeClient` that does nothing but what the collector asks of it, and lets a test drive the stream. */
class FakeNode extends EventEmitter {
  readonly started = jest.fn();
  readonly subscribedBeforeStart: string[][] = [];
  begun = false;
  stopped = false;
  pubkey: string | undefined;
  networkId: number | undefined;
  /** What the `manifest` RPC answers, by requested key; no entry: a node that knows no manifest for it. */
  manifests: Record<
    string,
    {
      master_key: string;
      ephemeral_key?: string;
      seq: number;
      domain?: string;
      /** base64, at the top of the answer */ manifest?: string;
    }
  > = {};

  constructor(
    readonly endpoint: string,
    pubkey: string | undefined,
  ) {
    super();
    this.pubkey = pubkey;
  }

  subscribe = jest.fn(async (streams: string[]) => {
    this.subscribedBeforeStart.push(this.begun ? ['(after start)', ...streams] : streams);
  });
  start = jest.fn(async () => {
    this.begun = true;
    this.started();
    this.emit('connected', this.endpoint);
  });
  stop = jest.fn(async () => {
    this.stopped = true;
  });
  serverInfo = jest.fn(async () => ({
    complete_ledgers: '1-100',
    network_id: this.networkId,
    ...(this.pubkey !== undefined && { pubkey_node: this.pubkey }),
  }));
  request = jest.fn(async (req: Record<string, unknown>, _opts?: unknown): Promise<unknown> => {
    const key = String(req.public_key);
    const { manifest, ...details } = this.manifests[key] ?? {};
    return {
      requested: key,
      ...(this.manifests[key] && { details: { ephemeral_key: key, ...details } }),
      ...(manifest !== undefined && { manifest }),
    };
  });
}

interface Setup {
  collector: ValidationsCollector;
  nodes: FakeNode[];
  insert: jest.Mock;
  query: jest.Mock;
  metrics: Record<
    | 'validationsFlushedTotal'
    | 'validationsErrorsTotal'
    | 'validationsDroppedTotal'
    | 'validatorValidationsFlushedTotal',
    { inc: jest.Mock }
  >;
  signals: { register: jest.Mock };
  logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
}

function setup(
  options: {
    endpoints?: string;
    network?: NetworkName;
    stored?: { ephemeral_key: string; master: string; highest: number }[];
    collector?: ValidationsCollectorOptions;
    reporters?: (string | undefined)[];
    /** The `network_id` every fake node reports. */
    networkId?: number;
  } = {},
): Setup {
  const nodes: FakeNode[] = [];
  const insert = jest.fn(async (_table: Table | string, _rows: unknown[]): Promise<void> => undefined);
  const query = jest.fn(async (_sql: string, _params?: unknown): Promise<unknown[]> => options.stored ?? []);
  const metrics = {
    validationsFlushedTotal: { inc: jest.fn() },
    validationsErrorsTotal: { inc: jest.fn() },
    validationsDroppedTotal: { inc: jest.fn() },
    validatorValidationsFlushedTotal: { inc: jest.fn() },
  };
  const signals = { register: jest.fn() };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const collector = new ValidationsCollector(
    { validationEndpoints: options.endpoints ?? 'ws://node-a:6006' } as SyncerConfig,
    getNetworkProfile(options.network ?? 'xrpl'),
    { insert, query } as unknown as ClickHouseService,
    metrics as unknown as PrometheusService,
    signals as unknown as ShutdownSignals,
    {
      logger,
      makeClient: (endpoint) => {
        const index = nodes.length;
        const reporters = options.reporters;
        const node = new FakeNode(
          endpoint,
          reporters ? reporters[index] : index === 0 ? REPORTER : `${REPORTER.slice(0, -1)}${index}`,
        );
        node.networkId = options.networkId;
        nodes.push(node);
        return node as unknown as NodeClient;
      },
      ...options.collector,
    },
  );
  return { collector, nodes, insert, query, metrics, signals, logger };
}

/** Starts the collector and lets the connect, the `server_info` and the manifest load finish. */
async function boot(s: Setup): Promise<void> {
  s.collector.onApplicationBootstrap();
  await jest.advanceTimersByTimeAsync(0);
}

const written = (s: Setup): ValidationsRow[] =>
  s.insert.mock.calls.filter(([table]) => table === Table.Validations).flatMap(([, rows]) => rows as ValidationsRow[]);
/** The rows of the last insert into `validations`, failed or not. */
const lastInsert = (s: Setup): ValidationsRow[] =>
  s.insert.mock.calls.filter(([table]) => table === Table.Validations).at(-1)![1] as ValidationsRow[];
/** What a manifest row of the stream gets when the message names no domain and carries no raw manifest. */
const STREAM_ONLY = { domain: '', manifest: '', source: 'stream' } as const;
const writtenManifests = (s: Setup): ValidatorManifestsRow[] =>
  s.insert.mock.calls
    .filter(([table]) => table === Table.ValidatorManifests)
    .flatMap(([, rows]) => rows as ValidatorManifestsRow[]);
/** The calls `insert(table, rows, opts)` made into one table, in order, failed ones too. */
const insertsInto = (s: Setup, table: Table) =>
  s.insert.mock.calls
    .filter(([t]) => t === table)
    .map(([, rows, opts]) => ({
      rows: rows as unknown[],
      token: (opts as { dedupToken?: string } | undefined)?.dedupToken,
    }));
const writtenByValidator = (s: Setup): ValidatorValidationsRow[] =>
  insertsInto(s, Table.ValidatorValidations).flatMap((call) => call.rows as ValidatorValidationsRow[]);
const writtenSeen = (s: Setup): ValidatorSeenRow[] =>
  insertsInto(s, Table.ValidatorSeen).flatMap((call) => call.rows as ValidatorSeenRow[]);
/** The tables the collector inserted into, in order. */
const tablesWritten = (s: Setup): string[] => s.insert.mock.calls.map(([table]) => String(table));
/** Makes every insert into `table` fail (until `mockImplementation` is set again); the others succeed. */
const failInto = (s: Setup, table: Table, message = 'ClickHouse is down') =>
  s.insert.mockImplementation(async (t: Table | string) => {
    if (t === table) throw new Error(message);
  });
/** The `buffer_full` drops counted so far, over all tables. */
const bufferFullDrops = (s: Setup): number =>
  s.metrics.validationsDroppedTotal.inc.mock.calls
    .filter(([labels]) => (labels as { reason: string }).reason === 'buffer_full')
    .reduce((sum, [, n]) => sum + (typeof n === 'number' ? n : 1), 0);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ValidationsCollector', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('handleValidation(): merging in memory', () => {
    it('two reports of same validation merge count=2', async () => {
      const s = setup();
      s.collector.handleValidation(validation(), REPORTER, new Date('2026-10-16T12:00:00.123Z'));
      s.collector.handleValidation(validation(), REPORTER, new Date('2026-10-16T12:00:00.456Z'));
      expect(s.collector.bufferedRows).toBe(1);

      expect(await s.collector.flush()).toBe(1);
      expect(written(s)).toEqual([
        {
          ledger_hash: HASH,
          validation_public_key: MASTER,
          count: 2,
          first_datetime: 1_792_152_000.123,
          last_datetime: 1_792_152_000.456,
          ledger_index: 46087342,
          reporter_public_key: REPORTER,
          ephemeral_public_key: SIGNING,
          signature: expect.stringMatching(/^304402207D80/),
          signing_time: 606933920,
          flags: 2147483649,
          full: 1,
          amendments: JSON.stringify([AMENDMENT]),
          base_fee: '10',
          load_fee: '256000',
          reserve_base: '10000000',
          reserve_inc: '2000000',
          server_version: null,
        },
      ]);
    });

    it('keeps the first and the last time as unix seconds with a fraction, whatever the order they arrive in', () => {
      const s = setup();
      s.collector.handleValidation(validation(), REPORTER, new Date('2026-10-16T12:00:05.007Z'));
      s.collector.handleValidation(validation(), REPORTER, new Date('2026-10-16T12:00:01.500Z'));
      s.collector.handleValidation(validation(), REPORTER, new Date('2026-10-16T12:00:03.250Z'));
      return s.collector.flush().then(() => {
        const [row] = written(s);
        expect(row.count).toBe(3);
        expect(row.first_datetime).toBe(1_792_152_001.5);
        expect(row.last_datetime).toBe(1_792_152_005.007);
        // a DateTime64(3) column reads a number as seconds: a millisecond integer would be read 1000 times too far on
        expect(row.first_datetime).toBeLessThan(1e10);
        expect(Number.isInteger(row.last_datetime)).toBe(false);
      });
    });

    it('keeps validators, and ledgers, apart: one row per (ledger_hash, validation_public_key)', async () => {
      const s = setup();
      s.collector.handleValidation(validation(), REPORTER, T0);
      s.collector.handleValidation(
        validation({ master_key: MASTER_2, validation_public_key: SIGNING_2 }),
        REPORTER,
        T0,
      );
      s.collector.handleValidation(validation({ ledger_hash: OTHER_HASH }), REPORTER, T0);
      expect(s.collector.bufferedRows).toBe(3);
      await s.collector.flush();
      expect(
        written(s)
          .map((r) => [r.ledger_hash, r.validation_public_key, r.count])
          .sort(),
      ).toEqual(
        [
          [HASH, MASTER, 1],
          [HASH, MASTER_2, 1],
          [OTHER_HASH, MASTER, 1],
        ].sort(),
      );
    });

    it('merges the reports of different nodes of the same validation, and keeps the other fields of the first one', async () => {
      const s = setup();
      s.collector.handleValidation(validation(), 'n9ReporterA', T0);
      s.collector.handleValidation(
        validation({ signature: 'FFFF', signing_time: 1, flags: 1, full: false }),
        'n9ReporterB',
        new Date(T0.getTime() + 10),
      );
      await s.collector.flush();
      const [row] = written(s);
      expect(row).toMatchObject({
        count: 2,
        reporter_public_key: 'n9ReporterA',
        flags: 2147483649,
        full: 1,
        signing_time: 606933920,
      });
      expect(row.signature).not.toBe('FFFF');
    });

    it('upper-cases the ledger hash, so that rows are found by the hash the API normalizes to', async () => {
      const s = setup();
      s.collector.handleValidation(validation({ ledger_hash: HASH.toLowerCase() }), REPORTER, T0);
      s.collector.handleValidation(validation(), REPORTER, T0);
      expect(s.collector.bufferedRows).toBe(1);
      await s.collector.flush();
      expect(written(s)[0].ledger_hash).toBe(HASH);
      expect(written(s)[0].count).toBe(2);
    });

    it('does not mutate the message', () => {
      const s = setup();
      const msg = validation();
      const copy = JSON.parse(JSON.stringify(msg));
      s.collector.handleValidation(msg, REPORTER, T0);
      expect(msg).toEqual(copy);
    });
  });

  describe('validationRowFrom(): the row of one message', () => {
    const row = (msg: Record<string, unknown>) =>
      validationRowFrom(msg, REPORTER, T0.getTime() / 1000, MASTER, SIGNING);

    it('reads ledger_index as a string or a number, and a partial validation as full 0', () => {
      expect(row(validation({ ledger_index: '46087342', full: false }))).toMatchObject({
        ledger_index: 46087342,
        full: 0,
      });
      expect(row(validation({ ledger_index: 46087342 }))).toMatchObject({ ledger_index: 46087342, full: 1 });
      expect(row(validation({ full: 'true' }))).toMatchObject({ full: 1 });
      expect(row(validation({ full: undefined }))).toMatchObject({ full: 0 });
    });

    it('stores the amendments as JSON text, and none as an empty string', () => {
      expect(row(validation({ amendments: [AMENDMENT, 'AA'] }))?.amendments).toBe(JSON.stringify([AMENDMENT, 'AA']));
      expect(row(validation({ amendments: [] }))?.amendments).toBe('');
      expect(row(validation({ amendments: undefined }))?.amendments).toBe('');
      expect(row(validation({ amendments: 'nope' }))?.amendments).toBe('');
    });

    it('stores the fee fields as exact digits, and leaves out what the node did not send (or sent badly)', () => {
      expect(row(validation({ base_fee: '9007199254740993', load_fee: '256000', reserve_base: 0 }))).toMatchObject({
        base_fee: '9007199254740993',
        load_fee: '256000',
        reserve_base: '0',
      });
      const missing = row(validation({ base_fee: undefined, load_fee: null, reserve_base: 'x', reserve_inc: -5 }));
      expect(missing).toMatchObject({ base_fee: null, load_fee: null, reserve_base: null, reserve_inc: null });
    });

    it('keeps every number inside its column: a bad value is a default, never a row ClickHouse would refuse', () => {
      expect(row(validation({ flags: 'x', signing_time: -1, ledger_index: 2 ** 40 }))).toMatchObject({
        flags: 0,
        signing_time: 0,
        ledger_index: 0,
      });
      expect(row(validation({ signature: undefined }))?.signature).toBe('');
    });

    it('writes server_version as exact digits, and null when the message has none', () => {
      expect(row(validation({ server_version: '1745992596280311808' }))?.server_version).toBe('1745992596280311808');
      expect(row(validation({ server_version: '18446744073709551615' }))?.server_version).toBe('18446744073709551615');
      expect(row(validation({ server_version: 42 }))?.server_version).toBe('42');
      expect(row(validation())?.server_version).toBeNull();
      expect(row(validation({ server_version: undefined }))?.server_version).toBeNull();
      // a value that is no UInt64 is no version: never a row ClickHouse would refuse
      for (const odd of ['x', '', -1, '18446744073709551616', 1.5, null, {}, ['1']]) {
        expect([odd, row(validation({ server_version: odd }))?.server_version]).toEqual([odd, null]);
      }
    });

    it('is undefined for a ledger hash that is not 64 hex digits', () => {
      expect(validationRowFrom(validation({ ledger_hash: 'zz' }), REPORTER, 1, MASTER, SIGNING)).toBeUndefined();
      expect(
        validationRowFrom(validation({ ledger_hash: HASH.slice(2) }), REPORTER, 1, MASTER, SIGNING),
      ).toBeUndefined();
      expect(validationRowFrom(validation({ ledger_hash: undefined }), REPORTER, 1, MASTER, SIGNING)).toBeUndefined();
    });
  });

  describe('handleValidation(): messages that are not validations', () => {
    it('drops them, counted by reason, and never throws', async () => {
      const s = setup();
      for (const bad of [
        {},
        null,
        undefined,
        'validation',
        validation({ validation_public_key: undefined }),
        validation({ validation_public_key: '' }),
        validation({ ledger_hash: 'zzzz' }),
        validation({ ledger_hash: undefined }),
      ]) {
        expect(() => s.collector.handleValidation(bad as Record<string, unknown>, REPORTER, T0)).not.toThrow();
      }
      expect(s.collector.bufferedRows).toBe(0);
      expect(s.metrics.validationsDroppedTotal.inc).toHaveBeenCalledTimes(8);
      expect(s.metrics.validationsDroppedTotal.inc).toHaveBeenCalledWith({ reason: 'invalid' });
      expect(await s.collector.flush()).toBe(0);
      expect(s.insert).not.toHaveBeenCalled();
    });
  });

  describe('master keys', () => {
    it('uses the master_key of the message, and the signing key as ephemeral_public_key', async () => {
      const s = setup();
      s.collector.handleValidation(validation(), REPORTER, T0);
      await s.collector.flush();
      expect(written(s)[0]).toMatchObject({ validation_public_key: MASTER, ephemeral_public_key: SIGNING });
    });

    it('ephemeral key mapped via manifest', async () => {
      const s = setup();
      await boot(s);
      s.nodes[0].emit('manifestReceived', manifest());
      s.nodes[0].emit('validationReceived', bare());
      await s.collector.flush();

      expect(written(s)).toHaveLength(1);
      expect(written(s)[0]).toMatchObject({
        validation_public_key: MASTER,
        ephemeral_public_key: SIGNING,
        reporter_public_key: REPORTER,
        count: 1,
      });
      // no RPC was needed
      expect(s.nodes[0].request).not.toHaveBeenCalled();
      await s.collector.stop();
    });

    it('maps through the manifests stored in validator_manifests, loaded at start (the highest seq per key)', async () => {
      const s = setup({ stored: [{ ephemeral_key: SIGNING, master: MASTER, highest: 7 }] });
      await boot(s);
      expect(s.query).toHaveBeenCalledTimes(1);
      expect(String(s.query.mock.calls[0][0])).toMatch(/FROM validator_manifests/);
      expect(String(s.query.mock.calls[0][0])).toMatch(/argMax\(master_key, seq\)/);
      expect(String(s.query.mock.calls[0][0])).not.toMatch(/\bFINAL\b/);

      s.nodes[0].emit('validationReceived', bare());
      await s.collector.flush();
      expect(written(s)[0].validation_public_key).toBe(MASTER);
      expect(s.nodes[0].request).not.toHaveBeenCalled();
      await s.collector.stop();
    });

    it('goes on without the stored manifests when they cannot be read (the RPC covers a miss), and says so', async () => {
      const s = setup();
      s.query.mockRejectedValueOnce(new Error('ClickHouse is down'));
      await boot(s);
      expect(s.logger.error).toHaveBeenCalledWith(expect.stringContaining('ClickHouse is down'));
      expect(s.metrics.validationsErrorsTotal.inc).toHaveBeenCalledWith({ stage: 'manifests_load' });
      expect(s.nodes).toHaveLength(1); // the feeds started anyway
      await s.collector.stop();
    });

    it('lets the master_key of a message win over the manifest map, and learns it for the messages without one', async () => {
      const s = setup();
      await boot(s);
      s.nodes[0].emit('manifestReceived', manifest({ master_key: MASTER_2, seq: 1 }));
      s.nodes[0].emit('validationReceived', validation()); // says MASTER for SIGNING
      s.nodes[0].emit('validationReceived', bare()); // now known as MASTER
      await s.collector.flush();
      expect(written(s).map((r) => [r.validation_public_key, r.count])).toEqual([[MASTER, 2]]);
      expect(s.nodes[0].request).not.toHaveBeenCalled();
      await s.collector.stop();
    });

    it('asks the node for the manifest on a miss, and records the validation under the master key it answers', async () => {
      const s = setup();
      await boot(s);
      s.nodes[0].manifests[SIGNING] = { master_key: MASTER, seq: 9 };
      s.nodes[0].emit('validationReceived', bare());
      await jest.advanceTimersByTimeAsync(0);

      expect(s.nodes[0].request).toHaveBeenCalledTimes(1);
      expect(s.nodes[0].request).toHaveBeenCalledWith(
        { command: 'manifest', public_key: SIGNING },
        { timeoutMs: MANIFEST_RPC_TIMEOUT_MS, retries: 0 },
      );
      await s.collector.flush();
      expect(written(s)[0]).toMatchObject({ validation_public_key: MASTER, ephemeral_public_key: SIGNING });
      // what the node said is kept for the next start, as the node's own answer
      expect(writtenManifests(s)).toEqual([
        { ephemeral_key: SIGNING, master_key: MASTER, seq: 9, domain: '', manifest: '', source: 'rpc' },
      ]);

      // and is known now
      s.nodes[0].emit('validationReceived', bare());
      await s.collector.flush();
      expect(s.nodes[0].request).toHaveBeenCalledTimes(1);
      await s.collector.stop();
    });

    it('asks once for a key while the answer is on its way, and records every validation that waited', async () => {
      const s = setup();
      await boot(s);
      const answer = deferred<unknown>();
      s.nodes[0].request.mockReturnValueOnce(answer.promise);
      s.nodes[0].emit('validationReceived', bare());
      s.nodes[0].emit('validationReceived', bare());
      s.nodes[0].emit('validationReceived', bare());
      expect(s.nodes[0].request).toHaveBeenCalledTimes(1);
      expect(s.collector.bufferedRows).toBe(0); // waiting for the master key: not recorded under the wrong one

      answer.resolve({ details: { master_key: MASTER, ephemeral_key: SIGNING, seq: 1 } });
      await jest.advanceTimersByTimeAsync(0);
      await s.collector.flush();
      expect(written(s).map((r) => [r.validation_public_key, r.count])).toEqual([[MASTER, 3]]);
      await s.collector.stop();
    });

    it('does not ask again for a validator without a manifest until the negative answer expires', async () => {
      const s = setup();
      await boot(s);
      for (let i = 0; i < 5; i += 1) s.nodes[0].emit('validationReceived', bare());
      await jest.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 5; i += 1) s.nodes[0].emit('validationReceived', bare());
      await jest.advanceTimersByTimeAsync(0);

      expect(s.nodes[0].request).toHaveBeenCalledTimes(1); // not one RPC per validation
      await s.collector.flush();
      // the signing key is the identity of a validator that has no manifest
      expect(written(s).map((r) => [r.validation_public_key, r.ephemeral_public_key, r.count])).toEqual([
        [SIGNING, SIGNING, 10],
      ]);

      await jest.advanceTimersByTimeAsync(MANIFEST_MISS_TTL_MS - 1_000);
      s.nodes[0].emit('validationReceived', bare());
      await jest.advanceTimersByTimeAsync(0);
      expect(s.nodes[0].request).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1_000);
      s.nodes[0].manifests[SIGNING] = { master_key: MASTER, seq: 2 }; // the validator published a manifest meanwhile
      s.nodes[0].emit('validationReceived', bare());
      await jest.advanceTimersByTimeAsync(0);
      expect(s.nodes[0].request).toHaveBeenCalledTimes(2);
      await s.collector.flush();
      expect(
        written(s)
          .slice(1)
          .map((r) => r.validation_public_key),
      ).toEqual([SIGNING, MASTER]);
      await s.collector.stop();
    });

    it('honours a manifest of the stream that came in while the node was being asked, when the node knows nothing', async () => {
      const s = setup();
      await boot(s);
      const answer = deferred<unknown>();
      s.nodes[0].request.mockReturnValueOnce(answer.promise);
      s.nodes[0].emit('validationReceived', bare());
      s.nodes[0].emit('manifestReceived', manifest({ seq: 3 })); // SIGNING belongs to MASTER, says the stream
      answer.resolve({ requested: SIGNING }); // and the node, asked a moment ago, has nothing
      await jest.advanceTimersByTimeAsync(0);
      await s.collector.flush();
      expect(written(s).map((r) => [r.validation_public_key, r.count])).toEqual([[MASTER, 1]]);

      // the same when the request failed
      const failing = deferred<unknown>();
      s.nodes[0].request.mockReturnValueOnce(failing.promise);
      s.nodes[0].emit('validationReceived', bare({ validation_public_key: SIGNING_2, ledger_hash: OTHER_HASH }));
      s.nodes[0].emit('manifestReceived', manifest({ signing_key: SIGNING_2, master_key: MASTER_2, seq: 1 }));
      failing.reject(new Error('No node connection within 2000 ms'));
      await jest.advanceTimersByTimeAsync(0);
      await s.collector.flush();
      expect(lastInsert(s).map((r) => [r.validation_public_key, r.ephemeral_public_key])).toEqual([
        [MASTER_2, SIGNING_2],
      ]);
      await s.collector.stop();
    });

    it('treats a master key that is the signing key itself as no manifest', async () => {
      const s = setup();
      await boot(s);
      s.nodes[0].manifests[SIGNING] = { master_key: SIGNING, seq: 0 };
      s.nodes[0].emit('validationReceived', bare());
      s.nodes[0].emit('validationReceived', bare());
      await jest.advanceTimersByTimeAsync(0);
      await s.collector.flush();
      expect(s.nodes[0].request).toHaveBeenCalledTimes(1);
      expect(written(s).map((r) => [r.validation_public_key, r.count])).toEqual([[SIGNING, 2]]);
      expect(writtenManifests(s)).toEqual([]);
      await s.collector.stop();
    });

    it('falls back to the signing key when the RPC fails, counts and logs it, and tries again after a short while', async () => {
      const s = setup();
      await boot(s);
      s.nodes[0].request.mockRejectedValueOnce(new Error('No node connection within 2000 ms'));
      s.nodes[0].emit('validationReceived', bare());
      await jest.advanceTimersByTimeAsync(0);
      expect(s.metrics.validationsErrorsTotal.inc).toHaveBeenCalledWith({ stage: 'manifest_rpc' });
      expect(s.logger.error).toHaveBeenCalledWith(expect.stringContaining('No node connection within 2000 ms'));

      s.nodes[0].emit('validationReceived', bare()); // inside the back-off: no new RPC
      await jest.advanceTimersByTimeAsync(0);
      expect(s.nodes[0].request).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(MANIFEST_FAILURE_TTL_MS);
      s.nodes[0].manifests[SIGNING] = { master_key: MASTER, seq: 1 };
      s.nodes[0].emit('validationReceived', bare());
      await jest.advanceTimersByTimeAsync(0);
      expect(s.nodes[0].request).toHaveBeenCalledTimes(2);
      await s.collector.flush();
      expect(
        written(s)
          .map((r) => [r.validation_public_key, r.count])
          .sort(),
      ).toEqual(
        [
          [MASTER, 1],
          [SIGNING, 2],
        ].sort(),
      );
      await s.collector.stop();
    });

    it('treats an error answer of the node (a RippledError) as no manifest, and counts nothing as a fault', async () => {
      const s = setup();
      await boot(s);
      s.nodes[0].request.mockRejectedValueOnce(Object.assign(new Error('invalidParams'), { name: 'RippledError' }));
      s.nodes[0].emit('validationReceived', bare());
      await jest.advanceTimersByTimeAsync(0);
      s.nodes[0].emit('validationReceived', bare());
      await jest.advanceTimersByTimeAsync(0);
      expect(s.nodes[0].request).toHaveBeenCalledTimes(1); // cached as a miss for the long time
      expect(s.metrics.validationsErrorsTotal.inc).not.toHaveBeenCalled();
      await s.collector.stop();
    });
  });

  describe('manifestReceived', () => {
    it('upserts the manifest into validator_manifests with the next flush', async () => {
      const s = setup();
      await boot(s);
      s.nodes[0].emit('manifestReceived', manifest({ seq: 4 }));
      expect(s.insert).not.toHaveBeenCalled();
      await s.collector.flush();
      expect(writtenManifests(s)).toEqual([{ ephemeral_key: SIGNING, master_key: MASTER, seq: 4, ...STREAM_ONLY }]);
      await s.collector.stop();
    });

    it('keeps the domain and the raw manifest of a stream manifest, the manifest as upper-case hex', async () => {
      const s = setup();
      await boot(s);
      s.nodes[0].emit(
        'manifestReceived',
        manifest({ seq: 4, domain: 'example.com', manifest: '24000000027121ed1f2e' }),
      );
      await s.collector.flush();
      expect(writtenManifests(s)).toEqual([
        {
          ephemeral_key: SIGNING,
          master_key: MASTER,
          seq: 4,
          domain: 'example.com',
          manifest: '24000000027121ED1F2E',
          source: 'stream',
        },
      ]);
      await s.collector.stop();
    });

    it('keeps no domain for a manifest that names none, and no manifest that is not hex', async () => {
      const s = setup();
      await boot(s);
      s.nodes[0].emit('manifestReceived', manifest({ seq: 1, domain: '', manifest: 'not hex!' }));
      s.nodes[0].emit(
        'manifestReceived',
        manifest({ signing_key: SIGNING_2, master_key: MASTER_2, seq: 2, domain: 7 }),
      );
      await s.collector.flush();
      expect(writtenManifests(s)).toEqual([
        { ephemeral_key: SIGNING, master_key: MASTER, seq: 1, ...STREAM_ONLY },
        { ephemeral_key: SIGNING_2, master_key: MASTER_2, seq: 2, ...STREAM_ONLY },
      ]);
      await s.collector.stop();
    });

    it('keeps them from the manifest RPC, base64 to hex', async () => {
      const s = setup();
      await boot(s);
      s.nodes[0].manifests[SIGNING] = {
        master_key: MASTER,
        seq: 9,
        domain: 'example.com',
        manifest: 'JAAAAAJxIe0fLg==', // 24000000027121ED1F2E
      };
      s.nodes[0].emit('validationReceived', bare());
      await jest.advanceTimersByTimeAsync(0);
      await s.collector.flush();
      expect(writtenManifests(s)).toEqual([
        {
          ephemeral_key: SIGNING,
          master_key: MASTER,
          seq: 9,
          domain: 'example.com',
          manifest: '24000000027121ED1F2E',
          source: 'rpc',
        },
      ]);

      // an answer whose manifest is no base64 keeps the rest of it
      s.nodes[0].manifests[SIGNING_2] = { master_key: MASTER_2, seq: 3, manifest: '***' };
      s.nodes[0].emit('validationReceived', bare({ validation_public_key: SIGNING_2, ledger_hash: OTHER_HASH }));
      await jest.advanceTimersByTimeAsync(0);
      await s.collector.flush();
      expect(writtenManifests(s).at(-1)).toEqual({
        ephemeral_key: SIGNING_2,
        master_key: MASTER_2,
        seq: 3,
        domain: '',
        manifest: '',
        source: 'rpc',
      });
      await s.collector.stop();
    });

    it('writes a manifest again only when its seq is higher (the table keeps the highest seq per key)', async () => {
      const s = setup();
      await boot(s);
      s.nodes[0].emit('manifestReceived', manifest({ seq: 4 }));
      await s.collector.flush();
      s.nodes[0].emit('manifestReceived', manifest({ seq: 4 }));
      s.nodes[0].emit('manifestReceived', manifest({ seq: 3 }));
      await s.collector.flush();
      expect(writtenManifests(s)).toHaveLength(1);

      s.nodes[0].emit('manifestReceived', manifest({ seq: 5 }));
      s.nodes[0].emit('manifestReceived', manifest({ seq: 6 }));
      await s.collector.flush();
      expect(writtenManifests(s)).toEqual([
        { ephemeral_key: SIGNING, master_key: MASTER, seq: 4, ...STREAM_ONLY },
        { ephemeral_key: SIGNING, master_key: MASTER, seq: 6, ...STREAM_ONLY }, // one row for the two that were pending
      ]);
      await s.collector.stop();
    });

    it('does not write the manifests it loaded at start back to the table', async () => {
      const s = setup({ stored: [{ ephemeral_key: SIGNING, master: MASTER, highest: 7 }] });
      await boot(s);
      s.nodes[0].emit('manifestReceived', manifest({ seq: 7 }));
      await s.collector.flush();
      expect(writtenManifests(s)).toEqual([]);
      s.nodes[0].emit('manifestReceived', manifest({ seq: 8 }));
      await s.collector.flush();
      expect(writtenManifests(s)).toEqual([{ ephemeral_key: SIGNING, master_key: MASTER, seq: 8, ...STREAM_ONLY }]);
      await s.collector.stop();
    });

    it('ignores a manifest without a signing key (a revocation) or without a master key, a seq or a signature', async () => {
      const s = setup();
      await boot(s);
      for (const bad of [
        manifest({ signing_key: undefined, seq: 4294967295 }),
        manifest({ master_key: undefined }),
        manifest({ seq: undefined }),
        manifest({ seq: -1 }),
        manifest({ seq: 'x' }),
        {},
        null,
      ]) {
        s.nodes[0].emit('manifestReceived', bad);
      }
      await s.collector.flush();
      expect(writtenManifests(s)).toEqual([]);
      s.nodes[0].emit('validationReceived', bare());
      await jest.advanceTimersByTimeAsync(0);
      expect(s.nodes[0].request).toHaveBeenCalledTimes(1); // the map learned nothing from them
      await s.collector.stop();
    });

    it('is not believed from a node whose reporter is not known yet, or which was refused', async () => {
      const s = setup();
      s.collector.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      // a new connection: who the node is has not been asked yet
      const slow = deferred<{ pubkey_node: string; complete_ledgers: string }>();
      s.nodes[0].serverInfo.mockReturnValueOnce(slow.promise as never);
      s.nodes[0].emit('connected', 'ws://node-a:6006');
      s.nodes[0].emit('manifestReceived', manifest({ seq: 4 }));
      expect(s.metrics.validationsDroppedTotal.inc).toHaveBeenCalledWith({ reason: 'manifest_no_reporter' });
      await s.collector.flush();
      expect(writtenManifests(s)).toEqual([]);

      slow.resolve({ pubkey_node: REPORTER, complete_ledgers: '1-2' });
      await jest.advanceTimersByTimeAsync(0);
      s.nodes[0].emit('manifestReceived', manifest({ seq: 4 })); // the same manifest, now from a node that is known
      await s.collector.flush();
      expect(writtenManifests(s)).toEqual([{ ephemeral_key: SIGNING, master_key: MASTER, seq: 4, ...STREAM_ONLY }]);
      await s.collector.stop();

      // a node of another network is not believed at all
      const refused = setup({ network: 'xrpl', networkId: 21337 });
      await boot(refused);
      refused.nodes[0].emit('manifestReceived', manifest({ seq: 9 }));
      await refused.collector.flush();
      expect(writtenManifests(refused)).toEqual([]);
      refused.nodes[0].emit('validationReceived', bare());
      expect(refused.collector.bufferedRows).toBe(0);
      expect(refused.nodes[0].request).not.toHaveBeenCalled(); // nothing it said was learned: no lookup either
      await refused.collector.stop();
    });

    it('puts a manifest back when its insert fails, and counts the error without failing the validations', async () => {
      const s = setup();
      await boot(s);
      s.nodes[0].emit('manifestReceived', manifest({ seq: 4 }));
      s.nodes[0].emit('validationReceived', validation());
      s.insert.mockImplementation(async (table: Table | string) => {
        if (table === Table.ValidatorManifests) throw new Error('manifests are refused');
      });
      expect(await s.collector.flush()).toBe(1); // the validations went in
      expect(s.metrics.validationsErrorsTotal.inc).toHaveBeenCalledWith({ stage: 'manifests_flush' });
      expect(s.logger.error).toHaveBeenCalledWith(expect.stringContaining('manifests are refused'));

      s.insert.mockImplementation(async () => undefined);
      await s.collector.flush();
      expect(writtenManifests(s)).toEqual([
        { ephemeral_key: SIGNING, master_key: MASTER, seq: 4, ...STREAM_ONLY }, // the failed attempt
        { ephemeral_key: SIGNING, master_key: MASTER, seq: 4, ...STREAM_ONLY }, // and the retry
      ]);
      await s.collector.stop();
    });
  });

  describe('flush()', () => {
    it('writes the buffer as AggregatingMergeTree rows and empties it', async () => {
      const s = setup();
      s.collector.handleValidation(validation(), REPORTER, T0);
      s.collector.handleValidation(
        validation({ master_key: MASTER_2, validation_public_key: SIGNING_2 }),
        REPORTER,
        T0,
      );
      expect(await s.collector.flush()).toBe(2);
      expect(insertsInto(s, Table.Validations)).toHaveLength(1);
      expect(s.insert.mock.calls[0][0]).toBe(Table.Validations);
      expect(s.collector.bufferedRows).toBe(0);
      expect(s.metrics.validationsFlushedTotal.inc).toHaveBeenCalledWith(2);
    });

    it('flush is idempotent across two flushes', async () => {
      const s = setup();
      s.collector.handleValidation(validation(), REPORTER, T0);
      expect(await s.collector.flush()).toBe(1);
      // nothing new: nothing is written again, into no table
      expect(await s.collector.flush()).toBe(0);
      expect(tablesWritten(s)).toEqual([Table.Validations, Table.ValidatorValidations, Table.ValidatorSeen]);

      // a new sighting of the same validation is a new partial row; the table adds them up
      s.collector.handleValidation(validation(), REPORTER, new Date(T0.getTime() + 20_000));
      expect(await s.collector.flush()).toBe(1);
      const rows = written(s);
      expect(rows.map((r) => r.count)).toEqual([1, 1]);
      expect(rows.reduce((sum, r) => sum + Number(r.count), 0)).toBe(2); // the sum of counts is preserved
      expect(rows[0].first_datetime).toBe(T0_SECONDS);
      expect(rows[1].first_datetime).toBe(T0_SECONDS + 20);
      expect(s.metrics.validationsFlushedTotal.inc).toHaveBeenCalledTimes(2);
    });

    it('flushes every 20 s on its own', async () => {
      const s = setup();
      await boot(s);
      s.nodes[0].emit('validationReceived', validation());
      await jest.advanceTimersByTimeAsync(VALIDATIONS_FLUSH_INTERVAL_MS - 1);
      expect(s.insert).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(written(s)).toHaveLength(1);

      s.nodes[0].emit('validationReceived', validation());
      await jest.advanceTimersByTimeAsync(VALIDATIONS_FLUSH_INTERVAL_MS);
      expect(written(s)).toHaveLength(2);
      expect(VALIDATIONS_FLUSH_INTERVAL_MS).toBe(20_000);
      await s.collector.stop();
    });

    it('uses the interval it is given', async () => {
      const s = setup({ collector: { flushIntervalMs: 1_000 } });
      await boot(s);
      s.nodes[0].emit('validationReceived', validation());
      await jest.advanceTimersByTimeAsync(1_000);
      expect(written(s)).toHaveLength(1);
      await s.collector.stop();
    });

    it('puts the rows back, merged with what came in meanwhile, when the insert fails, and writes them with the next flush', async () => {
      const s = setup();
      s.collector.handleValidation(validation(), REPORTER, new Date('2026-10-16T12:00:00.100Z'));
      s.collector.handleValidation(validation(), REPORTER, new Date('2026-10-16T12:00:01.200Z'));
      const failing = deferred<void>();
      s.insert.mockReturnValueOnce(failing.promise);

      const flushing = s.collector.flush();
      // while the insert is on its way the validation is seen again, and so is another one
      s.collector.handleValidation(validation(), 'n9Other', new Date('2026-10-16T12:00:02.300Z'));
      s.collector.handleValidation(
        validation({ ledger_hash: OTHER_HASH }),
        REPORTER,
        new Date('2026-10-16T12:00:02.400Z'),
      );
      failing.reject(new Error('Code: 210. Connection reset'));
      await expect(flushing).rejects.toThrow('Connection reset');

      expect(s.logger.error).toHaveBeenCalledWith(expect.stringContaining('Connection reset'));
      expect(s.metrics.validationsErrorsTotal.inc).toHaveBeenCalledWith({ stage: 'flush' });
      expect(s.metrics.validationsFlushedTotal.inc).not.toHaveBeenCalled();
      expect(s.collector.bufferedRows).toBe(2); // one row for HASH: the failed one merged with the new sighting

      expect(await s.collector.flush()).toBe(2);
      const rows = written(s).slice(-2);
      const merged = rows.find((r) => r.ledger_hash === HASH)!;
      expect(merged.count).toBe(3);
      expect(merged.first_datetime).toBe(1_792_152_000.1);
      expect(merged.last_datetime).toBe(1_792_152_002.3);
      expect(merged.reporter_public_key).toBe(REPORTER); // the first sighting's fields stay
      expect(rows.find((r) => r.ledger_hash === OTHER_HASH)!.count).toBe(1);
      expect(s.metrics.validationsFlushedTotal.inc).toHaveBeenCalledWith(2);
    });

    it('keeps a failing flush from ever losing rows: it fails the same way, and recovers, any number of times', async () => {
      const s = setup();
      s.collector.handleValidation(validation(), REPORTER, T0);
      s.insert.mockRejectedValue(new Error('ClickHouse is down'));
      for (let i = 0; i < 3; i += 1) {
        await expect(s.collector.flush()).rejects.toThrow('ClickHouse is down');
        s.collector.handleValidation(validation(), REPORTER, new Date(T0.getTime() + (i + 1) * 1_000));
      }
      s.insert.mockResolvedValue(undefined);
      expect(await s.collector.flush()).toBe(1);
      const [row] = lastInsert(s);
      expect(row.count).toBe(4);
      expect(row.last_datetime).toBe(T0_SECONDS + 3);
    });

    it('counts and logs a failure of the timer-driven flush and goes on with the next tick', async () => {
      const s = setup();
      await boot(s);
      s.insert.mockRejectedValueOnce(new Error('Code: 241. Memory limit exceeded'));
      s.nodes[0].emit('validationReceived', validation());
      await jest.advanceTimersByTimeAsync(VALIDATIONS_FLUSH_INTERVAL_MS);
      expect(s.logger.error).toHaveBeenCalledWith(expect.stringContaining('Memory limit exceeded'));
      expect(s.metrics.validationsErrorsTotal.inc).toHaveBeenCalledWith({ stage: 'flush' });
      expect(s.metrics.validationsErrorsTotal.inc).toHaveBeenCalledTimes(1);

      s.nodes[0].emit('validationReceived', validation());
      await jest.advanceTimersByTimeAsync(VALIDATIONS_FLUSH_INTERVAL_MS);
      expect(written(s).at(-1)?.count).toBe(2); // the rows of the failed flush, and the new one
      await s.collector.stop();
    });

    it('skips a tick while the previous flush is still running, and says so', async () => {
      const s = setup();
      await boot(s);
      const slow = deferred<void>();
      s.insert.mockReturnValueOnce(slow.promise);
      s.nodes[0].emit('validationReceived', validation());
      await jest.advanceTimersByTimeAsync(VALIDATIONS_FLUSH_INTERVAL_MS);
      expect(insertsInto(s, Table.Validations)).toHaveLength(1);

      s.nodes[0].emit('validationReceived', validation({ ledger_hash: OTHER_HASH }));
      await jest.advanceTimersByTimeAsync(VALIDATIONS_FLUSH_INTERVAL_MS);
      expect(insertsInto(s, Table.Validations)).toHaveLength(1);
      expect(s.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/previous flush is still running/i));

      slow.resolve();
      await jest.advanceTimersByTimeAsync(VALIDATIONS_FLUSH_INTERVAL_MS);
      expect(insertsInto(s, Table.Validations)).toHaveLength(2);
      expect(written(s).map((r) => r.ledger_hash)).toEqual([HASH, OTHER_HASH]);
      await s.collector.stop();
    });

    it('serializes explicit flushes: two at once never write the same row twice', async () => {
      const s = setup();
      s.collector.handleValidation(validation(), REPORTER, T0);
      const [a, b] = await Promise.all([s.collector.flush(), s.collector.flush()]);
      expect(a + b).toBe(1);
      expect(written(s)).toHaveLength(1);
    });
  });

  describe('the per-validator tables: validator_validations and validator_seen', () => {
    const at = (ms: number) => new Date(T0.getTime() + ms);
    /** `at(ms)` as the unix seconds the collector writes. */
    const sec = (ms: number) => (T0.getTime() + ms) / 1000;
    const BOOT_TOKEN = /^vc:([0-9a-f-]{36}):(validator_validations|validator_seen):(\d+)$/;
    /** The ledger hash `n` as 64 hex digits. */
    const hashOf = (n: number): string => n.toString(16).toUpperCase().padStart(64, '0');
    const hashesOf = (rows: unknown[]): string[] => (rows as ValidatorValidationsRow[]).map((r) => r.ledger_hash);

    describe('byValidatorRowFrom() and seenRowFrom()', () => {
      const sighting = (overrides: Record<string, unknown> = {}, time = T0_SECONDS): ValidationsRow =>
        validationRowFrom(validation(overrides), REPORTER, time, MASTER, SIGNING)!;

      it('takes the narrow row of one validator and ledger from a validations row', () => {
        const row = sighting({ server_version: '1745992596280311808' });
        expect(byValidatorRowFrom(row)).toEqual({
          validation_public_key: MASTER,
          ledger_index: 46087342,
          ledger_hash: HASH,
          count: 1,
          first_datetime: T0_SECONDS,
          last_datetime: T0_SECONDS,
          ephemeral_public_key: SIGNING,
          signing_time: 606933920,
          full: 1,
          server_version: '1745992596280311808',
        });
        expect(byValidatorRowFrom(sighting({ full: false })).server_version).toBeNull();
        expect(byValidatorRowFrom(sighting({ full: false })).full).toBe(0);
      });

      it('shares nothing with the row it was made from', () => {
        const row = sighting();
        const narrow = byValidatorRowFrom(row);
        narrow.count = 99;
        const seen = seenRowFrom(row);
        seen.last_ledger_index = 1;
        expect(row.count).toBe(1);
        expect(row.ledger_index).toBe(46087342);
      });

      it('takes the validator, its first and last time and its ledger from a validations row', () => {
        expect(seenRowFrom(sighting({}, 1_792_152_003.5))).toEqual({
          validation_public_key: MASTER,
          first_seen: 1_792_152_003.5,
          last_seen: 1_792_152_003.5,
          last_ledger_index: 46087342,
        });
      });

      it('merges sightings of one validator and ledger: count sum, first min, last max, full max, the rest of the first', () => {
        const first = byValidatorRowFrom(sighting({ full: false, signing_time: 5, server_version: '7' }, 1_000.25));
        const second = byValidatorRowFrom(sighting({ full: true, signing_time: 9 }, 999.5));
        const third = byValidatorRowFrom(sighting({ full: false, signing_time: 11 }, 1_002));
        const merged = mergeByValidatorRows(mergeByValidatorRows(first, second), third);
        expect(merged).toEqual({
          validation_public_key: MASTER,
          ledger_index: 46087342,
          ledger_hash: HASH,
          count: 3,
          first_datetime: 999.5,
          last_datetime: 1_002,
          ephemeral_public_key: SIGNING,
          signing_time: 5,
          full: 1,
          server_version: '7',
        });
      });

      it('merges sightings of one validator: first_seen min, last_seen max, last_ledger_index max', () => {
        const a = seenRowFrom(sighting({ ledger_index: '10' }, 50));
        const b = seenRowFrom(sighting({ ledger_index: '12' }, 10));
        const c = seenRowFrom(sighting({ ledger_index: '11' }, 90));
        expect(mergeSeenRows(mergeSeenRows(a, b), c)).toEqual({
          validation_public_key: MASTER,
          first_seen: 10,
          last_seen: 90,
          last_ledger_index: 12,
        });
      });
    });

    describe('what a flush writes', () => {
      it('writes the four tables in order', async () => {
        const s = setup();
        await boot(s);
        s.nodes[0].emit('manifestReceived', manifest({ seq: 4 }));
        s.nodes[0].emit('validationReceived', validation());
        await s.collector.flush();

        expect(tablesWritten(s)).toEqual([
          Table.ValidatorManifests,
          Table.Validations,
          Table.ValidatorValidations,
          Table.ValidatorSeen,
        ]);
        // only the two new tables carry an insert token; the first two are written as they always were
        expect(s.insert.mock.calls[0]).toHaveLength(2);
        expect(s.insert.mock.calls[1]).toHaveLength(2);
        expect(s.insert.mock.calls[2][2]).toEqual({ dedupToken: expect.stringMatching(BOOT_TOKEN) });
        expect(s.insert.mock.calls[3][2]).toEqual({ dedupToken: expect.stringMatching(BOOT_TOKEN) });
        expect(s.metrics.validatorValidationsFlushedTotal.inc).toHaveBeenCalledWith(
          { table: Table.ValidatorValidations },
          1,
        );
        expect(s.metrics.validatorValidationsFlushedTotal.inc).toHaveBeenCalledWith({ table: Table.ValidatorSeen }, 1);
        await s.collector.stop();
      });

      it('writes nothing into the per-validator tables when no validation was seen', async () => {
        const s = setup();
        await boot(s);
        s.nodes[0].emit('manifestReceived', manifest({ seq: 4 }));
        await s.collector.flush();
        expect(tablesWritten(s)).toEqual([Table.ValidatorManifests]);
        await s.collector.stop();
      });

      it('writes one validator_validations row per master, ledger and hash: counts add up, first min, last max, full max', async () => {
        const s = setup();
        s.collector.handleValidation(validation({ full: false, signing_time: 5, server_version: '7' }), 'n9A', at(100));
        s.collector.handleValidation(validation({ full: true, signing_time: 9 }), 'n9B', at(50));
        s.collector.handleValidation(validation({ ledger_hash: OTHER_HASH }), 'n9A', at(70));
        s.collector.handleValidation(
          validation({ master_key: MASTER_2, validation_public_key: SIGNING_2 }),
          'n9A',
          at(10),
        );
        await s.collector.flush();

        const base = { ledger_index: 46087342, ephemeral_public_key: SIGNING, signing_time: 5, server_version: null };
        expect(writtenByValidator(s)).toEqual([
          {
            ...base,
            validation_public_key: MASTER,
            ledger_hash: HASH,
            count: 2,
            first_datetime: sec(50),
            last_datetime: sec(100),
            signing_time: 5, // the other fields are those of the first sighting
            server_version: '7',
            full: 1,
          },
          {
            ...base,
            validation_public_key: MASTER,
            ledger_hash: OTHER_HASH,
            signing_time: 606933920,
            count: 1,
            first_datetime: sec(70),
            last_datetime: sec(70),
            full: 1,
          },
          {
            ...base,
            validation_public_key: MASTER_2,
            ledger_hash: HASH,
            ephemeral_public_key: SIGNING_2,
            signing_time: 606933920,
            count: 1,
            first_datetime: sec(10),
            last_datetime: sec(10),
            full: 1,
          },
        ]);
      });

      it('writes one validator_seen row per master: min first, max last, max ledger', async () => {
        const s = setup();
        s.collector.handleValidation(validation({ ledger_index: '10' }), REPORTER, at(5_000));
        s.collector.handleValidation(validation({ ledger_index: '12', ledger_hash: OTHER_HASH }), REPORTER, at(1_000));
        s.collector.handleValidation(validation({ ledger_index: '11', ledger_hash: hashOf(3) }), REPORTER, at(9_000));
        s.collector.handleValidation(
          validation({ master_key: MASTER_2, validation_public_key: SIGNING_2, ledger_index: '9' }),
          REPORTER,
          at(2_000),
        );
        await s.collector.flush();

        expect(writtenSeen(s)).toEqual([
          {
            validation_public_key: MASTER,
            first_seen: sec(1_000),
            last_seen: sec(9_000),
            last_ledger_index: 12,
          },
          {
            validation_public_key: MASTER_2,
            first_seen: sec(2_000),
            last_seen: sec(2_000),
            last_ledger_index: 9,
          },
        ]);
      });

      it('keys the rows by the master key, not by the signing key', async () => {
        const s = setup();
        await boot(s);
        s.nodes[0].emit('manifestReceived', manifest({ seq: 1 })); // SIGNING belongs to MASTER
        s.nodes[0].emit('validationReceived', bare());
        s.nodes[0].emit('validationReceived', validation({ validation_public_key: SIGNING_2, master_key: MASTER }));
        await s.collector.flush();
        expect(writtenSeen(s).map((r) => r.validation_public_key)).toEqual([MASTER]);
        // two signing keys of one validator are one validator: one row, of the first sighting's signing key
        expect(writtenByValidator(s).map((r) => [r.validation_public_key, r.ephemeral_public_key, r.count])).toEqual([
          [MASTER, SIGNING, 2],
        ]);
        await s.collector.stop();
      });

      it('writes the version it read into validations and validator_validations', async () => {
        const s = setup();
        s.collector.handleValidation(validation({ server_version: '1745992596280311808' }), REPORTER, T0);
        await s.collector.flush();
        expect(written(s)[0].server_version).toBe('1745992596280311808');
        expect(writtenByValidator(s)[0].server_version).toBe('1745992596280311808');
      });

      it('writes the rows of a flush once: the next flush has only what came after', async () => {
        const s = setup();
        s.collector.handleValidation(validation(), REPORTER, T0);
        await s.collector.flush();
        await s.collector.flush();
        s.collector.handleValidation(validation(), REPORTER, at(20_000));
        await s.collector.flush();
        expect(writtenByValidator(s).map((r) => r.count)).toEqual([1, 1]);
        expect(writtenSeen(s).map((r) => [r.first_seen, r.last_seen])).toEqual([
          [T0_SECONDS, T0_SECONDS],
          [sec(20_000), sec(20_000)],
        ]);
        const tokens = insertsInto(s, Table.ValidatorValidations).map((c) => c.token);
        expect(tokens).toHaveLength(2);
        expect(tokens[0]).not.toBe(tokens[1]); // two batches, two tokens
      });

      it('gives the tokens of one process the same boot id, a table name and one number per flush', async () => {
        const s = setup();
        s.collector.handleValidation(validation(), REPORTER, T0);
        await s.collector.flush();
        s.collector.handleValidation(validation({ ledger_hash: OTHER_HASH }), REPORTER, T0);
        await s.collector.flush();
        const tokens = [Table.ValidatorValidations, Table.ValidatorSeen].flatMap((table) =>
          insertsInto(s, table).map((c) => c.token as string),
        );
        const parsed = tokens.map((token) => BOOT_TOKEN.exec(token)!.slice(1));
        expect(new Set(parsed.map(([boot]) => boot)).size).toBe(1);
        expect(parsed.map(([, table, n]) => [table, n])).toEqual([
          ['validator_validations', '1'],
          ['validator_validations', '2'],
          ['validator_seen', '1'],
          ['validator_seen', '2'],
        ]);
        // another process has another boot id
        const other = setup();
        other.collector.handleValidation(validation(), REPORTER, T0);
        await other.collector.flush();
        expect(insertsInto(other, Table.ValidatorSeen)[0].token).not.toBe(insertsInto(s, Table.ValidatorSeen)[0].token);
      });
    });

    describe('a table that fails', () => {
      it('re-sends a failed validator_validations batch with its own token before the new one', async () => {
        const s = setup();
        s.collector.handleValidation(validation(), REPORTER, T0);
        failInto(s, Table.ValidatorValidations, 'Code: 210. Connection reset');
        expect(await s.collector.flush()).toBe(1); // the failure of this table does not fail the flush
        expect(s.metrics.validationsErrorsTotal.inc).toHaveBeenCalledTimes(1);
        expect(s.metrics.validationsErrorsTotal.inc).toHaveBeenCalledWith({ stage: 'flush_by_validator' });
        expect(s.logger.error).toHaveBeenCalledWith(expect.stringContaining('Connection reset'));
        expect(s.metrics.validatorValidationsFlushedTotal.inc).not.toHaveBeenCalledWith(
          { table: Table.ValidatorValidations },
          expect.anything(),
        );

        s.insert.mockImplementation(async () => undefined);
        s.collector.handleValidation(validation({ ledger_hash: OTHER_HASH }), REPORTER, at(20_000));
        await s.collector.flush();

        const calls = insertsInto(s, Table.ValidatorValidations);
        const boot = BOOT_TOKEN.exec(calls[0].token!)![1];
        expect(calls.map((c) => c.token)).toEqual([
          `vc:${boot}:validator_validations:1`, // the one that failed
          `vc:${boot}:validator_validations:1`, // sent again, first
          `vc:${boot}:validator_validations:2`, // and then the new one
        ]);
        expect(hashesOf(calls[1].rows)).toEqual([HASH]);
        expect(hashesOf(calls[2].rows)).toEqual([OTHER_HASH]);
        expect(
          s.metrics.validatorValidationsFlushedTotal.inc.mock.calls.filter(
            ([l]) => l.table === Table.ValidatorValidations,
          ),
        ).toEqual([
          [{ table: Table.ValidatorValidations }, 1],
          [{ table: Table.ValidatorValidations }, 1],
        ]);
      });

      it('re-sends a failed validator_seen batch the same way, counted as flush_seen', async () => {
        const s = setup();
        s.collector.handleValidation(validation(), REPORTER, T0);
        failInto(s, Table.ValidatorSeen);
        expect(await s.collector.flush()).toBe(1);
        expect(s.metrics.validationsErrorsTotal.inc).toHaveBeenCalledWith({ stage: 'flush_seen' });
        expect(s.metrics.validationsErrorsTotal.inc).toHaveBeenCalledTimes(1);

        s.insert.mockImplementation(async () => undefined);
        s.collector.handleValidation(
          validation({ ledger_index: '46087343', ledger_hash: OTHER_HASH }),
          REPORTER,
          at(20_000),
        );
        await s.collector.flush();
        const calls = insertsInto(s, Table.ValidatorSeen);
        expect(calls.map((c) => c.token!.replace(/^vc:[^:]+:/, ''))).toEqual([
          'validator_seen:1',
          'validator_seen:1',
          'validator_seen:2',
        ]);
        expect(calls[1].rows).toEqual(calls[0].rows);
        expect(calls[2].rows).toEqual([
          {
            validation_public_key: MASTER,
            first_seen: sec(20_000),
            last_seen: sec(20_000),
            last_ledger_index: 46087343,
          },
        ]);
      });

      it('sends the failed rows again unchanged: what is seen meanwhile goes into a batch of its own', async () => {
        const s = setup();
        const sent: string[] = [];
        s.insert.mockImplementation(async (table: Table | string, rows: unknown[]) => {
          if (table === Table.ValidatorValidations) {
            sent.push(JSON.stringify(rows));
            if (sent.length === 1) throw new Error('timed out');
          }
        });
        s.collector.handleValidation(validation(), REPORTER, T0);
        await s.collector.flush();
        // the same validation again, in the time the first batch is waiting
        s.collector.handleValidation(validation(), REPORTER, at(5_000));
        await s.collector.flush();

        expect(sent).toHaveLength(3);
        expect(sent[1]).toBe(sent[0]); // byte for byte what was sent the first time
        expect(JSON.parse(sent[0])[0]).toMatchObject({ count: 1, last_datetime: T0_SECONDS });
        expect(JSON.parse(sent[2])[0]).toMatchObject({ count: 1, first_datetime: sec(5_000) });
      });

      it('does not re-send a table that succeeded when another failed', async () => {
        const s = setup();
        s.collector.handleValidation(validation(), REPORTER, T0);
        failInto(s, Table.ValidatorValidations);
        await s.collector.flush();
        s.insert.mockImplementation(async () => undefined);
        s.collector.handleValidation(validation({ ledger_hash: OTHER_HASH }), REPORTER, at(20_000));
        await s.collector.flush();

        // validations and validator_seen: one insert per flush, each with the rows of that flush only
        expect(
          insertsInto(s, Table.Validations).map((c) => (c.rows as ValidationsRow[]).map((r) => r.ledger_hash)),
        ).toEqual([[HASH], [OTHER_HASH]]);
        expect(insertsInto(s, Table.ValidatorSeen)).toHaveLength(2);
        expect(writtenSeen(s).map((r) => r.first_seen)).toEqual([T0_SECONDS, sec(20_000)]);
        // validator_validations: the failed one, sent again, and the new one
        expect(insertsInto(s, Table.ValidatorValidations)).toHaveLength(3);
      });

      it('does not re-send the per-validator tables when the validations insert is what failed', async () => {
        const s = setup();
        s.collector.handleValidation(validation(), REPORTER, T0);
        failInto(s, Table.Validations);
        await expect(s.collector.flush()).rejects.toThrow('ClickHouse is down');
        // validations is first and failed; the others were still tried
        expect(tablesWritten(s)).toEqual([Table.Validations, Table.ValidatorValidations, Table.ValidatorSeen]);
        expect(s.metrics.validationsErrorsTotal.inc).toHaveBeenCalledTimes(1);
        expect(s.metrics.validationsErrorsTotal.inc).toHaveBeenCalledWith({ stage: 'flush' });

        s.insert.mockImplementation(async () => undefined);
        expect(await s.collector.flush()).toBe(1); // the rows of validations were kept
        expect(tablesWritten(s)).toEqual([
          Table.Validations,
          Table.ValidatorValidations,
          Table.ValidatorSeen,
          Table.Validations, // only the table that failed is written again
        ]);
      });

      it('does not stop the tables after a failed one: validator_seen is written when validator_validations failed', async () => {
        const s = setup();
        s.collector.handleValidation(validation(), REPORTER, T0);
        failInto(s, Table.ValidatorValidations);
        await s.collector.flush();
        expect(tablesWritten(s)).toEqual([Table.Validations, Table.ValidatorValidations, Table.ValidatorSeen]);
        expect(s.metrics.validatorValidationsFlushedTotal.inc).toHaveBeenCalledTimes(1);
        expect(s.metrics.validatorValidationsFlushedTotal.inc).toHaveBeenCalledWith({ table: Table.ValidatorSeen }, 1);
      });

      it('tries the oldest batch of a table first and, when it fails again, leaves the others for the next flush', async () => {
        const s = setup();
        failInto(s, Table.ValidatorValidations);
        for (const n of [1, 2, 3]) {
          s.collector.handleValidation(validation({ ledger_hash: hashOf(n) }), REPORTER, T0);
          await s.collector.flush();
        }
        // one attempt per flush (the oldest batch), not one per batch: a ClickHouse that is down is asked once
        expect(insertsInto(s, Table.ValidatorValidations).map((c) => c.token!.split(':').at(-1))).toEqual([
          '1',
          '1',
          '1',
        ]);

        s.insert.mockImplementation(async () => undefined);
        await s.collector.flush();
        const sent = insertsInto(s, Table.ValidatorValidations).slice(3);
        expect(sent.map((c) => [c.token!.split(':').at(-1), hashesOf(c.rows)])).toEqual([
          ['1', [hashOf(1)]],
          ['2', [hashOf(2)]],
          ['3', [hashOf(3)]],
        ]);
      });
    });

    describe('the bound on a table that keeps failing', () => {
      it('counts all pending batches together and drops the oldest rows first, with one line per flush that dropped', async () => {
        const s = setup({ collector: { maxBufferedRows: 5 } });
        const add = (...ns: number[]) =>
          ns.forEach((n) => s.collector.handleValidation(validation({ ledger_hash: hashOf(n) }), REPORTER, T0));
        failInto(s, Table.ValidatorValidations);

        add(1, 2);
        await s.collector.flush(); // batch 1: rows 1, 2
        add(3, 4);
        await s.collector.flush(); // batch 2: rows 3, 4
        expect(bufferFullDrops(s)).toBe(0);
        expect(s.logger.warn).not.toHaveBeenCalled();

        add(5, 6); // 2 + 2 pending and 2 new: one over the bound of 5
        expect(bufferFullDrops(s)).toBe(1);
        await s.collector.flush(); // batch 3: rows 5, 6
        expect(s.logger.warn).toHaveBeenCalledTimes(1);
        expect(s.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/validator_validations.*dropped 1 /));
        await s.collector.flush(); // nothing dropped since: nothing said
        expect(s.logger.warn).toHaveBeenCalledTimes(1);

        s.insert.mockImplementation(async () => undefined);
        await s.collector.flush();
        const sent = insertsInto(s, Table.ValidatorValidations).slice(-3);
        // row 1, the oldest of all, is the one that is gone; the batches go out oldest first, each with its own token
        expect(sent.map((c) => [c.token!.split(':').at(-1), hashesOf(c.rows)])).toEqual([
          ['1', [hashOf(2)]],
          ['2', [hashOf(3), hashOf(4)]],
          ['3', [hashOf(5), hashOf(6)]],
        ]);
        expect(bufferFullDrops(s)).toBe(1);
      });

      it('holds a table at the bound however many flushes fail, and keeps the newest rows', async () => {
        const s = setup({ collector: { maxBufferedRows: 5 } });
        failInto(s, Table.ValidatorValidations);
        let n = 0;
        for (let flush = 0; flush < 30; flush += 1) {
          for (let i = 0; i < 2; i += 1) {
            n += 1;
            s.collector.handleValidation(validation({ ledger_hash: hashOf(n) }), REPORTER, T0);
          }
          await s.collector.flush();
        }
        expect(bufferFullDrops(s)).toBe(60 - 5);
        expect(s.logger.warn).toHaveBeenCalledTimes(28); // one line per flush that dropped rows: the third to the thirtieth

        s.insert.mockImplementation(async () => undefined);
        await s.collector.flush();
        const sent = insertsInto(s, Table.ValidatorValidations).slice(30);
        expect(sent.flatMap((c) => hashesOf(c.rows))).toEqual([56, 57, 58, 59, 60].map(hashOf));
      });

      it('applies the bound to validator_seen as to the other table', async () => {
        const s = setup({ collector: { maxBufferedRows: 2 } });
        failInto(s, Table.ValidatorSeen);
        const validator = (i: number) => ({ master_key: `nHValidator${i}`, validation_public_key: `n9Signing${i}` });
        for (const i of [1, 2]) s.collector.handleValidation(validation(validator(i)), REPORTER, T0);
        await s.collector.flush();
        for (const i of [3, 4]) s.collector.handleValidation(validation(validator(i)), REPORTER, T0);
        // validators 1 and 2 are gone from validator_seen; the other tables were written and held 2 rows at a time
        expect(bufferFullDrops(s)).toBe(2);
        await s.collector.flush();
        expect(s.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/validator_seen.*dropped 2 /));

        s.insert.mockImplementation(async () => undefined);
        await s.collector.flush();
        const last = insertsInto(s, Table.ValidatorSeen).at(-1)!;
        expect(last.token).toMatch(/:validator_seen:2$/);
        expect((last.rows as ValidatorSeenRow[]).map((r) => r.validation_public_key)).toEqual([
          'nHValidator3',
          'nHValidator4',
        ]);
      });
    });

    describe('shutdown', () => {
      it('writes the four tables in the final flush', async () => {
        const s = setup();
        await boot(s);
        s.nodes[0].emit('manifestReceived', manifest({ seq: 2 }));
        s.nodes[0].emit('validationReceived', validation());
        await s.collector.stop();
        expect(tablesWritten(s)).toEqual([
          Table.ValidatorManifests,
          Table.Validations,
          Table.ValidatorValidations,
          Table.ValidatorSeen,
        ]);
      });

      it('starts no further insert once the final flush is abandoned, whichever table hangs', async () => {
        const s = setup();
        await boot(s);
        const hung = deferred<void>();
        s.insert.mockImplementation(async (table: Table | string) => {
          if (table === Table.ValidatorValidations) return hung.promise;
        });
        s.nodes[0].emit('validationReceived', validation());
        const stopping = s.collector.stop();
        await jest.advanceTimersByTimeAsync(VALIDATIONS_SHUTDOWN_WAIT_MS);
        await stopping;
        expect(tablesWritten(s)).toEqual([Table.Validations, Table.ValidatorValidations]);

        hung.resolve(); // the hung insert comes back: the flush behind it must not go on to validator_seen
        await jest.advanceTimersByTimeAsync(VALIDATIONS_FLUSH_INTERVAL_MS * 3);
        expect(tablesWritten(s)).toEqual([Table.Validations, Table.ValidatorValidations]);
        expect(jest.getTimerCount()).toBe(0);
      });
    });
  });

  describe('the buffer cap', () => {
    it('is documented: 50 000 rows', () => {
      expect(MAX_BUFFERED_ROWS).toBe(50_000);
    });

    it('drops the oldest rows past the cap, counts them and logs one warning', async () => {
      const s = setup({ collector: { maxBufferedRows: 3 } });
      const hashes = ['1', '2', '3', '4', '5'].map((c) => c.repeat(64));
      for (const hash of hashes) s.collector.handleValidation(validation({ ledger_hash: hash }), REPORTER, T0);

      expect(s.collector.bufferedRows).toBe(3);
      // 2 rows of `validations` and 2 of `validator_validations` (the cap is per table; one master: `validator_seen` has 1 row)
      expect(bufferFullDrops(s)).toBe(4);
      expect(s.metrics.validationsDroppedTotal.inc).toHaveBeenCalledWith({ reason: 'buffer_full' });
      expect(s.logger.warn).toHaveBeenCalledTimes(1); // the per-validator tables say theirs once per flush, see below
      expect(s.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/buffer is full.*dropped 1 /i));

      await s.collector.flush();
      expect(written(s).map((r) => r.ledger_hash)).toEqual(hashes.slice(2)); // the newest three are kept
    });

    it('merging into a row that is there is not an insertion: it never drops anything', async () => {
      const s = setup({ collector: { maxBufferedRows: 2 } });
      for (let i = 0; i < 50; i += 1) s.collector.handleValidation(validation(), REPORTER, T0);
      s.collector.handleValidation(validation({ ledger_hash: OTHER_HASH }), REPORTER, T0);
      expect(s.collector.bufferedRows).toBe(2);
      expect(s.metrics.validationsDroppedTotal.inc).not.toHaveBeenCalled();
    });

    it('applies to the rows put back by a failed flush too, dropping the oldest of all', async () => {
      const s = setup({ collector: { maxBufferedRows: 3 } });
      const hashes = ['1', '2', '3'].map((c) => c.repeat(64));
      for (const hash of hashes) s.collector.handleValidation(validation({ ledger_hash: hash }), REPORTER, T0);
      const failing = deferred<void>();
      s.insert.mockReturnValueOnce(failing.promise);
      const flushing = s.collector.flush();
      s.collector.handleValidation(validation({ ledger_hash: '4'.repeat(64) }), REPORTER, T0);
      s.collector.handleValidation(validation({ ledger_hash: '5'.repeat(64) }), REPORTER, T0);
      failing.reject(new Error('down'));
      await expect(flushing).rejects.toThrow('down');

      // 3 failed + 2 new = 5 rows for a cap of 3: the two oldest of the failed ones are gone
      expect(s.collector.bufferedRows).toBe(3);
      expect(bufferFullDrops(s)).toBe(4); // 2 of `validations`, and the same 2 of `validator_validations`
      await s.collector.flush();
      expect(lastInsert(s).map((r) => r.ledger_hash)).toEqual(['3', '4', '5'].map((c) => c.repeat(64)));
    });

    it('logs the drops again only after a minute, with the number dropped since', async () => {
      const s = setup({ collector: { maxBufferedRows: 1 } });
      const add = (n: number) =>
        s.collector.handleValidation(validation({ ledger_hash: n.toString(16).padStart(64, '0') }), REPORTER, T0);
      add(1);
      add(2); // first drop: logged
      add(3);
      add(4); // within the minute: only counted
      expect(s.logger.warn).toHaveBeenCalledTimes(1);
      expect(bufferFullDrops(s)).toBe(6); // 3 of `validations` and 3 of `validator_validations`

      await jest.advanceTimersByTimeAsync(60_000);
      add(5);
      expect(s.logger.warn).toHaveBeenCalledTimes(2);
      expect(s.logger.warn).toHaveBeenLastCalledWith(expect.stringMatching(/dropped 3 /i));
    });
  });

  describe('the feeds', () => {
    it('opens one single-endpoint client per validation endpoint, subscribed to validations and manifests before it connects', async () => {
      const s = setup({ endpoints: 'ws://node-a:6006, wss://node-b:443 ,ws://node-a:6006' });
      await boot(s);

      expect(s.nodes.map((n) => n.endpoint)).toEqual(['ws://node-a:6006', 'wss://node-b:443']); // a repeated entry is one node
      for (const node of s.nodes) {
        expect(node.subscribedBeforeStart).toEqual([['validations', 'manifests']]);
        expect(node.start).toHaveBeenCalledTimes(1);
      }
      await s.collector.stop();
    });

    it('stamps each validation with the pubkey_node of the node that reported it', async () => {
      const s = setup({ endpoints: 'ws://node-a:6006,ws://node-b:6006', reporters: ['n9ReporterA', 'n9ReporterB'] });
      await boot(s);
      expect(s.nodes[0].serverInfo).toHaveBeenCalledTimes(1);
      s.nodes[0].emit('validationReceived', validation());
      s.nodes[1].emit('validationReceived', validation({ ledger_hash: OTHER_HASH }));
      await s.collector.flush();
      expect(written(s).map((r) => [r.ledger_hash, r.reporter_public_key])).toEqual([
        [HASH, 'n9ReporterA'],
        [OTHER_HASH, 'n9ReporterB'],
      ]);
      await s.collector.stop();
    });

    it('adds up what two nodes report of the same validation (they are two reports)', async () => {
      const s = setup({ endpoints: 'ws://node-a:6006,ws://node-b:6006', reporters: ['n9ReporterA', 'n9ReporterB'] });
      await boot(s);
      s.nodes[0].emit('validationReceived', validation());
      await jest.advanceTimersByTimeAsync(40);
      s.nodes[1].emit('validationReceived', validation());
      await s.collector.flush();
      expect(written(s)).toHaveLength(1);
      expect(written(s)[0]).toMatchObject({ count: 2, reporter_public_key: 'n9ReporterA' });
      expect(written(s)[0].last_datetime - written(s)[0].first_datetime).toBeCloseTo(0.04, 3);
      await s.collector.stop();
    });

    it('asks the node again after a reconnect: a cluster answers from another server each time', async () => {
      const s = setup({ reporters: ['n9ReporterA'] });
      await boot(s);
      s.nodes[0].emit('validationReceived', validation());

      s.nodes[0].pubkey = 'n9ReporterB';
      s.nodes[0].emit('disconnected', 'ws://node-a:6006');
      s.nodes[0].emit('connected', 'ws://node-a:6006');
      // until it has answered the reporter is not known: nothing is recorded with the old one
      s.nodes[0].emit('validationReceived', validation({ ledger_hash: OTHER_HASH }));
      expect(s.metrics.validationsDroppedTotal.inc).toHaveBeenCalledWith({ reason: 'no_reporter' });
      await jest.advanceTimersByTimeAsync(0);
      s.nodes[0].emit('validationReceived', validation({ ledger_hash: '7'.repeat(64) }));

      await s.collector.flush();
      expect(
        written(s).map((r) => [r.ledger_hash === HASH ? 'first' : r.ledger_hash.slice(0, 1), r.reporter_public_key]),
      ).toEqual([
        ['first', 'n9ReporterA'],
        ['7', 'n9ReporterB'],
      ]);
      expect(s.nodes[0].serverInfo).toHaveBeenCalledTimes(2);
      await s.collector.stop();
    });

    it('drops what arrives before the reporter is known, counted, and never records it with an empty one', async () => {
      const s = setup();
      const slow = deferred<{ pubkey_node: string; complete_ledgers: string }>();
      s.collector.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      // the node connected, and its server_info is still on its way
      s.nodes[0].serverInfo.mockReset();
      s.nodes[0].serverInfo.mockReturnValueOnce(slow.promise as never);
      s.nodes[0].emit('connected', 'ws://node-a:6006');
      s.nodes[0].emit('validationReceived', validation());
      expect(s.collector.bufferedRows).toBe(0);
      expect(s.metrics.validationsDroppedTotal.inc).toHaveBeenCalledWith({ reason: 'no_reporter' });

      slow.resolve({ pubkey_node: 'n9Late', complete_ledgers: '1-2' });
      await jest.advanceTimersByTimeAsync(0);
      s.nodes[0].emit('validationReceived', validation());
      await s.collector.flush();
      expect(written(s)[0].reporter_public_key).toBe('n9Late');
      await s.collector.stop();
    });

    it('ignores a late server_info answer of a connection that was replaced meanwhile', async () => {
      const s = setup({ reporters: ['n9ReporterA'] });
      s.collector.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      const old = deferred<{ pubkey_node: string; complete_ledgers: string }>();
      s.nodes[0].serverInfo.mockReturnValueOnce(old.promise as never);
      s.nodes[0].emit('connected', 'ws://node-a:6006'); // answer of this one is slow ...
      s.nodes[0].pubkey = 'n9ReporterC';
      s.nodes[0].emit('connected', 'ws://node-a:6006'); // ... and it is replaced before it comes
      await jest.advanceTimersByTimeAsync(0);
      old.resolve({ pubkey_node: 'n9Stale', complete_ledgers: '1-2' });
      await jest.advanceTimersByTimeAsync(0);

      s.nodes[0].emit('validationReceived', validation());
      await s.collector.flush();
      expect(written(s)[0].reporter_public_key).toBe('n9ReporterC');
      await s.collector.stop();
    });

    it('retries server_info after a failure, counting it, and collects once it answers', async () => {
      const s = setup();
      s.collector.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      s.nodes[0].serverInfo.mockRejectedValueOnce(new Error('NodeClient is stopped'));
      s.nodes[0].emit('connected', 'ws://node-a:6006');
      await jest.advanceTimersByTimeAsync(0);
      expect(s.metrics.validationsErrorsTotal.inc).toHaveBeenCalledWith({ stage: 'reporter' });
      expect(s.logger.error).toHaveBeenCalledWith(expect.stringContaining('NodeClient is stopped'));

      s.nodes[0].emit('validationReceived', validation());
      expect(s.collector.bufferedRows).toBe(0);
      await jest.advanceTimersByTimeAsync(REPORTER_RETRY_MS);
      s.nodes[0].emit('validationReceived', validation());
      expect(s.collector.bufferedRows).toBe(1);
      await s.collector.stop();
    });

    it('uses an empty reporter, and says so once, for a node that reports no pubkey_node', async () => {
      const s = setup({ reporters: [undefined] });
      await boot(s);
      expect(s.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/no pubkey_node/));
      s.nodes[0].emit('validationReceived', validation());
      await s.collector.flush();
      expect(written(s)[0].reporter_public_key).toBe('');
      await s.collector.stop();
    });

    it('refuses a node of another network: it is stopped and none of its messages is recorded', async () => {
      const s = setup({ network: 'xrpl', networkId: 21337 }); // a Xahau node among the XRPL endpoints
      await boot(s);

      expect(s.nodes[0].stop).toHaveBeenCalled();
      expect(s.logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/network_id 21337 does not match GH_NETWORK=xrpl/),
      );
      expect(s.metrics.validationsErrorsTotal.inc).toHaveBeenCalledWith({ stage: 'network' });
      s.nodes[0].emit('validationReceived', validation());
      expect(s.collector.bufferedRows).toBe(0);
      await s.collector.stop();
    });

    it('works on Xahau unchanged: a node with network_id 21337 is accepted under GH_NETWORK=xahau', async () => {
      const s = setup({ network: 'xahau', networkId: 21337 });
      await boot(s);
      s.nodes[0].emit('validationReceived', validation());
      await s.collector.flush();
      expect(written(s)).toHaveLength(1);
      expect(s.nodes[0].stop).not.toHaveBeenCalled();
      expect(s.metrics.validationsErrorsTotal.inc).not.toHaveBeenCalled();
      await s.collector.stop();
    });

    it('does not let a message that breaks the handler escape into the stream', async () => {
      const s = setup();
      await boot(s);
      const broken = {
        get validation_public_key(): string {
          throw new Error('getter exploded');
        },
      };
      expect(() => s.nodes[0].emit('validationReceived', broken)).not.toThrow();
      expect(s.logger.error).toHaveBeenCalledWith(expect.stringContaining('getter exploded'));
      expect(s.metrics.validationsErrorsTotal.inc).toHaveBeenCalledWith({ stage: 'handle' });
      await s.collector.stop();
    });

    it('goes on with the other endpoints when one cannot be set up, and counts it', async () => {
      const s = setup({ endpoints: 'ws://node-a:6006,ws://node-b:6006' });
      const made = (s.collector as unknown as { makeClient: (endpoint: string) => NodeClient }).makeClient;
      Object.assign(s.collector, {
        makeClient: (endpoint: string) => {
          if (endpoint === 'ws://node-a:6006') throw new Error('Invalid node endpoint');
          return made(endpoint);
        },
      });
      await boot(s);
      expect(s.nodes.map((n) => n.endpoint)).toEqual(['ws://node-b:6006']);
      expect(s.metrics.validationsErrorsTotal.inc).toHaveBeenCalledWith({ stage: 'connect' });
      expect(s.logger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid node endpoint'));
      await s.collector.stop();
    });

    it('does not hold the boot up while a node is down', async () => {
      const s = setup();
      s.collector.onApplicationBootstrap();
      expect(s.collector.onApplicationBootstrap()).toBeUndefined();
      await jest.advanceTimersByTimeAsync(0);
      await s.collector.stop();
    });
  });

  describe('shutdown', () => {
    it('registers its cleanup with the shutdown signals', async () => {
      const s = setup();
      await boot(s);
      expect(s.signals.register).toHaveBeenCalledWith('validations-collector', expect.any(Function));
      await s.signals.register.mock.calls[0][1]();
      expect(s.nodes[0].stop).toHaveBeenCalled();
    });

    it('stops the timers, flushes once more, and stops every client', async () => {
      const s = setup({ endpoints: 'ws://node-a:6006,ws://node-b:6006' });
      await boot(s);
      s.nodes[0].emit('validationReceived', validation());
      s.nodes[1].emit('validationReceived', validation());

      await s.collector.onModuleDestroy();
      expect(written(s)).toHaveLength(1);
      expect(written(s)[0].count).toBe(2);
      expect(s.nodes.every((n) => n.stop.mock.calls.length === 1)).toBe(true);
      expect(jest.getTimerCount()).toBe(0);

      // no tick or message does anything afterwards
      s.nodes[0].emit('validationReceived', validation());
      expect(s.collector.bufferedRows).toBe(0);
      await jest.advanceTimersByTimeAsync(VALIDATIONS_FLUSH_INTERVAL_MS * 3);
      expect(tablesWritten(s)).toEqual([Table.Validations, Table.ValidatorValidations, Table.ValidatorSeen]); // the final flush only
    });

    it('stops listening to the streams', async () => {
      const s = setup();
      await boot(s);
      expect(s.nodes[0].listenerCount('validationReceived')).toBe(1);
      expect(s.nodes[0].listenerCount('manifestReceived')).toBe(1);
      expect(s.nodes[0].listenerCount('connected')).toBe(1);
      await s.collector.stop();
      for (const event of ['validationReceived', 'manifestReceived', 'connected']) {
        expect([event, s.nodes[0].listenerCount(event)]).toEqual([event, 0]);
      }
    });

    it('is idempotent, and does not start again afterwards', async () => {
      const s = setup();
      await boot(s);
      await Promise.all([s.collector.stop(), s.collector.stop(), s.collector.onModuleDestroy()]);
      await s.collector.stop();
      expect(s.nodes[0].stop).toHaveBeenCalledTimes(1);
      s.collector.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(VALIDATIONS_FLUSH_INTERVAL_MS);
      expect(s.nodes).toHaveLength(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('waits for a manifest lookup that is on its way, then flushes the validation it was holding', async () => {
      const s = setup();
      await boot(s);
      const answer = deferred<unknown>();
      s.nodes[0].request.mockReturnValueOnce(answer.promise);
      s.nodes[0].emit('validationReceived', bare());
      const stopping = s.collector.stop();
      await jest.advanceTimersByTimeAsync(100);
      expect(s.insert).not.toHaveBeenCalled();

      answer.resolve({ details: { master_key: MASTER, ephemeral_key: SIGNING, seq: 1 } });
      await stopping;
      expect(written(s).map((r) => [r.validation_public_key, r.count])).toEqual([[MASTER, 1]]);
    });

    it('waits at most 3 s for the final flush, then abandons it and says how many rows were at stake', async () => {
      expect(VALIDATIONS_SHUTDOWN_WAIT_MS).toBe(3_000);
      const s = setup();
      await boot(s);
      s.nodes[0].emit('validationReceived', validation());
      s.nodes[0].emit('validationReceived', validation({ ledger_hash: OTHER_HASH }));
      s.insert.mockReturnValueOnce(new Promise<void>(() => undefined)); // a ClickHouse that never answers

      let done = false;
      const stopping = s.collector.stop().then(() => (done = true));
      await jest.advanceTimersByTimeAsync(VALIDATIONS_SHUTDOWN_WAIT_MS - 1);
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await stopping;
      expect(done).toBe(true);
      expect(s.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Abandoning the final flush.*3000 ms.*2 rows/s));
      expect(s.nodes[0].stop).toHaveBeenCalled(); // the clients are stopped anyway
      expect(jest.getTimerCount()).toBe(0);
    });

    it('counts a failed final flush as an error and still stops the clients', async () => {
      const s = setup();
      await boot(s);
      s.nodes[0].emit('validationReceived', validation());
      s.insert.mockRejectedValueOnce(new Error('ClickHouse is down'));
      await s.collector.stop();
      expect(s.metrics.validationsErrorsTotal.inc).toHaveBeenCalledWith({ stage: 'flush' });
      expect(s.logger.error).toHaveBeenCalledWith(expect.stringContaining('ClickHouse is down'));
      expect(s.nodes[0].stop).toHaveBeenCalled();
    });

    it('a manifest request that never answers does not keep the other rows from being written', async () => {
      expect(VALIDATIONS_LOOKUP_SHUTDOWN_WAIT_MS).toBe(1_000);
      const s = setup();
      await boot(s);
      s.nodes[0].emit('validationReceived', validation()); // a row in the buffer
      s.nodes[0].request.mockReturnValueOnce(new Promise(() => undefined)); // the node never answers this one
      s.nodes[0].emit('validationReceived', bare({ validation_public_key: SIGNING_2, ledger_hash: OTHER_HASH }));

      let done = false;
      const stopping = s.collector.stop().then(() => (done = true));
      await jest.advanceTimersByTimeAsync(VALIDATIONS_LOOKUP_SHUTDOWN_WAIT_MS - 1);
      expect(s.insert).not.toHaveBeenCalled(); // the lookups still have their share
      await jest.advanceTimersByTimeAsync(1);
      await stopping;

      // the row that was there is written inside the cap, and the validation that waited is dropped, counted and said
      expect(done).toBe(true);
      expect(written(s).map((r) => [r.ledger_hash, r.validation_public_key])).toEqual([[HASH, MASTER]]);
      expect(s.metrics.validationsDroppedTotal.inc).toHaveBeenCalledWith({ reason: 'shutdown' }, 1);
      expect(s.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Giving up on 1 validations.*1000 ms/));
      expect(s.logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(/Abandoning the final flush/));
      expect(s.nodes[0].stop).toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('a lookup that gives its answer after the shutdown gave up on it records nothing, and inserts nothing', async () => {
      const s = setup();
      await boot(s);
      const late = deferred<unknown>();
      s.nodes[0].request.mockReturnValueOnce(late.promise);
      s.nodes[0].emit('validationReceived', bare());
      const stopping = s.collector.stop();
      await jest.advanceTimersByTimeAsync(VALIDATIONS_LOOKUP_SHUTDOWN_WAIT_MS);
      await stopping;
      expect(s.insert).not.toHaveBeenCalled();

      late.resolve({ details: { master_key: MASTER, ephemeral_key: SIGNING, seq: 1 } });
      await jest.advanceTimersByTimeAsync(VALIDATIONS_FLUSH_INTERVAL_MS * 2);
      expect(s.collector.bufferedRows).toBe(0);
      expect(s.insert).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('a lookup that fails after the stop (the client is stopped, the request rejects) is no error', async () => {
      const s = setup();
      await boot(s);
      const hung = deferred<unknown>();
      s.nodes[0].request.mockReturnValueOnce(hung.promise);
      s.nodes[0].emit('validationReceived', bare());
      const stopping = s.collector.stop();
      await jest.advanceTimersByTimeAsync(VALIDATIONS_LOOKUP_SHUTDOWN_WAIT_MS);
      await stopping;

      hung.reject(new Error('The websocket was closed before the response was received'));
      await jest.advanceTimersByTimeAsync(0);
      expect(s.metrics.validationsErrorsTotal.inc).not.toHaveBeenCalled();
      expect(s.logger.error).not.toHaveBeenCalled();
      expect(s.insert).not.toHaveBeenCalled();
    });

    it('no insert is started once the final flush is abandoned, even when the hung insert settles and a flush was waiting behind it', async () => {
      const s = setup();
      await boot(s);
      const hungInsert = deferred<void>();
      s.insert.mockReturnValueOnce(hungInsert.promise);
      s.nodes[0].emit('validationReceived', validation());
      await jest.advanceTimersByTimeAsync(VALIDATIONS_FLUSH_INTERVAL_MS); // the periodic flush: its insert hangs
      expect(s.insert).toHaveBeenCalledTimes(1);

      s.nodes[0].emit('validationReceived', validation({ ledger_hash: OTHER_HASH })); // waiting in the buffer
      s.nodes[0].emit('manifestReceived', manifest({ seq: 2 })); // and a manifest waiting to be written
      const stopping = s.collector.stop(); // its final flush is chained behind the hung one
      await jest.advanceTimersByTimeAsync(VALIDATIONS_SHUTDOWN_WAIT_MS);
      await stopping;
      expect(s.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Abandoning the final flush.*2 rows/));

      // the hung insert finishes at last: the flush behind it must not start
      hungInsert.resolve();
      await jest.advanceTimersByTimeAsync(VALIDATIONS_FLUSH_INTERVAL_MS * 3);
      expect(s.insert).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('does not start the insert of the buffer either when the hung one is the manifests insert', async () => {
      const s = setup();
      await boot(s);
      const hungManifests = deferred<void>();
      s.insert.mockReturnValueOnce(hungManifests.promise);
      s.nodes[0].emit('manifestReceived', manifest({ seq: 2 }));
      s.nodes[0].emit('validationReceived', validation());
      const stopping = s.collector.stop(); // the final flush hangs writing the manifests ...
      await jest.advanceTimersByTimeAsync(VALIDATIONS_SHUTDOWN_WAIT_MS);
      await stopping;
      expect(s.insert).toHaveBeenCalledTimes(1);

      hungManifests.resolve(); // ... and gets on with the rows when they are written: it must not
      await jest.advanceTimersByTimeAsync(0);
      expect(s.insert).toHaveBeenCalledTimes(1);
      expect(written(s)).toEqual([]);
    });

    it('does not wait for a client that does not stop', async () => {
      const s = setup();
      await boot(s);
      s.nodes[0].stop.mockReturnValueOnce(new Promise<void>(() => undefined));
      let done = false;
      const stopping = s.collector.stop().then(() => (done = true));
      await jest.advanceTimersByTimeAsync(VALIDATIONS_SHUTDOWN_WAIT_MS);
      await stopping;
      expect(done).toBe(true);
    });

    it('stops without a flush when nothing is buffered, and never started a feed it was stopped before', async () => {
      const s = setup();
      s.collector.onApplicationBootstrap();
      const stopping = s.collector.stop(); // before the manifests were even loaded
      await jest.advanceTimersByTimeAsync(0);
      await stopping;
      expect(s.nodes).toHaveLength(0);
      expect(s.insert).not.toHaveBeenCalled();
    });
  });

  describe('works without the optional providers', () => {
    it('collects and flushes with no metrics and no shutdown signals', async () => {
      const insert = jest.fn(async () => undefined);
      const node = new FakeNode('ws://node-a:6006', REPORTER);
      const collector = new ValidationsCollector(
        { validationEndpoints: 'ws://node-a:6006' } as SyncerConfig,
        getNetworkProfile('xrpl'),
        { insert, query: async () => [] } as unknown as ClickHouseService,
        undefined,
        undefined,
        {
          logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
          makeClient: () => node as unknown as NodeClient,
        },
      );
      collector.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      node.emit('validationReceived', validation());
      expect(await collector.flush()).toBe(1);
      await collector.stop();
    });
  });
});

describe('the defaults', () => {
  it('are the ones the report documents', () => {
    expect(VALIDATIONS_FLUSH_INTERVAL_MS).toBe(20_000);
    expect(MANIFEST_MISS_TTL_MS).toBe(10 * 60_000);
    expect(MANIFEST_FAILURE_TTL_MS).toBe(30_000);
    expect(MANIFEST_RPC_TIMEOUT_MS).toBe(2_000);
    expect(REPORTER_RETRY_MS).toBe(5_000);
  });
});
