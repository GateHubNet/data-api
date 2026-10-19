import { amendmentId, getNetworkProfile, parseAmendmentsConfig } from '@gatehub/data-api-shared';
import {
  AMENDMENT_DETAIL_KEYS,
  AMENDMENT_ROW_KEYS,
  AMENDMENT_VOTES_KEYS,
  AMENDMENTS_BODY_KEYS,
  buildAmendmentDetail,
  buildAmendmentsBody,
  ENABLED_KEYS,
  HISTORY_KEYS,
  MAJORITY_KEYS,
  ROUND_KEYS,
  ROUND_POINT_KEYS,
  UNL_VOTE_KEYS,
} from './amendment-object';
import {
  AmendmentsAssembly,
  AmendmentSources,
  AmendmentView,
  assembleAmendments,
  RoundPoint,
} from './amendment-status';
import { assembleDirectory, Directory, DirectoryReads, RoundInfo } from './directory';
import { buildSummary } from './summary-object';

const NOW = Date.UTC(2026, 9, 19, 15, 42, 53); // ms
const NOW_S = NOW / 1000;
const FEES = { base_fee: '10', reserve_base: '1000000', reserve_inc: '200000' };
const XRPL = getNetworkProfile('xrpl');
const XAHAU = getNetworkProfile('xahau');
const GOT = 0x10000;

/** The UInt64 of `sfServerVersion` as the decimal text of the stream (F3). */
const encode = (major: number, minor: number, patch: number): string =>
  (
    (0x183bn << 48n) |
    (BigInt(major) << 40n) |
    (BigInt(minor) << 32n) |
    (BigInt(patch) << 24n) |
    (0xc0n << 16n)
  ).toString();

const config = (amendments: object[], network: 'xrpl' | 'xahau' = 'xrpl') =>
  parseAmendmentsConfig({ network, updated: '2026-10-19', amendments }, getNetworkProfile(network));

const ID = {
  voting: amendmentId('AlphaVoting'),
  majority: amendmentId('BetaMajority'),
  majorityNameless: 'A'.repeat(64),
  enabledLedger: amendmentId('GammaEnabled'),
  enabledFile: amendmentId('DeltaEnabled'),
  retired: amendmentId('EpsilonRetired'),
  obsolete: amendmentId('ZetaObsolete'),
  unknown: 'B'.repeat(64),
};

const ROUND: RoundInfo = {
  ledgerIndex: 107_748_095,
  closeTime: NOW_S - 400,
  version: '1',
  unlSize: 5,
  trusted: 4,
  threshold: 3,
  observed: 5,
  unl: ['nH01', 'nH02', 'nH03', 'nH04', 'nH05'],
  negativeUnl: [],
  fees: FEES,
};

const vote = (key: string, amendments: string[], ledger = ROUND.ledgerIndex) => ({
  ledger_index: ledger,
  validation_public_key: key,
  close_time: ROUND.closeTime,
  full: 1,
  amendments,
  base_fee: null,
  reserve_base: null,
  reserve_inc: null,
  server_version: null,
});

const seen = (key: string, agoSeconds: number) => ({
  key,
  firstSeen: NOW_S - 90 * 86_400,
  lastSeen: NOW_S - agoSeconds + 0.123,
});

