import { StoredUnlList } from '@gatehub/data-api-shared';
import { HourSentinel } from './agreement-windows';
import {
  assembleDirectory,
  Directory,
  DirectoryReads,
  Drops,
  NetworkStateInfo,
  PublisherRow,
  RoundInfo,
} from './directory';
import { buildSummary, PUBLISHER_KEYS, SUMMARY_KEYS } from './summary-object';

const NOW = Date.UTC(2026, 9, 19, 15, 42, 53); // ms: 2026-10-19T15:42:53Z
const NOW_S = NOW / 1000;
const NEWEST_HOUR = Date.UTC(2026, 9, 19, 14) / 1000;
const PUBLISHER_A = 'ED2677ABFFD1B33AC6FBC3062B71F1E8397C1505E1C42C64D11AD1B28FF73F4734';
const PUBLISHER_B = 'ED42AEC58B701EEBB77356FFFEC26F83C1F0407263530F068C7C73D392C7E06FD1';
const FEES: Drops = { base_fee: '10', reserve_base: '1000000', reserve_inc: '200000' };

/** The UInt64 of `sfServerVersion` as the decimal text of the stream (F3, F4). */
function encode(major: number, minor: number, patch: number, release: number, build = 0): string {
  return (
    (0x183bn << 48n) |
    (BigInt(major) << 40n) |
    (BigInt(minor) << 32n) |
    (BigInt(patch) << 24n) |
    (BigInt(release) << 16n) |
    BigInt(build)
  ).toString();
}
const V341 = encode(3, 4, 1, 0xc0);
const V340 = encode(3, 4, 0, 0xc0);
const V350RC1 = encode(3, 5, 0, 0x81);

const key = (prefix: string, n: number): string => `${prefix}${String(n).padStart(2, '0')}`;
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

function reads(over: Partial<DirectoryReads> = {}): DirectoryReads {
  return {
    builtAt: NOW,
    software: 'rippled',
    tomlPath: '/.well-known/xrp-ledger.toml',
    publishers: [],
    lists: [],
    manifestMap: [],
    manifests: [],
    seen: [],
    activity: [],
    domains: [],
    sentinels: new Map(),
    hourly: new Map(),
    rounds: [],
    votes: [],
    versions: [],
    ...over,
  };
}

const publisherRow = (id: string, publicKey: string, over: Partial<PublisherRow> = {}): PublisherRow => ({
  id,
  url: `https://${id}`,
  publicKey,
  threshold: 1,
  checked: NOW_S - 30,
  status: 'ok',
  error: '',
  ...over,
});

const listOf = (
  id: string,
  publisherKey: string,
  validators: string[],
  over: Partial<StoredUnlList>,
): StoredUnlList => ({
  publisher: id,
  publisherKey,
  sequence: 1,
  version: 1,
  expiration: NOW_S + 86_400,
  validators,
  fetchedAt: NOW_S - 100,
  ...over,
});

const seen = (k: string, ago: number) => ({ key: k, firstSeen: NOW_S - 90 * 86_400, lastSeen: NOW_S - ago });

const newestRound: RoundInfo = {
  ledgerIndex: 107_748_095,
  closeTime: NOW_S - 400,
  unlSize: 35,
  trusted: 35,
  threshold: 28,
  observed: 35,
  unl: range(1, 35).map((n) => key('nH', n)),
  negativeUnl: [],
  fees: FEES,
};

const state: NetworkStateInfo = {
  ledgerIndex: 107_748_180,
  amendments: [],
  majorities: [],
  negativeUnl: [{ key: 'nH05', firstLedger: 107_747_000 }],
  toReenable: 'nH05',
  fees: FEES,
  nodeQuorum: 28,
};

const sentinels = new Map<number, HourSentinel>([[NEWEST_HOUR, { final: true, ledgers: 900, unobserved: 0 }]]);

