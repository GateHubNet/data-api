import { amendmentId, getNetworkProfile, NetworkName, parseAmendmentsConfig } from '@gatehub/data-api-shared';
import {
  AMENDMENT_STATUSES,
  AmendmentSources,
  AmendmentStatus,
  amendmentStatus,
  assembleAmendments,
  EnableTx,
  eventOfFlags,
  findAmendment,
  NodeFeature,
  parseStatuses,
  pctOf,
  roundPoints,
  StatusFacts,
  windowFloor,
} from './amendment-status';
import { assembleDirectory, Directory, DirectoryReads, NetworkStateInfo, RoundInfo } from './directory';

const NOW = Date.UTC(2026, 9, 19, 15, 42, 53); // ms
const NOW_S = NOW / 1000;
const FEES = { base_fee: '10', reserve_base: '1000000', reserve_inc: '200000' };
const GOT = 0x10000;
const LOST = 0x20000;

const id = (n: string): string => n.repeat(64).slice(0, 64).toUpperCase();
const config = (network: NetworkName, amendments: object[]) =>
  parseAmendmentsConfig({ network, updated: '2026-10-19', amendments }, getNetworkProfile(network));

// -- the facts of one amendment --------------------------------------------------------------------------------------

describe('amendmentStatus: the first match wins', () => {
  const none: StatusFacts = { inLedger: false, inMajorities: false, yes: 0, voted: false };
  const named: NodeFeature = { name: 'Fix', supported: true };

  it('is enabled when the ledger lists it, whatever else is true of it', () => {
    expect(amendmentStatus({ ...none, inLedger: true })).toBe('enabled');
    expect(amendmentStatus({ ...none, inLedger: true, inMajorities: true, meta: meta({ obsolete: true }) })).toBe(
      'enabled',
    );
  });

  it('is enabled when the file calls it retired (Xahau), listed or not', () => {
    expect(amendmentStatus({ ...none, meta: meta({ retired: true }) })).toBe('enabled');
    expect(amendmentStatus({ ...none, meta: meta({ retired: true, obsolete: true }) })).toBe('enabled');
  });

  it('is majority when the ledger has a majority for it, even one the file calls obsolete or the node does not support', () => {
    expect(amendmentStatus({ ...none, inMajorities: true })).toBe('majority');
    expect(amendmentStatus({ ...none, inMajorities: true, meta: meta({}), voted: true })).toBe('majority');
    expect(amendmentStatus({ ...none, inMajorities: true, meta: meta({ obsolete: true }) })).toBe('majority');
    expect(amendmentStatus({ ...none, inMajorities: true, feature: { name: 'Fix', supported: false } })).toBe(
      'majority',
    );
  });

  it('is obsolete when the file says so', () => {
    expect(amendmentStatus({ ...none, meta: meta({ obsolete: true }) })).toBe('obsolete');
    // a validator that still votes for it does not change what the file says
    expect(amendmentStatus({ ...none, meta: meta({ obsolete: true }), yes: 3, voted: true })).toBe('obsolete');
  });

  it('is obsolete when the node does not support it and no UNL validator votes yes in the newest round', () => {
    expect(amendmentStatus({ ...none, feature: { name: 'Gone', supported: false } })).toBe('obsolete');
    expect(amendmentStatus({ ...none, feature: { name: '', supported: false } })).toBe('obsolete');
    // other validators voting for it in the last 30 days do not count, only a yes of the UNL in the newest round
    expect(amendmentStatus({ ...none, feature: { name: 'Gone', supported: false }, voted: true })).toBe('obsolete');
  });

  it('stays voting when the node does not support it but a UNL validator votes yes in the newest round', () => {
    expect(amendmentStatus({ ...none, feature: { name: 'Gone', supported: false }, yes: 1, voted: true })).toBe(
      'voting',
    );
    expect(amendmentStatus({ ...none, feature: { name: '', supported: false }, yes: 2, voted: true })).toBe('voting');
  });

  it('is voting when the file or the node names it, or any validator voted for it in the last 30 days', () => {
    expect(amendmentStatus({ ...none, meta: meta({}) })).toBe('voting');
    expect(amendmentStatus({ ...none, feature: named })).toBe('voting');
    expect(amendmentStatus({ ...none, voted: true })).toBe('voting');
  });

  it('is unknown when it has no name anywhere and nobody voted for it', () => {
    expect(amendmentStatus(none)).toBe('unknown');
    // the node lists it without a name
    expect(amendmentStatus({ ...none, feature: { name: '', supported: true } })).toBe('unknown');
  });
});

function meta(over: object) {
  return config('xahau', [{ name: 'Probe', ...over }]).amendments[0];
}