function directoryOf(over: Partial<DirectoryReads> = {}): Directory {
  return assembleDirectory({
    builtAt: NOW,
    software: 'rippled',
    tomlPath: '/.well-known/xrp-ledger.toml',
    head: { ledgerIndex: 107_748_183, closeTime: NOW_S - 8, spanSeconds: 3996, spanLedgers: 999 },
    state: {
      ledgerIndex: 107_748_180,
      amendments: [ID.enabledLedger, ID.enabledFile],
      majorities: [
        { amendment: ID.majority, since: NOW_S - 86_400 },
        { amendment: ID.majorityNameless, since: NOW_S - 3 * 86_400 },
      ],
      negativeUnl: [],
      fees: FEES,
      nodeQuorum: 0,
    },
    publishers: [],
    lists: [],
    manifestMap: [],
    manifests: [
      { masterKey: 'nH01', sequence: 1, signingKey: 'n9a', domain: 'a.example', signingKeysSeen: 1 },
      { masterKey: 'nH02', sequence: 1, signingKey: 'n9b', domain: 'b.example', signingKeysSeen: 1 },
    ],
    seen: [
      seen('nH01', 30),
      seen('nH02', 30),
      seen('nH03', 30),
      seen('nH04', 30),
      seen('nH05', 30),
      seen('nHO1', 60),
      seen('nHO2', 60),
      seen('nHO3', 3 * 86_400),
      seen('nHO4', 60),
    ],
    activity: [],
    domains: [],
    sentinels: new Map(),
    hourly: new Map(),
    rounds: [ROUND],
    votes: [
      // on the UNL: 01 and 02 vote for the voting amendment and the majority one; 03 votes for none; 04 for another
      vote('nH01', [ID.voting, ID.majority]),
      vote('nH02', [ID.voting, ID.majority]),
      vote('nH03', []),
      vote('nH04', [ID.unknown]),
      // not on the UNL, seen in 24 h: 01 votes for the majority one, 02 for none, 04 has no vote; 03 was seen days ago
      vote('nHO1', [ID.majority]),
      vote('nHO2', []),
      vote('nHO3', [ID.majority]),
    ],
    versions: [
      { key: 'nH01', serverVersion: encode(3, 4, 1), recent: [encode(3, 4, 1)] },
      { key: 'nH02', serverVersion: encode(3, 4, 0), recent: [encode(3, 4, 0)] },
      { key: 'nH04', serverVersion: encode(3, 5, 0), recent: [encode(3, 5, 0)] },
      { key: 'nHO1', serverVersion: encode(3, 4, 1), recent: [encode(3, 4, 1)] },
    ],
    ...over,
  });
}

const FILE = [
  {
    name: 'AlphaVoting',
    introduced: '3.4.1',
    xls: 'XLS-1',
    xls_url: 'https://github.com/XRPLF/XRPL-Standards/tree/master/XLS-0001-example',
    description: 'A voting amendment.',
  },
  { name: 'BetaMajority', introduced: '3.5.0' },
  { name: 'GammaEnabled', introduced: '1.12.0', enabled: { ledger_index: 5, date: '2020-01-01' } },
  { name: 'DeltaEnabled', enabled: { ledger_index: 90, date: '2024-01-02' } },
  { name: 'ZetaObsolete', obsolete: true },
];

function sourcesOf(over: Partial<AmendmentSources> = {}): AmendmentSources {
  return {
    config: config(FILE),
    features: new Map([[ID.voting, { name: 'AlphaVoting', supported: true }]]),
    voted: new Set([ID.voting, ID.majority, ID.unknown]),
    yes: new Map([
      [ID.voting, 2],
      [ID.majority, 3],
      [ID.majorityNameless, 3],
    ]),
    transactions: [
      {
        amendment: ID.enabledLedger,
        flags: 0,
        ledgerIndex: 107_000_001,
        date: NOW_S - 9_000_000,
        txHash: 'E'.repeat(64),
      },
      {
        amendment: ID.majority,
        flags: GOT,
        ledgerIndex: 107_747_841,
        date: NOW_S - 86_400 + 4,
        txHash: 'F'.repeat(64),
      },
    ],
    majorityHoldSeconds: 1_209_600,
    ...over,
  };
}

const assemble = (directory = directoryOf(), sources = sourcesOf()): AmendmentsAssembly =>
  assembleAmendments(directory, sources);

const keys = (o: object): string[] => Object.keys(o);

// -- the constants -----------------------------------------------------------------------------------------------------