/** The fleet of the examples: 35 trusted validators, two publishers, 22 others seen, versions, a negative UNL member. */
function fleet(): Directory {
  const unl = range(1, 35).map((n) => key('nH', n));
  const others = range(1, 20).map((n) => key('nHO', n));
  const versionRows = [
    ...range(1, 30).map((n) => ({ key: key('nH', n), serverVersion: V341, recent: [V341] })),
    ...range(31, 34).map((n) => ({ key: key('nH', n), serverVersion: V340, recent: [V340] })),
    // nH35 reported no version
    ...range(1, 10).map((n) => ({ key: key('nHO', n), serverVersion: V341, recent: [V341] })),
    ...range(11, 15).map((n) => ({ key: key('nHO', n), serverVersion: V340, recent: [V340] })),
    ...range(16, 18).map((n) => ({ key: key('nHO', n), serverVersion: V350RC1, recent: [V350RC1] })),
    // nHO19 and nHO20 reported none
  ];
  return assembleDirectory(
    reads({
      head: { ledgerIndex: 107_748_183, closeTime: NOW_S - 8, meanIntervalSeconds: 4 },
      state,
      publishers: [
        publisherRow('unl.xrplf.org', PUBLISHER_B, {
          status: 'error',
          error: 'http_status',
          checked: Date.UTC(2026, 9, 19, 15, 40, 2, 380) / 1000,
        }),
        publisherRow('vl.ripple.com', PUBLISHER_A),
      ],
      lists: [
        listOf('vl.ripple.com', PUBLISHER_A, unl, {
          sequence: 85,
          expiration: Date.UTC(2027, 3, 6, 17, 51, 34) / 1000,
          fetchedAt: Date.UTC(2026, 9, 19, 15, 40, 2, 114) / 1000,
        }),
        listOf('unl.xrplf.org', PUBLISHER_B, unl.slice(0, 34), {
          sequence: 2_026_070_302,
          expiration: Date.UTC(2026, 9, 18) / 1000,
          fetchedAt: Date.UTC(2026, 9, 12, 8, 0, 0, 380) / 1000,
        }),
      ],
      seen: [
        ...unl.slice(0, 34).map((k) => seen(k, 60)),
        seen('nH35', 3 * 86_400),
        ...others.map((k) => seen(k, 120)),
        seen('nHO21', 3 * 86_400),
        seen('nHO22', 3 * 86_400),
        seen('nHO23', 40 * 86_400),
      ],
      sentinels,
      rounds: [newestRound],
      versions: versionRows,
    }),
  );
}

/** A directory of `count` trusted validators on one list, nothing else. */
function listed(count: number, over: Partial<DirectoryReads> = {}): Directory {
  const unl = range(1, count).map((n) => key('nH', n));
  return assembleDirectory(
    reads({
      publishers: [publisherRow('vl.ripple.com', PUBLISHER_A)],
      lists: [listOf('vl.ripple.com', PUBLISHER_A, unl, {})],
      seen: unl.map((k) => seen(k, 60)),
      ...over,
    }),
  );
}