describe('parseStatuses', () => {
  it('is none, meaning all, for a parameter that is missing or empty', () => {
    expect(parseStatuses(undefined)).toEqual([]);
    expect(parseStatuses('')).toEqual([]);
  });

  it('reads a comma list of the five words, in the order written, with spaces around a word allowed', () => {
    expect(parseStatuses('voting')).toEqual(['voting']);
    expect(parseStatuses('voting,majority')).toEqual(['voting', 'majority']);
    expect(parseStatuses(' enabled , obsolete ,unknown')).toEqual(['enabled', 'obsolete', 'unknown']);
    expect(parseStatuses('enabled,majority,voting,obsolete,unknown')).toEqual([...AMENDMENT_STATUSES]);
  });

  it('is undefined for anything else: another word, another case, an empty item', () => {
    for (const bad of ['nope', 'voting,nope', 'Voting', 'voting,', ',voting', 'voting,,majority', ' ', 'all']) {
      expect([bad, parseStatuses(bad)]).toEqual([bad, undefined]);
    }
  });
});

describe('eventOfFlags', () => {
  it('reads tfGotMajority, tfLostMajority and the plain enabling', () => {
    expect(eventOfFlags(GOT)).toBe('got_majority');
    expect(eventOfFlags(LOST)).toBe('lost_majority');
    expect(eventOfFlags(0)).toBe('enabled');
  });

  it('reads no event from any other flags', () => {
    expect(eventOfFlags(0x80000000)).toBeUndefined();
    expect(eventOfFlags(1)).toBeUndefined();
  });
});

// -- the percentage -----------------------------------------------------------------------------------------------------

describe('pctOf: yes over trusted, two decimals, half up', () => {
  it.each([
    [31, 35, 88.57],
    [4, 35, 11.43],
    [35, 35, 100],
    [0, 35, 0],
    [1, 3, 33.33],
    [2, 3, 66.67],
    // exact halves go up
    [1, 8, 12.5],
    [1, 32, 3.13],
    [5, 32, 15.63],
    [1, 16, 6.25],
  ])('%i of %i is %d', (yes, trusted, pct) => {
    expect(pctOf(yes, trusted)).toBe(pct);
  });

  it('is 0 when nobody is trusted', () => {
    expect(pctOf(0, 0)).toBe(0);
    expect(pctOf(3, 0)).toBe(0);
  });
});

// -- the assembly -------------------------------------------------------------------------------------------------------

const NAMES = {
  ledger: 'AlphaEnabled',
  meta: 'BetaEnabled',
  majority: 'GammaMajority',
  votingA: 'EpsilonVoting',
  votingFile: 'ZetaVoting',
  obsolete: 'KappaObsolete',
};
const ID = {
  ledger: amendmentId(NAMES.ledger),
  meta: amendmentId(NAMES.meta),
  majority: amendmentId(NAMES.majority),
  majorityNameless: id('A'),
  votingA: amendmentId(NAMES.votingA),
  votingFile: amendmentId(NAMES.votingFile),
  votingNode: id('B'),
  votingUnnamed: id('C'),
  votedNameless: id('D'),
  unknownListed: id('E'),
  obsoleteFile: amendmentId(NAMES.obsolete),
  obsoleteNode: id('F'),
  unsupportedButVoted: id('0'),
};

const ENABLE_AT = 200;
const ROUND: RoundInfo = {
  ledgerIndex: 1023,
  closeTime: NOW_S - 600,
  version: '1',
  unlSize: 36,
  trusted: 35,
  threshold: 28,
  observed: 35,
  unl: [],
  negativeUnl: [],
  fees: FEES,
};

function directoryOf(over: Partial<DirectoryReads> = {}, state?: Partial<NetworkStateInfo>): Directory {
  const stateInfo: NetworkStateInfo = {
    ledgerIndex: 1100,
    amendments: [ID.ledger, ID.meta],
    majorities: [
      { amendment: ID.majority, since: NOW_S - 3 * 86_400 },
      { amendment: ID.majorityNameless, since: NOW_S - 4 * 86_400 },
    ],
    negativeUnl: [],
    fees: FEES,
    nodeQuorum: 0,
    ...state,
  };
  return assembleDirectory({
    builtAt: NOW,
    software: 'rippled',
    tomlPath: '/.well-known/xrp-ledger.toml',
    head: { ledgerIndex: 1100, closeTime: NOW_S - 8, spanSeconds: 400, spanLedgers: 100 },
    state: stateInfo,
    publishers: [],
    lists: [],
    manifestMap: [],
    manifests: [],
    seen: [],
    activity: [],
    domains: [],
    sentinels: new Map(),
    hourly: new Map(),
    rounds: [ROUND],
    votes: [],
    versions: [],
    ...over,
  });
}

const fileEntries = [
  {
    name: NAMES.ledger,
    introduced: '1.12.0',
    xls: 'XLS-30',
    xls_url: 'https://github.com/XRPLF/XRPL-Standards/tree/master/XLS-0030-automated-market-maker',
    description: 'Enabled in the ledger.',
    enabled: { ledger_index: 100, date: '2024-03-22' },
  },
  { name: NAMES.meta, enabled: { ledger_index: 90, date: '2024-01-02' } },
  { name: NAMES.majority, introduced: '3.4.1' },
  { name: NAMES.votingA },
  { name: NAMES.votingFile },
  { name: NAMES.obsolete, obsolete: true },
];