describe('the key constants', () => {
  it('are the ones the reference writes, in order', () => {
    expect([...AMENDMENTS_BODY_KEYS]).toEqual([
      'result',
      'ledger_index',
      'rules',
      'round',
      'next_flag_ledger',
      'counts',
      'count',
      'amendments',
    ]);
    expect([...ROUND_KEYS]).toEqual(['ledger_index', 'date', 'unl_size', 'trusted', 'threshold', 'needed', 'observed']);
    expect([...AMENDMENT_ROW_KEYS]).toEqual([
      'id',
      'name',
      'status',
      'retired',
      'introduced',
      'xls',
      'xls_url',
      'description',
      'node_supported',
      'votes',
      'majority',
      'enabled',
    ]);
    expect([...AMENDMENT_VOTES_KEYS]).toEqual(['ledger_index', 'yes', 'trusted', 'needed', 'pct']);
    expect([...MAJORITY_KEYS]).toEqual(['since', 'ledger_index', 'tx_hash', 'expected_activation']);
    expect([...ENABLED_KEYS]).toEqual(['ledger_index', 'date', 'tx_hash', 'source']);
    expect([...AMENDMENT_DETAIL_KEYS]).toEqual([
      'ledger_index',
      'rules',
      'round',
      'next_flag_ledger',
      ...AMENDMENT_ROW_KEYS,
      'unl_votes',
      'other_votes',
      'rounds',
      'history',
      'result',
    ]);
    expect([...UNL_VOTE_KEYS]).toEqual([
      'validation_public_key',
      'domain',
      'vote',
      'version',
      'version_supports',
      'last_seen',
    ]);
    expect([...ROUND_POINT_KEYS]).toEqual([
      'ledger_index',
      'flag_ledger',
      'date',
      'yes',
      'trusted',
      'threshold',
      'passes',
    ]);
    expect([...HISTORY_KEYS]).toEqual(['event', 'ledger_index', 'date', 'tx_hash']);
  });
});

// -- the list ----------------------------------------------------------------------------------------------------------