describe('buildSummary', () => {
  describe('the answer of a fleet of 35', () => {
    it('is the answer of the specification: figures, formats and key order', () => {
      expect(buildSummary(fleet())).toEqual({
        result: 'success',
        ledger_index: 107_748_183,
        close_time: '2026-10-19T15:42:45Z',
        validators: { seen_24h: 54, unl_seen_24h: 34, others_seen_24h: 20, all: 55 },
        unl: {
          trusted: 35,
          threshold: 1,
          publishers: [
            {
              id: 'unl.xrplf.org',
              url: 'https://unl.xrplf.org',
              public_key: PUBLISHER_B,
              status: 'expired',
              sequence: 2_026_070_302,
              version: 1,
              expiration: '2026-10-18T00:00:00Z',
              fetched: '2026-10-12T08:00:00.380Z',
              validators: 34,
              seen_24h: 34,
              last_error: 'http_status',
              last_error_at: '2026-10-19T15:40:02.380Z',
            },
            {
              id: 'vl.ripple.com',
              url: 'https://vl.ripple.com',
              public_key: PUBLISHER_A,
              status: 'ok',
              sequence: 85,
              version: 1,
              expiration: '2027-04-06T17:51:34Z',
              fetched: '2026-10-19T15:40:02.114Z',
              validators: 35,
              seen_24h: 34,
            },
          ],
        },
        quorum: { value: 28, unl_size: 35, negative_unl: 1, node: 28 },
        negative_unl: [{ validation_public_key: 'nH05', first_ledger: 107_747_000 }],
        negative_unl_pending: { to_reenable: 'nH05' },
        fees: { base_fee: '0.00001', reserve_base: '1', reserve_inc: '0.2' },
        next_flag_ledger: { ledger_index: 107_748_352, voting_ledger: 107_748_351, expected: '2026-10-19T15:54:01Z' },
        latest_version: '3.4.1',
        versions: [
          { version: '3.5.0-rc1', unl: 0, all: 3 },
          { version: '3.4.1', unl: 30, all: 40 },
          { version: '3.4.0', unl: 4, all: 9 },
        ],
        versions_unknown: { unl: 1, all: 2 },
        agreement_through: '2026-10-19T15:00:00Z',
        votes_through_ledger: 107_748_095,
        updated: '2026-10-19T15:42:53.000Z',
      });
    });

    it('lists the keys in the order of SUMMARY_KEYS, and a publisher in the order of PUBLISHER_KEYS', () => {
      const summary = buildSummary(fleet());
      expect(Object.keys(summary)).toEqual([...SUMMARY_KEYS]);
      expect(Object.keys(summary.unl.publishers[0])).toEqual([...PUBLISHER_KEYS]);
    });

    it('pins the order of the keys of the nested objects', () => {
      const summary = buildSummary(fleet());
      expect(Object.keys(summary.validators ?? {})).toEqual(['seen_24h', 'unl_seen_24h', 'others_seen_24h', 'all']);
      expect(Object.keys(summary.unl)).toEqual(['trusted', 'threshold', 'publishers']);
      expect(Object.keys(summary.quorum)).toEqual(['value', 'unl_size', 'negative_unl', 'node']);
      expect(Object.keys(summary.negative_unl[0])).toEqual(['validation_public_key', 'first_ledger']);
      expect(Object.keys(summary.fees ?? {})).toEqual(['base_fee', 'reserve_base', 'reserve_inc']);
      expect(Object.keys(summary.next_flag_ledger ?? {})).toEqual(['ledger_index', 'voting_ledger', 'expected']);
      expect(Object.keys(summary.versions[0])).toEqual(['version', 'unl', 'all']);
      expect(Object.keys(summary.versions_unknown)).toEqual(['unl', 'all']);
    });

    it('has the constants in the order of the specification', () => {
      expect([...SUMMARY_KEYS]).toEqual([
        'result',
        'ledger_index',
        'close_time',
        'validators',
        'unl',
        'quorum',
        'negative_unl',
        'negative_unl_pending',
        'fees',
        'next_flag_ledger',
        'latest_version',
        'versions',
        'versions_unknown',
        'agreement_through',
        'votes_through_ledger',
        'updated',
      ]);
      expect([...PUBLISHER_KEYS]).toEqual([
        'id',
        'url',
        'public_key',
        'status',
        'sequence',
        'version',
        'expiration',
        'fetched',
        'validators',
        'seen_24h',
        'last_error',
        'last_error_at',
      ]);
    });

    it('never has a null: a key without a value is absent', () => {
      expect(JSON.stringify(buildSummary(fleet()))).not.toContain('null');
      expect(JSON.stringify(buildSummary(assembleDirectory(reads())))).not.toContain('null');
    });
  });

  describe('an empty database', () => {
    it('has result, validators, unl, quorum, negative_unl, versions, versions_unknown and updated, and nothing else', () => {
      const summary = buildSummary(assembleDirectory(reads()));
      expect(summary).toEqual({
        result: 'success',
        validators: { seen_24h: 0, unl_seen_24h: 0, others_seen_24h: 0, all: 0 },
        unl: { trusted: 0, publishers: [] },
        quorum: { value: 0, unl_size: 0, negative_unl: 0 },
        negative_unl: [],
        versions: [],
        versions_unknown: { unl: 0, all: 0 },
        updated: '2026-10-19T15:42:53.000Z',
      });
      expect(Object.keys(summary)).toEqual([
        'result',
        'validators',
        'unl',
        'quorum',
        'negative_unl',
        'versions',
        'versions_unknown',
        'updated',
      ]);
    });
  });

  describe('every publisher unavailable', () => {
    it('has trusted 0, quorum 0 and publishers with no list: their status, and no list figures', () => {
      const summary = buildSummary(
        assembleDirectory(
          reads({
            publishers: [
              publisherRow('unl.xrplf.org', PUBLISHER_B, { status: 'error', error: 'dns_error', checked: NOW_S - 10 }),
              publisherRow('vl.ripple.com', PUBLISHER_A, { status: 'error', error: 'timeout', checked: NOW_S - 20.5 }),
            ],
          }),
        ),
      );
      expect(summary.unl).toEqual({
        trusted: 0,
        threshold: 1,
        publishers: [
          {
            id: 'unl.xrplf.org',
            url: 'https://unl.xrplf.org',
            public_key: PUBLISHER_B,
            status: 'unavailable',
            last_error: 'dns_error',
            last_error_at: '2026-10-19T15:42:43.000Z',
          },
          {
            id: 'vl.ripple.com',
            url: 'https://vl.ripple.com',
            public_key: PUBLISHER_A,
            status: 'unavailable',
            last_error: 'timeout',
            last_error_at: '2026-10-19T15:42:32.500Z',
          },
        ],
      });
      expect(summary.quorum).toEqual({ value: 0, unl_size: 0, negative_unl: 0 });
    });
  });

  describe('validators', () => {
    it('counts all as the trusted validators together with those seen in 24 hours, once', () => {
      const summary = buildSummary(fleet());
      // 35 trusted (one not seen in 24 h) and 20 others seen in 24 h
      expect(summary.validators).toEqual({ seen_24h: 54, unl_seen_24h: 34, others_seen_24h: 20, all: 55 });
    });
  });

  describe('quorum', () => {
    it('leaves out node when the node reported 0 or nothing', () => {
      const with0 = buildSummary(
        listed(35, { state: { ...state, negativeUnl: [], toReenable: undefined, nodeQuorum: 0 } }),
      );
      expect(with0.quorum).toEqual({ value: 28, unl_size: 35, negative_unl: 0 });
      expect('node' in with0.quorum).toBe(false);
      expect('node' in buildSummary(listed(35)).quorum).toBe(false);
    });

    it('has node when the node reported a quorum above 0', () => {
      expect(buildSummary(listed(35, { state: { ...state, negativeUnl: [], nodeQuorum: 28 } })).quorum).toEqual({
        value: 28,
        unl_size: 35,
        negative_unl: 0,
        node: 28,
      });
    });
  });

  describe('negative UNL', () => {
    const withPending = (pending: { toDisable?: string; toReenable?: string }) =>
      buildSummary(listed(5, { state: { ...state, negativeUnl: [], toReenable: undefined, ...pending } }));

    it('adds negative_unl_pending only when something is set, and then only what is', () => {
      expect('negative_unl_pending' in withPending({})).toBe(false);
      expect(withPending({ toDisable: 'nH01' }).negative_unl_pending).toEqual({ to_disable: 'nH01' });
      expect(withPending({ toReenable: 'nH02' }).negative_unl_pending).toEqual({ to_reenable: 'nH02' });
      const both = withPending({ toDisable: 'nH01', toReenable: 'nH02' }).negative_unl_pending;
      expect(both).toEqual({ to_disable: 'nH01', to_reenable: 'nH02' });
      expect(Object.keys(both ?? {})).toEqual(['to_disable', 'to_reenable']);
    });

    it('is an empty list without a state', () => {
      expect(buildSummary(listed(5)).negative_unl).toEqual([]);
    });
  });

  describe('fees', () => {
    it('are whole units as exact decimal text', () => {
      const withFees = (fees: Drops) => buildSummary(listed(1, { state: { ...state, fees } })).fees;
      expect(withFees(FEES)).toEqual({ base_fee: '0.00001', reserve_base: '1', reserve_inc: '0.2' });
      expect(withFees({ base_fee: '12', reserve_base: '10000000', reserve_inc: '2000000' })).toEqual({
        base_fee: '0.000012',
        reserve_base: '10',
        reserve_inc: '2',
      });
      expect(withFees({ base_fee: '0', reserve_base: '1', reserve_inc: '123456789012345678' })).toEqual({
        base_fee: '0',
        reserve_base: '0.000001',
        reserve_inc: '123456789012.345678',
      });
    });

    it('are those of the newest round when there is no ledger state, and absent without either', () => {
      const round = { ...newestRound, fees: { base_fee: '15', reserve_base: '2000000', reserve_inc: '400000' } };
      expect(buildSummary(listed(1, { rounds: [round] })).fees).toEqual({
        base_fee: '0.000015',
        reserve_base: '2',
        reserve_inc: '0.4',
      });
      expect('fees' in buildSummary(listed(1))).toBe(false);
    });
  });

  describe('the ledger and the next flag ledger', () => {
    const summaryAt = (head: Directory['head']) => buildSummary(listed(1, { head }));

    it('of ledger 107748183 is 107748352, voted in 107748351', () => {
      expect(summaryAt({ ledgerIndex: 107_748_183 }).next_flag_ledger).toEqual({
        ledger_index: 107_748_352,
        voting_ledger: 107_748_351,
      });
    });

    it('is the multiple of 256 above the ledger: a flag ledger itself is followed by the next one', () => {
      expect(summaryAt({ ledgerIndex: 107_748_352 }).next_flag_ledger?.ledger_index).toBe(107_748_608);
      expect(summaryAt({ ledgerIndex: 107_748_351 }).next_flag_ledger?.ledger_index).toBe(107_748_352);
      expect(summaryAt({ ledgerIndex: 107_748_351 }).next_flag_ledger?.voting_ledger).toBe(107_748_351);
    });

    it('expects the flag ledger at the close time plus the ledgers left times the mean interval', () => {
      // 169 ledgers at 3.9 s: 659.1 s, to the second
      const close = NOW_S - 8;
      const expected = summaryAt({ ledgerIndex: 107_748_183, closeTime: close, meanIntervalSeconds: 3.9 })
        .next_flag_ledger?.expected;
      expect(expected).toBe('2026-10-19T15:53:44Z');
    });

    it('has no expected time without a close time or a mean interval', () => {
      expect(summaryAt({ ledgerIndex: 107_748_183, closeTime: NOW_S }).next_flag_ledger).toEqual({
        ledger_index: 107_748_352,
        voting_ledger: 107_748_351,
      });
      expect(summaryAt({ ledgerIndex: 107_748_183, meanIntervalSeconds: 4 }).next_flag_ledger).toEqual({
        ledger_index: 107_748_352,
        voting_ledger: 107_748_351,
      });
    });

    it('answers ledger_index without close_time when the head is a ledger state', () => {
      const summary = summaryAt({ ledgerIndex: 107_748_180 });
      expect(summary.ledger_index).toBe(107_748_180);
      expect('close_time' in summary).toBe(false);
    });

    it('has none of the three without a head', () => {
      const summary = buildSummary(listed(1));
      expect('ledger_index' in summary).toBe(false);
      expect('close_time' in summary).toBe(false);
      expect('next_flag_ledger' in summary).toBe(false);
    });
  });

  describe('versions', () => {
    const xahau = (serverVersions: Record<string, string>) =>
      buildSummary(
        assembleDirectory(
          reads({
            software: 'xahaud',
            publishers: [publisherRow('vl.xahau.org', 'ED' + 'EA'.repeat(32))],
            lists: [listOf('vl.xahau.org', 'ED' + 'EA'.repeat(32), ['nHX1', 'nHX2', 'nHX3'], {})],
            seen: ['nHX1', 'nHX2', 'nHX3'].map((k) => seen(k, 60)),
            versions: Object.entries(serverVersions).map(([k, v]) => ({ key: k, serverVersion: v, recent: [v] })),
          }),
        ),
      );

    it('groups the Xahau builds of one version together and names the version without its build', () => {
      const summary = xahau({
        nHX1: encode(3, 10, 13, 0, 4119),
        nHX2: encode(3, 10, 13, 0, 4120),
        nHX3: encode(3, 9, 2, 0, 1),
      });
      expect(summary.versions).toEqual([
        { version: '2026.10.13', unl: 2, all: 2 },
        { version: '2026.9.2', unl: 1, all: 1 },
      ]);
      expect(summary.latest_version).toBe('2026.10.13');
      expect(summary.versions_unknown).toEqual({ unl: 0, all: 0 });
    });

    it('sorts newest first: higher triple, then release before release candidate before beta', () => {
      const summary = buildSummary(
        assembleDirectory(
          reads({
            publishers: [publisherRow('vl.ripple.com', PUBLISHER_A)],
            lists: [listOf('vl.ripple.com', PUBLISHER_A, ['nHA', 'nHB', 'nHC', 'nHD'], {})],
            seen: ['nHA', 'nHB', 'nHC', 'nHD'].map((k) => seen(k, 60)),
            versions: [
              { key: 'nHA', serverVersion: encode(2, 5, 0, 0x41), recent: [] },
              { key: 'nHB', serverVersion: encode(2, 5, 0, 0xc0), recent: [] },
              { key: 'nHC', serverVersion: encode(2, 5, 0, 0x82), recent: [] },
              { key: 'nHD', serverVersion: encode(10, 0, 0, 0xc0), recent: [] },
            ],
          }),
        ),
      );
      expect(summary.versions.map((v) => v.version)).toEqual(['10.0.0', '2.5.0', '2.5.0-rc2', '2.5.0-b1']);
      expect('latest_version' in summary).toBe(false);
    });

    it('counts a validator with an unreadable version as unknown, and one never seen in 24 h only for unl', () => {
      const summary = buildSummary(fleet());
      // nH35 is trusted, unseen in 24 h and reported nothing; nHO19 and nHO20 are seen and reported nothing
      expect(summary.versions_unknown).toEqual({ unl: 1, all: 2 });
    });
  });

  describe('the end of the data', () => {
    it('ends agreement at the end of the newest final hour and votes at the newest round', () => {
      const summary = buildSummary(fleet());
      expect(summary.agreement_through).toBe('2026-10-19T15:00:00Z');
      expect(summary.votes_through_ledger).toBe(107_748_095);
    });

    it('leaves both out without a final hour and without a round', () => {
      const summary = buildSummary(listed(1));
      expect('agreement_through' in summary).toBe(false);
      expect('votes_through_ledger' in summary).toBe(false);
    });

    it('says when the directory was built, to the millisecond', () => {
      const summary = buildSummary(assembleDirectory({ ...reads(), builtAt: Date.UTC(2026, 9, 19, 15, 42, 53, 2) }));
      expect(summary.updated).toBe('2026-10-19T15:42:53.002Z');
    });
  });
});