function sources(over: Partial<AmendmentSources> = {}): AmendmentSources {
  return {
    config: config('xrpl', fileEntries),
    features: new Map<string, NodeFeature>([
      [ID.votingNode, { name: 'EtaNode', supported: true }],
      [ID.unknownListed, { name: '', supported: true }],
      [ID.obsoleteNode, { name: 'LambdaGone', supported: false }],
      [ID.unsupportedButVoted, { name: 'MuStillVoted', supported: false }],
      [ID.majority, { name: NAMES.majority, supported: true }],
    ]),
    voted: new Set([
      ID.majority,
      ID.votingA,
      ID.votingNode,
      ID.votingUnnamed,
      ID.votedNameless,
      ID.unsupportedButVoted,
    ]),
    yes: new Map([
      [ID.majority, 31],
      [ID.majorityNameless, 30],
      [ID.votingA, 4],
      [ID.votingNode, 4],
      [ID.votingUnnamed, 9],
      [ID.unsupportedButVoted, 2],
    ]),
    transactions: [
      { amendment: ID.ledger, flags: 0, ledgerIndex: ENABLE_AT, date: NOW_S - 1_000_000, txHash: 'H-ENABLE' },
      { amendment: ID.majority, flags: GOT, ledgerIndex: 500, date: NOW_S - 3 * 86_400 + 5, txHash: 'H-GOT-2' },
    ],
    majorityHoldSeconds: 1_209_600,
    ...over,
  };
}

const idsOf = (statuses: AmendmentStatus[], assembly = assembleAmendments(directoryOf(), sources())) =>
  assembly.amendments.filter((a) => statuses.includes(a.status)).map((a) => a.id);