describe('buildAmendmentsBody', () => {
  const assembly = assemble();
  const body = buildAmendmentsBody(assembly, XRPL);
  const row = (ref: string) => {
    const found = body.amendments.find((a) => a.id === ref);
    if (!found) throw new Error(`no row ${ref}`);
    return found;
  };

  it('has the keys of AMENDMENTS_BODY_KEYS, in order', () => {
    expect(keys(body)).toEqual([...AMENDMENTS_BODY_KEYS]);
    expect(body.result).toBe('success');
  });

  it('has the rules of the network: the share, the hold and the flag interval', () => {
    expect(body.rules).toEqual({ threshold_percent: 80, majority_hold_seconds: 1_209_600, flag_interval: 256 });
    expect(keys(body.rules ?? {})).toEqual(['threshold_percent', 'majority_hold_seconds', 'flag_interval']);
    expect(buildAmendmentsBody(assembly, XAHAU).rules).toEqual({
      threshold_percent: 80,
      majority_hold_seconds: 432_000,
      flag_interval: 256,
    });
  });

  it('describes the newest stored round, in the order of ROUND_KEYS', () => {
    expect(body.round).toEqual({
      ledger_index: 107_748_095,
      date: new Date((NOW_S - 400) * 1000).toISOString().slice(0, 19) + 'Z',
      unl_size: 5,
      trusted: 4,
      threshold: 3,
      needed: 4,
      observed: 5,
    });
    expect(keys(body.round ?? {})).toEqual([...ROUND_KEYS]);
  });

  it('has the ledger and the next flag ledger of the summary', () => {
    const summary = buildSummary(assembly.directory);
    expect(body.ledger_index).toBe(summary.ledger_index);
    expect(body.next_flag_ledger).toEqual(summary.next_flag_ledger);
    expect(body.next_flag_ledger).toEqual({
      ledger_index: 107_748_352,
      voting_ledger: 107_748_351,
      expected: expect.stringMatching(/Z$/),
    });
  });

  it('counts every status, and the rows it returns', () => {
    expect(body.counts).toEqual({ enabled: 2, majority: 2, voting: 2, obsolete: 1, unknown: 0 });
    expect(body.count).toBe(7);
    expect(body.amendments).toHaveLength(7);
  });

  it('keeps the counts of all statuses and counts the rows of the ones it filters', () => {
    const filtered = buildAmendmentsBody(assembly, XRPL, ['voting', 'majority']);
    expect(filtered.counts).toEqual(body.counts);
    expect(filtered.count).toBe(4);
    expect(filtered.amendments.map((a) => a.status)).toEqual(['majority', 'majority', 'voting', 'voting']);
    expect(filtered.amendments.map((a) => a.id)).toEqual(
      body.amendments.filter((a) => a.status === 'majority' || a.status === 'voting').map((a) => a.id),
    );
    expect(buildAmendmentsBody(assembly, XRPL, []).count).toBe(7);
    expect(buildAmendmentsBody(assembly, XRPL, ['unknown']).amendments).toEqual([]);
  });

  describe('a row', () => {
    it('has the keys of AMENDMENT_ROW_KEYS in order and leaves out the ones it has no value for', () => {
      const voting = row(ID.voting);
      expect(voting).toEqual({
        id: ID.voting,
        name: 'AlphaVoting',
        status: 'voting',
        introduced: '3.4.1',
        xls: 'XLS-1',
        xls_url: 'https://github.com/XRPLF/XRPL-Standards/tree/master/XLS-0001-example',
        description: 'A voting amendment.',
        node_supported: true,
        votes: { ledger_index: 107_748_095, yes: 2, trusted: 4, needed: 4, pct: 50 },
      });
      expect(keys(voting)).toEqual([
        'id',
        'name',
        'status',
        'introduced',
        'xls',
        'xls_url',
        'description',
        'node_supported',
        'votes',
      ]);
      expect(keys(voting.votes ?? {})).toEqual([...AMENDMENT_VOTES_KEYS]);
    });

    it('is the id and the status only for an amendment nothing else is known of', () => {
      expect(row(ID.unknown)).toEqual({
        id: ID.unknown,
        status: 'voting',
        votes: { ledger_index: 107_748_095, yes: 0, trusted: 4, needed: 4, pct: 0 },
      });
    });

    it('has the majority with the ledger and transaction of the indexed got_majority, as times', () => {
      const majority = row(ID.majority);
      expect(majority.majority).toEqual({
        since: new Date((NOW_S - 86_400) * 1000).toISOString().slice(0, 19) + 'Z',
        ledger_index: 107_747_841,
        tx_hash: 'F'.repeat(64),
        expected_activation: new Date((NOW_S - 86_400 + 1_209_600) * 1000).toISOString().slice(0, 19) + 'Z',
      });
      expect(keys(majority.majority ?? {})).toEqual([...MAJORITY_KEYS]);
      expect(keys(majority)).toEqual(['id', 'name', 'status', 'introduced', 'votes', 'majority']);
    });

    it('has the majority without ledger_index and tx_hash when the EnableAmendment is not indexed', () => {
      const nameless = row(ID.majorityNameless);
      expect(keys(nameless.majority ?? {})).toEqual(['since', 'expected_activation']);
      expect(nameless).not.toHaveProperty('name');
    });

    it('has the enabled object of the ledger, with the close time of the transaction', () => {
      const enabled = row(ID.enabledLedger);
      expect(enabled.enabled).toEqual({
        ledger_index: 107_000_001,
        date: new Date((NOW_S - 9_000_000) * 1000).toISOString().slice(0, 19) + 'Z',
        tx_hash: 'E'.repeat(64),
        source: 'ledger',
      });
      expect(keys(enabled.enabled ?? {})).toEqual([...ENABLED_KEYS]);
      expect(enabled).not.toHaveProperty('votes');
    });

    it('has the enabled object of the file as a day, without a transaction', () => {
      const enabled = row(ID.enabledFile);
      expect(enabled.enabled).toEqual({ ledger_index: 90, date: '2024-01-02', source: 'metadata' });
      expect(keys(enabled.enabled ?? {})).toEqual(['ledger_index', 'date', 'source']);
    });

    it('has retired and no enabled object for a retired Xahau name', () => {
      const xahau = assemble(
        directoryOf({}),
        sourcesOf({
          config: config([{ name: 'EpsilonRetired', retired: true }], 'xahau'),
          features: new Map(),
          voted: new Set(),
          yes: new Map(),
          transactions: [],
        }),
      );
      const retired = buildAmendmentsBody(xahau, XAHAU).amendments.find((a) => a.id === ID.retired);
      expect(retired).toEqual({ id: ID.retired, name: 'EpsilonRetired', status: 'enabled', retired: true });
      expect(keys(retired ?? {})).toEqual(['id', 'name', 'status', 'retired']);
    });

    it('has no votes for an obsolete amendment', () => {
      expect(row(ID.obsolete)).toEqual({ id: ID.obsolete, name: 'ZetaObsolete', status: 'obsolete' });
    });
  });

  it('has no null anywhere', () => {
    expect(JSON.stringify(body)).not.toContain('null');
  });

  it('answers a database with nothing as the rules, empty counts and no list', () => {
    const empty = buildAmendmentsBody(
      assemble(
        assembleDirectory({
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
        }),
        sourcesOf({ config: config([]), features: new Map(), voted: new Set(), yes: new Map(), transactions: [] }),
      ),
      XRPL,
    );
    expect(empty).toEqual({
      result: 'success',
      rules: { threshold_percent: 80, majority_hold_seconds: 1_209_600, flag_interval: 256 },
      counts: { enabled: 0, majority: 0, voting: 0, obsolete: 0, unknown: 0 },
      count: 0,
      amendments: [],
    });
    expect(keys(empty)).toEqual(['result', 'rules', 'counts', 'count', 'amendments']);
  });
});