describe('assembleAmendments', () => {
  const assembly = assembleAmendments(directoryOf(), sources());
  const view = (amendmentIdOrName: string) => {
    const found = assembly.byId.get(amendmentIdOrName);
    if (!found) throw new Error(`no ${amendmentIdOrName}`);
    return found;
  };

  it('has an amendment for every ID of the ledger state, the node, the file and the votes, once', () => {
    const expected = new Set([
      ID.ledger,
      ID.meta,
      ID.majority,
      ID.majorityNameless,
      ID.votingA,
      ID.votingFile,
      ID.votingNode,
      ID.votingUnnamed,
      ID.votedNameless,
      ID.unknownListed,
      ID.obsoleteFile,
      ID.obsoleteNode,
      ID.unsupportedButVoted,
    ]);
    expect(new Set(assembly.amendments.map((a) => a.id))).toEqual(expected);
    expect(assembly.amendments).toHaveLength(expected.size);
    expect([...assembly.byId.keys()].sort()).toEqual([...expected].sort());
    expect(assembly.directory).toBeDefined();
  });

  it('gives every amendment its status by the rules, and counts them', () => {
    const statusOf = (key: string) => view(key).status;
    expect(statusOf(ID.ledger)).toBe('enabled');
    expect(statusOf(ID.meta)).toBe('enabled');
    expect(statusOf(ID.majority)).toBe('majority');
    expect(statusOf(ID.majorityNameless)).toBe('majority');
    expect(statusOf(ID.votingA)).toBe('voting');
    expect(statusOf(ID.votingFile)).toBe('voting');
    expect(statusOf(ID.votingNode)).toBe('voting');
    expect(statusOf(ID.votingUnnamed)).toBe('voting');
    expect(statusOf(ID.unsupportedButVoted)).toBe('voting');
    expect(statusOf(ID.votedNameless)).toBe('voting');
    expect(statusOf(ID.unknownListed)).toBe('unknown');
    expect(statusOf(ID.obsoleteFile)).toBe('obsolete');
    expect(statusOf(ID.obsoleteNode)).toBe('obsolete');
    expect(assembly.counts).toEqual({ enabled: 2, majority: 2, voting: 6, obsolete: 2, unknown: 1 });
    expect(Object.keys(assembly.counts)).toEqual([...AMENDMENT_STATUSES]);
  });

  it('names an amendment by the file, else by the node when its name is not empty, else not at all', () => {
    expect(view(ID.ledger).name).toBe(NAMES.ledger);
    expect(view(ID.votingNode).name).toBe('EtaNode');
    expect(view(ID.unknownListed).name).toBeUndefined();
    expect(view(ID.majorityNameless).name).toBeUndefined();
    // the file wins over a different name of the node
    const other = assembleAmendments(
      directoryOf(),
      sources({ features: new Map([[ID.votingA, { name: 'Other', supported: true }]]) }),
    );
    expect(other.byId.get(ID.votingA)?.name).toBe(NAMES.votingA);
  });

  it('carries the file entry and what the node says about support', () => {
    expect(view(ID.ledger).meta).toMatchObject({ introduced: '1.12.0', xls: 'XLS-30' });
    expect(view(ID.votingNode).meta).toBeUndefined();
    expect(view(ID.votingNode).nodeSupported).toBe(true);
    expect(view(ID.obsoleteNode).nodeSupported).toBe(false);
    // the node lists it without a name: it is still the node's word on support
    expect(view(ID.unknownListed).nodeSupported).toBe(true);
    // not listed by the node
    expect(view(ID.votingA).nodeSupported).toBeUndefined();
  });

  describe('votes', () => {
    it('are the newest round for a majority, a voting and an unknown amendment: yes, trusted, needed, pct', () => {
      expect(view(ID.majority).votes).toEqual({ ledgerIndex: 1023, yes: 31, trusted: 35, needed: 29, pct: 88.57 });
      expect(view(ID.votingA).votes).toEqual({ ledgerIndex: 1023, yes: 4, trusted: 35, needed: 29, pct: 11.43 });
    });

    it('have yes 0 for an amendment with no tally row in the round', () => {
      expect(view(ID.votingFile).votes).toEqual({ ledgerIndex: 1023, yes: 0, trusted: 35, needed: 29, pct: 0 });
    });

    it('are left out of an enabled and an obsolete amendment', () => {
      expect(view(ID.ledger).votes).toBeUndefined();
      expect(view(ID.obsoleteFile).votes).toBeUndefined();
    });

    it('are left out when no round is stored', () => {
      const bare = assembleAmendments(directoryOf({ rounds: [] }), sources());
      for (const a of bare.amendments) expect(a.votes).toBeUndefined();
    });

    it('need 1 vote at one trusted validator and at none, and threshold + 1 above', () => {
      const needed = (trusted: number): number | undefined =>
        assembleAmendments(directoryOf({ rounds: [{ ...ROUND, trusted }] }), sources()).byId.get(ID.votingA)?.votes
          ?.needed;
      expect(needed(0)).toBe(1);
      expect(needed(1)).toBe(1);
      expect(needed(2)).toBe(2);
      expect(needed(5)).toBe(5);
      expect(needed(35)).toBe(29);
      expect(needed(36)).toBe(29);
    });

    it('have pct 0 when nobody is trusted', () => {
      const none = assembleAmendments(directoryOf({ rounds: [{ ...ROUND, trusted: 0 }] }), sources());
      expect(none.byId.get(ID.votingA)?.votes).toEqual({ ledgerIndex: 1023, yes: 4, trusted: 0, needed: 1, pct: 0 });
    });
  });

  describe('majority', () => {
    it('is since the close time of the Majorities entry, with the ledger and transaction of the newest indexed got_majority', () => {
      expect(view(ID.majority).majority).toEqual({
        since: NOW_S - 3 * 86_400,
        ledgerIndex: 500,
        txHash: 'H-GOT-2',
        expectedActivation: NOW_S - 3 * 86_400 + 1_209_600,
      });
    });

    it('takes the newest got_majority when there are several', () => {
      const several = assembleAmendments(
        directoryOf(),
        sources({
          transactions: [
            { amendment: ID.majority, flags: GOT, ledgerIndex: 300, date: 1, txHash: 'OLD' },
            { amendment: ID.majority, flags: LOST, ledgerIndex: 400, date: 2, txHash: 'LOST' },
            { amendment: ID.majority, flags: GOT, ledgerIndex: 500, date: 3, txHash: 'NEW' },
          ],
        }),
      );
      expect(several.byId.get(ID.majority)?.majority).toMatchObject({ ledgerIndex: 500, txHash: 'NEW' });
    });

    it('has neither ledger_index nor tx_hash when a lost_majority or an enabling is newer than the got_majority: a regain not indexed yet', () => {
      const after = (...later: EnableTx[]) =>
        assembleAmendments(
          directoryOf(),
          sources({
            transactions: [{ amendment: ID.majority, flags: GOT, ledgerIndex: 300, date: 1, txHash: 'GOT' }, ...later],
          }),
        ).byId.get(ID.majority)?.majority;
      const lost: EnableTx = { amendment: ID.majority, flags: LOST, ledgerIndex: 400, date: 2, txHash: 'LOST' };
      const enabled: EnableTx = { amendment: ID.majority, flags: 0, ledgerIndex: 450, date: 3, txHash: 'ENABLED' };
      for (const majority of [after(lost), after(enabled), after(lost, enabled)]) {
        expect(majority).toEqual({
          since: NOW_S - 3 * 86_400,
          expectedActivation: NOW_S - 3 * 86_400 + 1_209_600,
        });
      }
      // the regain, once indexed, is the one that shows; an event of another amendment is no later event of this one
      const regained: EnableTx = { amendment: ID.majority, flags: GOT, ledgerIndex: 500, date: 4, txHash: 'REGAIN' };
      expect(after(lost, regained)).toMatchObject({ ledgerIndex: 500, txHash: 'REGAIN' });
      const other: EnableTx = { amendment: ID.votingA, flags: LOST, ledgerIndex: 400, date: 2, txHash: 'OTHER' };
      expect(after(other)).toMatchObject({ ledgerIndex: 300, txHash: 'GOT' });
      // a lost_majority older than the got_majority does not matter
      const earlier: EnableTx = { amendment: ID.majority, flags: LOST, ledgerIndex: 200, date: 0, txHash: 'EARLIER' };
      expect(after(earlier)).toMatchObject({ ledgerIndex: 300, txHash: 'GOT' });
    });

    it('has neither ledger_index nor tx_hash when the EnableAmendment is not indexed (G5)', () => {
      const majority = view(ID.majorityNameless).majority;
      expect(majority).toEqual({
        since: NOW_S - 4 * 86_400,
        expectedActivation: NOW_S - 4 * 86_400 + 1_209_600,
      });
      expect(majority).not.toHaveProperty('ledgerIndex');
      expect(majority).not.toHaveProperty('txHash');
    });

    it('waits the hold of the network: 5 days on Xahau', () => {
      const xahau = assembleAmendments(directoryOf(), sources({ majorityHoldSeconds: 432_000 }));
      expect(xahau.byId.get(ID.majority)?.majority?.expectedActivation).toBe(NOW_S - 3 * 86_400 + 432_000);
    });

    it('belongs to a majority amendment only', () => {
      expect(view(ID.ledger).majority).toBeUndefined();
      expect(view(ID.votingA).majority).toBeUndefined();
    });
  });

  describe('enabled', () => {
    it('is the indexed EnableAmendment with flags 0: ledger, close time, transaction, source ledger', () => {
      expect(view(ID.ledger).enabled).toEqual({
        ledgerIndex: ENABLE_AT,
        date: new Date((NOW_S - 1_000_000) * 1000).toISOString().slice(0, 19) + 'Z',
        txHash: 'H-ENABLE',
        source: 'ledger',
      });
    });

    it('is the file when nothing is indexed: its ledger and day, source metadata', () => {
      expect(view(ID.meta).enabled).toEqual({ ledgerIndex: 90, date: '2024-01-02', source: 'metadata' });
    });

    it('has no date when the file gives only a ledger, and no ledger when it gives only a day', () => {
      const only = assembleAmendments(
        directoryOf(),
        sources({
          config: config('xrpl', [
            { name: NAMES.ledger, enabled: { ledger_index: 7 } },
            { name: NAMES.meta, enabled: { date: '2024-01-02' } },
          ]),
          transactions: [],
        }),
      );
      expect(only.byId.get(ID.ledger)?.enabled).toEqual({ ledgerIndex: 7, source: 'metadata' });
      expect(only.byId.get(ID.meta)?.enabled).toEqual({ date: '2024-01-02', source: 'metadata' });
    });

    it('is absent when neither the index nor the file knows it', () => {
      const bare = assembleAmendments(directoryOf(), sources({ transactions: [], config: config('xrpl', []) }));
      expect(bare.byId.get(ID.ledger)?.status).toBe('enabled');
      expect(bare.byId.get(ID.ledger)?.enabled).toBeUndefined();
    });

    it('is the enabling, not an earlier or later event of the same amendment', () => {
      const events = assembleAmendments(
        directoryOf(),
        sources({
          transactions: [
            { amendment: ID.ledger, flags: LOST, ledgerIndex: 150, date: 1, txHash: 'LOST' },
            { amendment: ID.ledger, flags: 0, ledgerIndex: 180, date: 2, txHash: 'ENABLED' },
            { amendment: ID.ledger, flags: GOT, ledgerIndex: 100, date: 3, txHash: 'GOT' },
          ],
        }),
      );
      expect(events.byId.get(ID.ledger)?.enabled).toMatchObject({ ledgerIndex: 180, txHash: 'ENABLED' });
    });

    it('belongs to an enabled amendment only', () => {
      expect(view(ID.votingA).enabled).toBeUndefined();
      expect(view(ID.majority).enabled).toBeUndefined();
    });
  });

  describe('a retired name (Xahau)', () => {
    const xahau = (over: Partial<AmendmentSources> = {}, state: Partial<NetworkStateInfo> = {}) =>
      assembleAmendments(
        directoryOf({}, { amendments: [], majorities: [], ...state }),
        sources({
          config: config('xahau', [
            { name: 'MultiSign', retired: true },
            { name: 'Escrow', retired: true, enabled: { ledger_index: 5, date: '2023-01-01' } },
          ]),
          features: new Map(),
          voted: new Set(),
          yes: new Map(),
          transactions: [],
          ...over,
        }),
      );

    it('is enabled and retired, with no enabled object', () => {
      const a = xahau().byId.get(amendmentId('MultiSign'));
      expect(a?.status).toBe('enabled');
      expect(a?.retired).toBe(true);
      expect(a?.enabled).toBeUndefined();
      expect(a?.votes).toBeUndefined();
    });

    it('has no enabled object from the file either: only the ledger can say when', () => {
      expect(xahau().byId.get(amendmentId('Escrow'))?.enabled).toBeUndefined();
    });

    it('has the enabled object of the ledger when it has one', () => {
      const a = xahau({
        transactions: [
          { amendment: amendmentId('MultiSign'), flags: 0, ledgerIndex: 60, date: NOW_S - 100, txHash: 'H' },
        ],
      }).byId.get(amendmentId('MultiSign'));
      expect(a).toMatchObject({ status: 'enabled', retired: true, enabled: { ledgerIndex: 60, source: 'ledger' } });
    });

    it('is not retired when it is not (the key is left out)', () => {
      expect(view(ID.ledger).retired).toBeUndefined();
    });
  });

  describe('history', () => {
    it('lists every indexed EnableAmendment of the amendment, oldest first, with its event', () => {
      const events = assembleAmendments(
        directoryOf(),
        sources({
          transactions: [
            { amendment: ID.majority, flags: GOT, ledgerIndex: 500, date: 50, txHash: 'C' },
            { amendment: ID.majority, flags: 0, ledgerIndex: 700, date: 70, txHash: 'D' },
            { amendment: ID.votingA, flags: GOT, ledgerIndex: 100, date: 10, txHash: 'X' },
            { amendment: ID.majority, flags: GOT, ledgerIndex: 300, date: 30, txHash: 'A' },
            { amendment: ID.majority, flags: LOST, ledgerIndex: 400, date: 40, txHash: 'B' },
          ],
        }),
      ).byId.get(ID.majority);
      expect(events?.history).toEqual([
        { event: 'got_majority', ledgerIndex: 300, date: 30, txHash: 'A' },
        { event: 'lost_majority', ledgerIndex: 400, date: 40, txHash: 'B' },
        { event: 'got_majority', ledgerIndex: 500, date: 50, txHash: 'C' },
        { event: 'enabled', ledgerIndex: 700, date: 70, txHash: 'D' },
      ]);
    });

    it('is empty without an indexed transaction, and counts a transaction read twice once', () => {
      expect(view(ID.votingA).history).toEqual([]);
      const twice: EnableTx = { amendment: ID.votingA, flags: GOT, ledgerIndex: 100, date: 10, txHash: 'X' };
      const once = assembleAmendments(directoryOf(), sources({ transactions: [twice, { ...twice }] }));
      expect(once.byId.get(ID.votingA)?.history).toHaveLength(1);
    });

    it('matches the amendment whatever the case of the ID in the transaction, and skips flags it does not know', () => {
      const lower = assembleAmendments(
        directoryOf(),
        sources({
          transactions: [
            { amendment: ID.votingA.toLowerCase(), flags: GOT, ledgerIndex: 100, date: 10, txHash: 'X' },
            { amendment: ID.votingA, flags: 0x80000000, ledgerIndex: 101, date: 11, txHash: 'Y' },
          ],
        }),
      );
      expect(lower.byId.get(ID.votingA)?.history.map((h) => h.txHash)).toEqual(['X']);
    });
  });

  describe('the case of an ID', () => {
    it('is upper case whatever the writer or the node wrote: every source gives the same amendments', () => {
      const lower = (ids: Iterable<string>) => [...ids].map((each) => each.toLowerCase());
      const base = sources();
      const written = assembleAmendments(
        directoryOf(
          {},
          {
            amendments: lower([ID.ledger, ID.meta]),
            majorities: [
              { amendment: ID.majority.toLowerCase(), since: NOW_S - 3 * 86_400 },
              { amendment: ID.majorityNameless.toLowerCase(), since: NOW_S - 4 * 86_400 },
            ],
          },
        ),
        {
          ...base,
          features: new Map([...base.features].map(([key, feature]) => [key.toLowerCase(), feature])),
          voted: new Set(lower(base.voted)),
          yes: new Map([...base.yes].map(([key, count]) => [key.toLowerCase(), count])),
          transactions: base.transactions.map((tx) => ({ ...tx, amendment: tx.amendment.toLowerCase() })),
        },
      );
      const expected = assembleAmendments(directoryOf(), base);
      expect(written.amendments).toEqual(expected.amendments);
      expect(written.counts).toEqual(expected.counts);
      expect([...written.byId.keys()]).toEqual([...expected.byId.keys()]);
      for (const each of written.amendments) expect(each.id).toBe(each.id.toUpperCase());
    });

    it('takes the larger of the yes counts of an ID written in both cases, not their sum', () => {
      const both = assembleAmendments(
        directoryOf(),
        sources({
          yes: new Map([
            [ID.votingA, 3],
            [ID.votingA.toLowerCase(), 4],
          ]),
        }),
      );
      expect(both.byId.get(ID.votingA)?.votes?.yes).toBe(4);
    });
  });

  describe('the order of the list', () => {
    it('is the groups majority, voting, unknown, enabled, obsolete', () => {
      const statuses = assembly.amendments.map((a) => a.status);
      const order = ['majority', 'voting', 'unknown', 'enabled', 'obsolete'];
      expect(statuses.map((s) => order.indexOf(s))).toEqual(statuses.map((s) => order.indexOf(s)).sort());
    });

    it('puts a majority by expected activation', () => {
      // the nameless one has had its majority one day longer: it activates first
      expect(idsOf(['majority'])).toEqual([ID.majorityNameless, ID.majority]);
    });

    it('puts a voting amendment by yes, most first, then by name, an unnamed one after the named by its ID', () => {
      // 9 (unnamed), then 4: EpsilonVoting before EtaNode, then 2, then 0
      expect(idsOf(['voting'])).toEqual([
        ID.votingUnnamed,
        ID.votingA,
        ID.votingNode,
        ID.unsupportedButVoted,
        ID.votingFile,
        ID.votedNameless,
      ]);
    });

    it('puts a voting amendment with the same yes: the named by name without regard to case, then the unnamed by ID', () => {
      const tied = assembleAmendments(
        directoryOf(),
        sources({
          config: config('xrpl', [{ name: 'beta' }, { name: 'Alpha' }, { name: 'alpha2' }]),
          features: new Map(),
          voted: new Set([id('9'), id('8')]),
          yes: new Map(),
          transactions: [],
        }),
      );
      const names = tied.amendments.filter((a) => a.status === 'voting').map((a) => a.name ?? a.id);
      expect(names).toEqual(['Alpha', 'alpha2', 'beta', id('8'), id('9')]);
    });

    it('puts an unknown amendment by ID', () => {
      const two = assembleAmendments(
        directoryOf(),
        sources({
          config: config('xrpl', []),
          features: new Map([
            [id('7'), { name: '', supported: true }],
            [id('2'), { name: '', supported: true }],
          ]),
          voted: new Set(),
          yes: new Map(),
          transactions: [],
        }),
      );
      expect(two.amendments.filter((a) => a.status === 'unknown').map((a) => a.id)).toEqual([id('2'), id('7')]);
    });

    it('puts an enabled amendment by its enabled ledger, newest first, those without a ledger last by name', () => {
      const enabledIn = (ledger: number | undefined, name: string) => ({
        name,
        ...(ledger === undefined ? {} : { enabled: { ledger_index: ledger, date: '2024-01-01' } }),
      });
      const entries = [
        enabledIn(undefined, 'Zulu'),
        enabledIn(10, 'Tango'),
        enabledIn(30, 'Echo'),
        enabledIn(30, 'Bravo'),
        enabledIn(undefined, 'Alpha'),
        enabledIn(20, 'Kilo'),
      ];
      const ledger = assembleAmendments(
        directoryOf({}, { amendments: entries.map((e) => amendmentId(e.name)), majorities: [] }),
        sources({
          config: config('xrpl', entries),
          features: new Map(),
          voted: new Set(),
          yes: new Map(),
          transactions: [],
        }),
      );
      expect(ledger.amendments.map((a) => a.name)).toEqual(['Bravo', 'Echo', 'Kilo', 'Tango', 'Alpha', 'Zulu']);
    });

    it('puts an indexed enabling before the file: the ledger of the transaction counts', () => {
      const entries = [{ name: 'Alpha', enabled: { ledger_index: 5, date: '2024-01-01' } }, { name: 'Bravo' }];
      const ledger = assembleAmendments(
        directoryOf({}, { amendments: entries.map((e) => amendmentId(e.name)), majorities: [] }),
        sources({
          config: config('xrpl', entries),
          features: new Map(),
          voted: new Set(),
          yes: new Map(),
          transactions: [{ amendment: amendmentId('Bravo'), flags: 0, ledgerIndex: 50, date: 1, txHash: 'B' }],
        }),
      );
      expect(ledger.amendments.map((a) => a.name)).toEqual(['Bravo', 'Alpha']);
    });

    it('puts an obsolete amendment by name, an unnamed one last', () => {
      const entries = [
        { name: 'Oscar', obsolete: true },
        { name: 'bravo', obsolete: true },
        { name: 'Alpha', obsolete: true },
      ];
      const obsolete = assembleAmendments(
        directoryOf({}, { amendments: [], majorities: [] }),
        sources({
          config: config('xrpl', entries),
          features: new Map([[id('1'), { name: '', supported: false }]]),
          voted: new Set(),
          yes: new Map(),
          transactions: [],
        }),
      );
      expect(obsolete.amendments.map((a) => a.name ?? a.id)).toEqual(['Alpha', 'bravo', 'Oscar', id('1')]);
    });
  });

  it('is an empty list, with zero counts, for a database that has nothing', () => {
    const empty = assembleAmendments(
      directoryOf({ rounds: [] }, { amendments: [], majorities: [] }),
      sources({ config: config('xrpl', []), features: new Map(), voted: new Set(), yes: new Map(), transactions: [] }),
    );
    expect(empty.amendments).toEqual([]);
    expect(empty.counts).toEqual({ enabled: 0, majority: 0, voting: 0, obsolete: 0, unknown: 0 });
  });

  it('reads the ledger state of the directory: no state is no enabled amendment and no majority', () => {
    const noState = assembleAmendments(
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
      sources(),
    );
    expect(noState.byId.get(ID.ledger)?.status).toBe('voting');
    expect(noState.counts.majority).toBe(0);
  });
});

// -- find ---------------------------------------------------------------------------------------------------------------

describe('findAmendment', () => {
  const entries = [{ name: 'AMM' }, { name: 'Amm' }, { name: 'fixAMM' }, { name: 'Checks' }];
  const assembly = assembleAmendments(
    directoryOf({}, { amendments: [], majorities: [] }),
    sources({
      config: config('xrpl', entries),
      features: new Map(),
      voted: new Set(),
      yes: new Map(),
      transactions: [],
    }),
  );
  const found = (ref: string) => findAmendment(assembly, ref)?.id;

  it('finds a name exactly, even when another name differs only in case', () => {
    expect(found('AMM')).toBe(amendmentId('AMM'));
    expect(found('Amm')).toBe(amendmentId('Amm'));
  });

  it('finds a name in any case when only one amendment has it', () => {
    expect(found('checks')).toBe(amendmentId('Checks'));
    expect(found('FIXAMM')).toBe(amendmentId('fixAMM'));
  });

  it('finds nothing for a case variant that two names share', () => {
    expect(found('aMM')).toBeUndefined();
  });

  it('finds an ID in any case', () => {
    const upper = amendmentId('Checks');
    expect(found(upper)).toBe(upper);
    expect(found(upper.toLowerCase())).toBe(upper);
    expect(found(`${upper.slice(0, 32).toLowerCase()}${upper.slice(32)}`)).toBe(upper);
  });

  it('finds nothing for an unknown name or ID, a part of one, or text that is neither', () => {
    expect(found('Nope')).toBeUndefined();
    expect(found(amendmentId('Nope'))).toBeUndefined();
    expect(found(amendmentId('Checks').slice(1))).toBeUndefined();
    expect(found('')).toBeUndefined();
    expect(found('Check')).toBeUndefined();
  });

  it('finds an amendment with no name by its ID', () => {
    const nameless = assembleAmendments(
      directoryOf({}, { amendments: [id('A')], majorities: [] }),
      sources({ config: config('xrpl', []), features: new Map(), voted: new Set(), yes: new Map(), transactions: [] }),
    );
    expect(findAmendment(nameless, id('A').toLowerCase())?.id).toBe(id('A'));
  });
});