// -- the detail --------------------------------------------------------------------------------------------------------

describe('buildAmendmentDetail', () => {
  const assembly = assemble();
  const list = buildAmendmentsBody(assembly, XRPL);
  const viewOf = (ref: string): AmendmentView => {
    const found = assembly.byId.get(ref);
    if (!found) throw new Error(`no ${ref}`);
    return found;
  };
  const points: RoundPoint[] = [
    {
      ledgerIndex: 107_747_839,
      flagLedger: 107_747_840,
      date: NOW_S - 1000,
      yes: 1,
      trusted: 4,
      threshold: 3,
      passes: false,
    },
    {
      ledgerIndex: 107_748_095,
      flagLedger: 107_748_096,
      date: NOW_S - 400,
      yes: 4,
      trusted: 4,
      threshold: 3,
      passes: true,
    },
  ];
  const detail = (ref: string, rounds: RoundPoint[] = points) =>
    buildAmendmentDetail(assembly, XRPL, viewOf(ref), rounds);

  it('has the keys of AMENDMENT_DETAIL_KEYS in order, the ones with a value only', () => {
    const d = detail(ID.majority);
    expect(keys(d)).toEqual([
      'ledger_index',
      'rules',
      'round',
      'next_flag_ledger',
      'id',
      'name',
      'status',
      'introduced',
      'votes',
      'majority',
      'unl_votes',
      'other_votes',
      'rounds',
      'history',
      'result',
    ]);
    expect(keys(d).filter((k) => !(AMENDMENT_DETAIL_KEYS as readonly string[]).includes(k))).toEqual([]);
    expect(d.result).toBe('success');
  });

  it('repeats the envelope of the list: ledger_index, rules, round, next_flag_ledger (G3)', () => {
    const d = detail(ID.voting);
    expect(d.ledger_index).toEqual(list.ledger_index);
    expect(d.rules).toEqual(list.rules);
    expect(d.round).toEqual(list.round);
    expect(d.next_flag_ledger).toEqual(list.next_flag_ledger);
  });

  it('has the row of the list for the amendment', () => {
    const d = detail(ID.majority);
    const { id, name, status, introduced, votes, majority } = list.amendments.find((a) => a.id === ID.majority) ?? {};
    expect({
      id: d.id,
      name: d.name,
      status: d.status,
      introduced: d.introduced,
      votes: d.votes,
      majority: d.majority,
    }).toEqual({
      id,
      name,
      status,
      introduced,
      votes,
      majority,
    });
  });

  describe('unl_votes', () => {
    it('is every member of the UNL of the newest round, in the order of the validators list, as yes, no or none', () => {
      // a.example, b.example, then the rest by key
      expect(detail(ID.majority).unl_votes.map((v) => [v.validation_public_key, v.vote])).toEqual([
        ['nH01', 'yes'],
        ['nH02', 'yes'],
        ['nH03', 'no'],
        ['nH04', 'no'],
        ['nH05', 'none'],
      ]);
    });

    it('has the domain, the version and when the validator was last seen, each only when known', () => {
      const [first, second, third, fourth, fifth] = detail(ID.majority).unl_votes;
      expect(first).toEqual({
        validation_public_key: 'nH01',
        domain: 'a.example',
        vote: 'yes',
        version: '3.4.1',
        version_supports: false,
        last_seen: new Date(Math.round((NOW_S - 30 + 0.123) * 1000)).toISOString(),
      });
      expect(keys(first)).toEqual([...UNL_VOTE_KEYS]);
      expect(second).toMatchObject({ domain: 'b.example', version: '3.4.0', version_supports: false });
      // no domain, no version
      expect(keys(third)).toEqual(['validation_public_key', 'vote', 'last_seen']);
      expect(fourth).toMatchObject({ version: '3.5.0', version_supports: true });
      expect(keys(fifth)).toEqual(['validation_public_key', 'vote', 'last_seen']);
    });

    it('says whether the version of the validator carries the amendment: its version is at least the introduced one', () => {
      // BetaMajority was introduced in 3.5.0: 3.4.1 and 3.4.0 lack it, 3.5.0 has it
      const supports = detail(ID.majority).unl_votes.map((v) => v.version_supports);
      expect(supports).toEqual([false, false, undefined, true, undefined]);
      // AlphaVoting was introduced in 3.4.1
      expect(detail(ID.voting).unl_votes.map((v) => v.version_supports)).toEqual([
        true,
        false,
        undefined,
        true,
        undefined,
      ]);
    });

    it('has no version_supports for an amendment with no introduced version', () => {
      for (const v of detail(ID.majorityNameless).unl_votes) expect(v).not.toHaveProperty('version_supports');
      // the version itself is still there
      expect(detail(ID.majorityNameless).unl_votes[0].version).toBe('3.4.1');
    });

    it('counts a vote by the record the round counts, not by one the validator holds outside the UNL rounds', () => {
      const other = assemble(
        directoryOf({
          // nH02 voted for the amendment at the newest round, but the round has it on the negative UNL
          rounds: [{ ...ROUND, negativeUnl: ['nH02'] }],
        }),
      );
      const d = buildAmendmentDetail(other, XRPL, other.byId.get(ID.voting) as AmendmentView, []);
      expect(d.unl_votes.find((v) => v.validation_public_key === 'nH02')?.vote).toBe('none');
      expect(d.unl_votes.find((v) => v.validation_public_key === 'nH01')?.vote).toBe('yes');
    });

    it('reads an ID in a record in any case', () => {
      const written = assemble(
        directoryOf({
          votes: [
            vote('nH01', [ID.voting.toLowerCase()]),
            vote('nH02', [ID.voting]),
            vote('nH03', [ID.majority.toLowerCase()]),
          ],
        }),
      );
      const d = buildAmendmentDetail(written, XRPL, written.byId.get(ID.voting) as AmendmentView, []);
      expect(d.unl_votes.map((v) => v.vote)).toEqual(['yes', 'yes', 'no', 'none', 'none']);
    });

    it('puts a member that the directory does not know among those without a domain, by key', () => {
      const unknownMember = assemble(directoryOf({ rounds: [{ ...ROUND, unl: [...ROUND.unl, 'nH00', 'nH99'] }] }));
      const keysInOrder = buildAmendmentDetail(
        unknownMember,
        XRPL,
        unknownMember.byId.get(ID.voting) as AmendmentView,
        [],
      ).unl_votes.map((v) => v.validation_public_key);
      expect(keysInOrder).toEqual(['nH01', 'nH02', 'nH00', 'nH03', 'nH04', 'nH05', 'nH99']);
    });
  });

  describe('other_votes', () => {
    it('is the validators off the UNL seen in 24 h with a record, in the order of the list, as yes or no', () => {
      // nHO1 votes for the majority amendment, nHO2 for none; nHO3 was seen three days ago, nHO4 has no record
      expect(detail(ID.majority).other_votes.map((v) => [v.validation_public_key, v.vote])).toEqual([
        ['nHO1', 'yes'],
        ['nHO2', 'no'],
      ]);
    });

    it('has the shape of an unl vote', () => {
      const [first] = detail(ID.majority).other_votes;
      expect(first).toEqual({
        validation_public_key: 'nHO1',
        vote: 'yes',
        version: '3.4.1',
        version_supports: false,
        last_seen: new Date(Math.round((NOW_S - 60 + 0.123) * 1000)).toISOString(),
      });
      expect(keys(first)).toEqual(['validation_public_key', 'vote', 'version', 'version_supports', 'last_seen']);
    });
  });

  it('has no members when no round is stored', () => {
    const none = assemble(directoryOf({ rounds: [], votes: [] }));
    const d = buildAmendmentDetail(none, XRPL, none.byId.get(ID.voting) as AmendmentView, []);
    expect(d.unl_votes).toEqual([]);
    expect(d.other_votes).toEqual([]);
    expect(d).not.toHaveProperty('round');
  });

  it('has the rounds it is given, as dates, in the order of ROUND_POINT_KEYS', () => {
    const d = detail(ID.voting);
    expect(d.rounds).toEqual([
      {
        ledger_index: 107_747_839,
        flag_ledger: 107_747_840,
        date: new Date((NOW_S - 1000) * 1000).toISOString().slice(0, 19) + 'Z',
        yes: 1,
        trusted: 4,
        threshold: 3,
        passes: false,
      },
      {
        ledger_index: 107_748_095,
        flag_ledger: 107_748_096,
        date: new Date((NOW_S - 400) * 1000).toISOString().slice(0, 19) + 'Z',
        yes: 4,
        trusted: 4,
        threshold: 3,
        passes: true,
      },
    ]);
    expect(keys(d.rounds[0])).toEqual([...ROUND_POINT_KEYS]);
    expect(detail(ID.voting, []).rounds).toEqual([]);
  });

  it('has the history, oldest first, in the order of HISTORY_KEYS', () => {
    const withHistory = assemble(
      directoryOf(),
      sourcesOf({
        transactions: [
          { amendment: ID.voting, flags: 0x20000, ledgerIndex: 200, date: NOW_S - 100, txHash: 'B'.repeat(64) },
          { amendment: ID.voting, flags: GOT, ledgerIndex: 100, date: NOW_S - 200, txHash: 'A'.repeat(64) },
        ],
      }),
    );
    const d = buildAmendmentDetail(withHistory, XRPL, withHistory.byId.get(ID.voting) as AmendmentView, []);
    expect(d.history).toEqual([
      {
        event: 'got_majority',
        ledger_index: 100,
        date: new Date((NOW_S - 200) * 1000).toISOString().slice(0, 19) + 'Z',
        tx_hash: 'A'.repeat(64),
      },
      {
        event: 'lost_majority',
        ledger_index: 200,
        date: new Date((NOW_S - 100) * 1000).toISOString().slice(0, 19) + 'Z',
        tx_hash: 'B'.repeat(64),
      },
    ]);
    expect(keys(d.history[0])).toEqual([...HISTORY_KEYS]);
    expect(detail(ID.unknown).history).toEqual([]);
  });

  it('never has a null', () => {
    expect(JSON.stringify(detail(ID.majority))).not.toContain('null');
  });

  it('does not change the directory it was given', () => {
    const before = JSON.stringify([...assembly.directory.entries.values()]);
    detail(ID.majority);
    detail(ID.voting);
    expect(JSON.stringify([...assembly.directory.entries.values()])).toBe(before);
    expect(assembly.directory.ordered.map((e) => e.key)).toEqual([
      'nH01',
      'nH02',
      'nH03',
      'nH04',
      'nH05',
      'nHO1',
      'nHO2',
      'nHO3',
      'nHO4',
    ]);
  });
});