// -- the rounds of the window ------------------------------------------------------------------------------------------------

describe('roundPoints', () => {
  const rounds = [
    { ledgerIndex: 255, closeTime: 1000, trusted: 35, threshold: 28 },
    { ledgerIndex: 511, closeTime: 2000, trusted: 35, threshold: 28 },
    { ledgerIndex: 767, closeTime: 3000, trusted: 35, threshold: 28 },
  ];

  it('is one point per round, oldest first: the flag ledger after it, the close, the yes of its row or 0, whether it passes', () => {
    const yes = new Map([
      [255, 29],
      [767, 28],
    ]);
    expect(roundPoints(rounds, yes, { status: 'voting' })).toEqual([
      { ledgerIndex: 255, flagLedger: 256, date: 1000, yes: 29, trusted: 35, threshold: 28, passes: true },
      { ledgerIndex: 511, flagLedger: 512, date: 2000, yes: 0, trusted: 35, threshold: 28, passes: false },
      { ledgerIndex: 767, flagLedger: 768, date: 3000, yes: 28, trusted: 35, threshold: 28, passes: false },
    ]);
  });

  it('passes at trusted 1 with one yes, and not with none', () => {
    const one = [{ ledgerIndex: 255, closeTime: 1000, trusted: 1, threshold: 1 }];
    expect(roundPoints(one, new Map([[255, 1]]), { status: 'voting' })[0].passes).toBe(true);
    expect(roundPoints(one, new Map(), { status: 'voting' })[0].passes).toBe(false);
    // two trusted need more than the threshold of 1
    const two = [{ ledgerIndex: 255, closeTime: 1000, trusted: 2, threshold: 1 }];
    expect(roundPoints(two, new Map([[255, 1]]), { status: 'voting' })[0].passes).toBe(false);
    expect(roundPoints(two, new Map([[255, 2]]), { status: 'voting' })[0].passes).toBe(true);
  });

  it('cuts an enabled amendment at its enabled ledger: only the rounds before it', () => {
    const enabled = { status: 'enabled' as const, enabled: { ledgerIndex: 513, source: 'ledger' as const, date: 'x' } };
    // the round of 511 is the last before 513 (the voting ledger two before the ledger that enabled it)
    expect(roundPoints(rounds, new Map(), enabled).map((p) => p.ledgerIndex)).toEqual([255, 511]);
    expect(
      roundPoints(rounds, new Map(), { ...enabled, enabled: { ...enabled.enabled, ledgerIndex: 511 } }).map(
        (p) => p.ledgerIndex,
      ),
    ).toEqual([255]);
    expect(roundPoints(rounds, new Map(), { ...enabled, enabled: { ...enabled.enabled, ledgerIndex: 255 } })).toEqual(
      [],
    );
  });

  it('is empty for an enabled amendment whose enabled ledger is not known', () => {
    expect(roundPoints(rounds, new Map(), { status: 'enabled' })).toEqual([]);
    expect(
      roundPoints(rounds, new Map(), { status: 'enabled', enabled: { date: '2024-01-02', source: 'metadata' } }),
    ).toEqual([]);
  });

  it('is every round for an amendment that is not enabled', () => {
    expect(roundPoints(rounds, new Map(), { status: 'majority' })).toHaveLength(3);
    expect(roundPoints(rounds, new Map(), { status: 'obsolete' })).toHaveLength(3);
    expect(roundPoints(rounds, new Map(), { status: 'unknown' })).toHaveLength(3);
  });
});

describe('windowFloor', () => {
  it('is the lowest ledger a 30-day window can start at, counted back from the newest round', () => {
    expect(windowFloor(107_748_095)).toBe(107_748_095 - 30 * 86_400);
    expect(windowFloor(1000)).toBe(0);
  });
});
