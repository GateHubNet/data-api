import { StoredUnlList, VoteRow } from '@gatehub/data-api-shared';
import { HourSentinel, KeyHour, NO_AGREEMENT } from './agreement-windows';
import { assembleDirectory, Directory, DirectoryReads, Drops, PublisherRow, RoundInfo } from './directory';

const NOW = Date.UTC(2026, 9, 19, 15, 42, 53); // ms
const NOW_S = NOW / 1000;
const HOUR = 3600;
const NEWEST_HOUR = Date.UTC(2026, 9, 19, 14) / 1000;

const PUBLISHER_A = 'ED' + 'A1'.repeat(32);
const PUBLISHER_B = 'ED' + 'B2'.repeat(32);
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
const RELEASE = 0xc0;
const RC1 = 0x81;
const V341 = encode(3, 4, 1, RELEASE);
const V340 = encode(3, 4, 0, RELEASE);
const V360 = encode(3, 6, 0, RELEASE);
const V350RC1 = encode(3, 5, 0, RC1);

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

function publisher(id: string, over: Partial<PublisherRow> = {}): PublisherRow {
  return {
    id,
    url: `https://${id}`,
    publicKey: id === 'vl.ripple.com' ? PUBLISHER_A : PUBLISHER_B,
    threshold: 1,
    checked: NOW_S - 30,
    status: 'ok',
    error: '',
    ...over,
  };
}

function list(id: string, validators: string[], over: Partial<StoredUnlList> = {}): StoredUnlList {
  return {
    publisher: id,
    publisherKey: id === 'vl.ripple.com' ? PUBLISHER_A : PUBLISHER_B,
    sequence: 5,
    version: 1,
    expiration: NOW_S + 30 * 86_400,
    validators,
    fetchedAt: NOW_S - 120.5,
    ...over,
  };
}

/** `count` validator keys `nH01` ... */
const keys = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `nH${String(i + 1).padStart(2, '0')}`);

const seenRow = (key: string, ago = 60, first = NOW_S - 90 * 86_400) => ({
  key,
  firstSeen: first,
  lastSeen: NOW_S - ago,
});

function round(ledgerIndex: number, closeAgo: number, over: Partial<RoundInfo> = {}): RoundInfo {
  const unl = over.unl ?? [];
  return {
    ledgerIndex,
    closeTime: NOW_S - closeAgo,
    unlSize: unl.length,
    trusted: unl.length,
    threshold: Math.max(1, Math.floor((unl.length * 80) / 100)),
    observed: unl.length,
    unl,
    negativeUnl: [],
    fees: FEES,
    ...over,
  };
}

function vote(r: RoundInfo, key: string, over: Partial<VoteRow> = {}): VoteRow {
  return {
    ledger_index: r.ledgerIndex,
    validation_public_key: key,
    close_time: r.closeTime,
    full: 1,
    amendments: [],
    base_fee: null,
    reserve_base: null,
    reserve_inc: null,
    server_version: null,
    ...over,
  };
}

const entryOf = (directory: Directory, key: string) => {
  const entry = directory.entries.get(key);
  if (!entry) throw new Error(`no entry for ${key}`);
  return entry;
};

describe('assembleDirectory', () => {
  describe('entries', () => {
    it('is empty without any read', () => {
      const directory = assembleDirectory(reads());
      expect(directory.entries.size).toBe(0);
      expect(directory.ordered).toEqual([]);
      expect(directory.publishers).toEqual([]);
      expect(directory.trusted.size).toBe(0);
      expect(directory.threshold).toBeUndefined();
      expect(directory.quorum).toEqual({ value: 0, unlSize: 0, negativeOnUnl: 0 });
      expect(directory.builtAt).toBe(NOW);
      expect(directory.newestRound).toBeUndefined();
      expect(directory.newestFinalHour).toBeUndefined();
      expect(directory.latest).toBeUndefined();
    });

    it('merges validator_seen rows of a signing key into its master', () => {
      const directory = assembleDirectory(
        reads({
          manifestMap: [{ ephemeral_key: 'n9S1', master_key: 'nHM1' }],
          seen: [
            { key: 'nHM1', firstSeen: 1_000, lastSeen: 2_000 },
            { key: 'n9S1', firstSeen: 500, lastSeen: NOW_S - 10 },
          ],
        }),
      );
      expect([...directory.entries.keys()]).toEqual(['nHM1']);
      expect(entryOf(directory, 'nHM1')).toMatchObject({ key: 'nHM1', firstSeen: 500, lastSeen: NOW_S - 10 });
      expect(directory.signingToMaster.get('n9S1')).toBe('nHM1');
    });

    it('has an entry for every key of validator_seen and of the lists in use, seen or not', () => {
      const directory = assembleDirectory(
        reads({
          publishers: [publisher('vl.ripple.com')],
          lists: [list('vl.ripple.com', ['nHL1', 'nHL2'])],
          seen: [seenRow('nHL1'), seenRow('nHO1')],
        }),
      );
      expect([...directory.entries.keys()].sort()).toEqual(['nHL1', 'nHL2', 'nHO1']);
      expect(entryOf(directory, 'nHL2')).toMatchObject({
        key: 'nHL2',
        unl: true,
        listed: true,
        seen24h: false,
      });
      expect(entryOf(directory, 'nHL2').firstSeen).toBeUndefined();
      expect(entryOf(directory, 'nHL2').lastSeen).toBeUndefined();
    });

    it('is seen within 24 hours when last_seen is at most 24 h old, and listed when seen within 30 days or on a list', () => {
      const directory = assembleDirectory(
        reads({
          seen: [
            seenRow('nHA', 86_400 - 1),
            seenRow('nHB', 86_400 + 1),
            seenRow('nHC', 30 * 86_400 - 1),
            seenRow('nHD', 30 * 86_400 + 1),
          ],
        }),
      );
      expect(entryOf(directory, 'nHA')).toMatchObject({ seen24h: true, listed: true });
      expect(entryOf(directory, 'nHB')).toMatchObject({ seen24h: false, listed: true });
      expect(entryOf(directory, 'nHC')).toMatchObject({ seen24h: false, listed: true });
      expect(entryOf(directory, 'nHD')).toMatchObject({ seen24h: false, listed: false });
      expect(directory.ordered.map((entry) => entry.key)).toEqual(['nHA', 'nHB', 'nHC']);
    });

    it('lists a validator of a list as listed however long ago it was seen', () => {
      const directory = assembleDirectory(
        reads({
          publishers: [publisher('vl.ripple.com')],
          lists: [list('vl.ripple.com', ['nHL1'])],
          seen: [seenRow('nHL1', 40 * 86_400)],
        }),
      );
      expect(entryOf(directory, 'nHL1').listed).toBe(true);
    });

    it('orders the listed entries with a domain first, by lower-case domain then key, then the rest by key', () => {
      const directory = assembleDirectory(
        reads({
          seen: ['nHZ', 'nHY', 'nHX', 'nHW', 'nHV'].map((key) => seenRow(key)),
          manifests: [
            { masterKey: 'nHZ', sequence: 1, signingKey: 'n9z', domain: 'b.example', signingKeysSeen: 1 },
            { masterKey: 'nHY', sequence: 1, signingKey: 'n9y', domain: 'A.example', signingKeysSeen: 1 },
            { masterKey: 'nHX', sequence: 1, signingKey: 'n9x', domain: 'b.example', signingKeysSeen: 1 },
            { masterKey: 'nHW', sequence: 1, signingKey: 'n9w', signingKeysSeen: 1 },
          ],
        }),
      );
      expect(directory.ordered.map((entry) => entry.key)).toEqual(['nHY', 'nHX', 'nHZ', 'nHV', 'nHW']);
    });
  });

  describe('manifests', () => {
    it('takes the domain, the signing key and the manifest of an entry from its newest manifest', () => {
      const directory = assembleDirectory(
        reads({
          seen: [seenRow('nHM1')],
          manifests: [
            { masterKey: 'nHM1', sequence: 4, signingKey: 'n9S4', domain: 'northpeak.example', signingKeysSeen: 4 },
          ],
        }),
      );
      expect(entryOf(directory, 'nHM1')).toMatchObject({
        domain: 'northpeak.example',
        signingKey: 'n9S4',
        manifest: { sequence: 4, signingKey: 'n9S4', signingKeysSeen: 4, domain: 'northpeak.example' },
      });
    });

    it('has no domain, no signing key and no manifest for a validator without one', () => {
      const entry = entryOf(assembleDirectory(reads({ seen: [seenRow('nHM1')] })), 'nHM1');
      expect(entry.domain).toBeUndefined();
      expect(entry.signingKey).toBeUndefined();
      expect(entry.manifest).toBeUndefined();
      expect(entry.domainState).toBeUndefined();
    });

    it('treats an empty domain as none', () => {
      const entry = entryOf(
        assembleDirectory(
          reads({
            seen: [seenRow('nHM1')],
            manifests: [{ masterKey: 'nHM1', sequence: 1, signingKey: 'n9S1', domain: '', signingKeysSeen: 1 }],
          }),
        ),
        'nHM1',
      );
      expect(entry.domain).toBeUndefined();
      expect(entry.domainState).toBeUndefined();
      expect(entry.manifest).toEqual({ sequence: 1, signingKey: 'n9S1', signingKeysSeen: 1 });
    });
  });

  describe('domain verification', () => {
    const manifest = (domain: string) => ({
      masterKey: 'nHM1',
      sequence: 1,
      signingKey: 'n9S1',
      domain,
      signingKeysSeen: 1,
    });

    it('is pending, with the TOML address of the network, until the domain is checked', () => {
      const entry = entryOf(
        assembleDirectory(reads({ seen: [seenRow('nHM1')], manifests: [manifest('northpeak.example')] })),
        'nHM1',
      );
      expect(entry.domainState).toEqual({
        status: 'pending',
        tomlUrl: 'https://northpeak.example/.well-known/xrp-ledger.toml',
      });
    });

    it('uses the TOML path of the network (Xahau)', () => {
      const entry = entryOf(
        assembleDirectory(
          reads({
            software: 'xahaud',
            tomlPath: '/.well-known/xahau.toml',
            seen: [seenRow('nHM1')],
            manifests: [manifest('northpeak.example')],
          }),
        ),
        'nHM1',
      );
      expect(entry.domainState?.tomlUrl).toBe('https://northpeak.example/.well-known/xahau.toml');
    });

    it('is the newest result for the entry domain: verified, with the times and the accounts', () => {
      const entry = entryOf(
        assembleDirectory(
          reads({
            seen: [seenRow('nHM1')],
            manifests: [manifest('northpeak.example')],
            domains: [
              {
                key: 'nHM1',
                domain: 'northpeak.example',
                status: 'verified',
                reason: '',
                statusCode: 0,
                tomlUrl: 'https://northpeak.example/.well-known/xrp-ledger.toml',
                checked: 1_760_000_000.511,
                verified: 1_760_000_000.511,
                accounts: ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
              },
            ],
          }),
        ),
        'nHM1',
      );
      expect(entry.domainState).toEqual({
        status: 'verified',
        tomlUrl: 'https://northpeak.example/.well-known/xrp-ledger.toml',
        checked: 1_760_000_000.511,
        verified: 1_760_000_000.511,
        accounts: ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
      });
    });

    it('is unverified with its reason and the HTTP status; empty reason, status code 0 and no accounts are absent', () => {
      const row = {
        key: 'nHM1',
        domain: 'northpeak.example',
        tomlUrl: 'https://northpeak.example/.well-known/xrp-ledger.toml',
        checked: 1_760_000_000,
        accounts: [] as string[],
      };
      const entry = (domains: DirectoryReads['domains']) =>
        entryOf(
          assembleDirectory(reads({ seen: [seenRow('nHM1')], manifests: [manifest('northpeak.example')], domains })),
          'nHM1',
        ).domainState;
      expect(entry([{ ...row, status: 'unverified', reason: 'http_status', statusCode: 404 }])).toEqual({
        status: 'unverified',
        reason: 'http_status',
        statusCode: 404,
        tomlUrl: row.tomlUrl,
        checked: 1_760_000_000,
      });
      expect(entry([{ ...row, status: 'unverified', reason: 'not_listed', statusCode: 0 }])).toEqual({
        status: 'unverified',
        reason: 'not_listed',
        tomlUrl: row.tomlUrl,
        checked: 1_760_000_000,
      });
    });

    it('ignores the result for another domain of the key (the domain changed) and for another key', () => {
      const entry = entryOf(
        assembleDirectory(
          reads({
            seen: [seenRow('nHM1')],
            manifests: [manifest('new.example')],
            domains: [
              {
                key: 'nHM1',
                domain: 'old.example',
                status: 'verified',
                reason: '',
                statusCode: 0,
                tomlUrl: 'https://old.example/.well-known/xrp-ledger.toml',
                checked: 1,
                verified: 1,
                accounts: [],
              },
              {
                key: 'nHOTHER',
                domain: 'new.example',
                status: 'verified',
                reason: '',
                statusCode: 0,
                tomlUrl: 'https://new.example/.well-known/xrp-ledger.toml',
                checked: 1,
                verified: 1,
                accounts: [],
              },
            ],
          }),
        ),
        'nHM1',
      );
      expect(entry.domainState).toEqual({
        status: 'pending',
        tomlUrl: 'https://new.example/.well-known/xrp-ledger.toml',
      });
    });
  });

  describe('publishers and the trusted UNL', () => {
    const THIRTY_FIVE = keys(35);

    it('trusts the validators named by the lists in use at now, and finds the threshold in the publisher rows', () => {
      const directory = assembleDirectory(
        reads({
          publishers: [publisher('unl.xrplf.org', { threshold: 2 }), publisher('vl.ripple.com', { threshold: 2 })],
          lists: [list('vl.ripple.com', ['nHA', 'nHB']), list('unl.xrplf.org', ['nHB', 'nHC'])],
        }),
      );
      expect(directory.threshold).toBe(2);
      expect([...directory.trusted]).toEqual(['nHB']);
      expect(entryOf(directory, 'nHB')).toMatchObject({ unl: true, unlLists: ['unl.xrplf.org', 'vl.ripple.com'] });
      expect(entryOf(directory, 'nHA')).toMatchObject({ unl: false, unlLists: ['vl.ripple.com'] });
      expect(directory.quorum).toEqual({ value: 1, unlSize: 1, negativeOnUnl: 0 });
    });

    it('lists the publishers in the order of the rows, with the list in use and its status', () => {
      const directory = assembleDirectory(
        reads({
          publishers: [publisher('unl.xrplf.org'), publisher('vl.ripple.com')],
          lists: [list('vl.ripple.com', ['nHA'], { sequence: 85 })],
        }),
      );
      expect(directory.publishers.map((p) => [p.id, p.status])).toEqual([
        ['unl.xrplf.org', 'unavailable'],
        ['vl.ripple.com', 'ok'],
      ]);
      expect(directory.publishers[1]).toMatchObject({
        id: 'vl.ripple.com',
        url: 'https://vl.ripple.com',
        publicKey: PUBLISHER_A,
        list: { sequence: 85, validators: ['nHA'] },
      });
      expect(directory.publishers[0].list).toBeUndefined();
      expect(directory.publishers[0].seen24h).toBeUndefined();
    });

    it('serves an expired list, still used, as expired', () => {
      const directory = assembleDirectory(
        reads({
          publishers: [publisher('vl.ripple.com')],
          lists: [list('vl.ripple.com', ['nHA'], { expiration: NOW_S - 1 })],
        }),
      );
      expect(directory.publishers[0].status).toBe('expired');
      expect([...directory.trusted]).toEqual(['nHA']);
    });

    it('counts the validators of a list seen in 24 hours', () => {
      const directory = assembleDirectory(
        reads({
          publishers: [publisher('vl.ripple.com')],
          lists: [list('vl.ripple.com', ['nHA', 'nHB', 'nHC'])],
          seen: [seenRow('nHA'), seenRow('nHB', 2 * 86_400)],
        }),
      );
      expect(directory.publishers[0].seen24h).toBe(1);
    });

    it('reports a failed newest attempt: the reason and when, even though an older list is in use', () => {
      const directory = assembleDirectory(
        reads({
          publishers: [
            publisher('vl.ripple.com', { status: 'error', error: 'signature_invalid', checked: NOW_S - 600.25 }),
          ],
          lists: [list('vl.ripple.com', ['nHA'])],
        }),
      );
      expect(directory.publishers[0]).toMatchObject({
        status: 'ok',
        lastError: 'signature_invalid',
        lastErrorAt: NOW_S - 600.25,
      });
      const ok = assembleDirectory(reads({ publishers: [publisher('vl.ripple.com')], lists: [] }));
      expect(ok.publishers[0].lastError).toBeUndefined();
      expect(ok.publishers[0].lastErrorAt).toBeUndefined();
    });

    it('uses only the lists served under the configured key of the publisher ("in use now")', () => {
      const old = list('vl.ripple.com', ['nHOLD'], { publisherKey: 'ED' + 'FF'.repeat(32), sequence: 900 });
      const current = list('vl.ripple.com', ['nHNEW'], { sequence: 3 });
      const directory = assembleDirectory(reads({ publishers: [publisher('vl.ripple.com')], lists: [old, current] }));
      expect(directory.publishers[0].list?.sequence).toBe(3);
      expect([...directory.trusted]).toEqual(['nHNEW']);
      expect(directory.entries.has('nHOLD')).toBe(false);
    });

    it('is unavailable, with no trusted validator, when every stored list was served under a key the publisher no longer uses', () => {
      const old = list('vl.ripple.com', ['nHOLD1', 'nHOLD2'], { publisherKey: 'ED' + 'FF'.repeat(32) });
      const directory = assembleDirectory(reads({ publishers: [publisher('vl.ripple.com')], lists: [old] }));
      expect(directory.publishers[0].status).toBe('unavailable');
      expect(directory.publishers[0].list).toBeUndefined();
      expect(directory.trusted.size).toBe(0);
      expect(directory.entries.size).toBe(0);
    });

    it('compares the key of a list with the configured key without regard to case, and ignores a list without a key', () => {
      const lower = list('vl.ripple.com', ['nHA'], { publisherKey: PUBLISHER_A.toLowerCase() });
      const keyless = { ...list('vl.ripple.com', ['nHB'], { sequence: 99 }), publisherKey: undefined };
      const directory = assembleDirectory(reads({ publishers: [publisher('vl.ripple.com')], lists: [lower, keyless] }));
      expect([...directory.trusted]).toEqual(['nHA']);
    });

    it('is unavailable with no trusted validators and quorum 0 when no publisher has a list', () => {
      const directory = assembleDirectory(
        reads({ publishers: [publisher('vl.ripple.com'), publisher('unl.xrplf.org')], lists: [] }),
      );
      expect(directory.trusted.size).toBe(0);
      expect(directory.quorum).toEqual({ value: 0, unlSize: 0, negativeOnUnl: 0 });
      expect(directory.threshold).toBe(1);
    });

    it('derives the quorum from the trusted UNL and the negative UNL members on it: 28 of 35', () => {
      const state = {
        ledgerIndex: 107_748_183,
        amendments: [],
        majorities: [],
        negativeUnl: [
          { key: THIRTY_FIVE[3], firstLedger: 107_000_000 },
          { key: 'nHNOTONUNL', firstLedger: 107_000_001 },
        ],
        fees: FEES,
        nodeQuorum: 0,
      };
      const directory = assembleDirectory(
        reads({ publishers: [publisher('vl.ripple.com')], lists: [list('vl.ripple.com', THIRTY_FIVE)], state }),
      );
      expect(directory.quorum).toEqual({ value: 28, unlSize: 35, negativeOnUnl: 1 });
      expect(entryOf(directory, THIRTY_FIVE[3]).negativeUnl).toBe(true);
      expect(entryOf(directory, THIRTY_FIVE[4]).negativeUnl).toBe(false);
    });

    it('takes 60 % of the UNL as the floor of the quorum: 30 trusted, 10 of them on the negative UNL', () => {
      const thirty = keys(30);
      const state = {
        ledgerIndex: 1,
        amendments: [],
        majorities: [],
        negativeUnl: thirty.slice(0, 10).map((key) => ({ key, firstLedger: 1 })),
        fees: FEES,
        nodeQuorum: 0,
      };
      const directory = assembleDirectory(
        reads({ publishers: [publisher('vl.ripple.com')], lists: [list('vl.ripple.com', thirty)], state }),
      );
      // max(ceil(0.8 * 20), ceil(0.6 * 30)) = max(16, 18)
      expect(directory.quorum).toEqual({ value: 18, unlSize: 30, negativeOnUnl: 10 });
    });

    it('reports the quorum of the node only when it is above 0', () => {
      const state = (nodeQuorum: number) => ({
        ledgerIndex: 1,
        amendments: [],
        majorities: [],
        negativeUnl: [],
        fees: FEES,
        nodeQuorum,
      });
      const base = { publishers: [publisher('vl.ripple.com')], lists: [list('vl.ripple.com', THIRTY_FIVE)] };
      expect(assembleDirectory(reads({ ...base, state: state(28) })).quorum).toEqual({
        value: 28,
        unlSize: 35,
        negativeOnUnl: 0,
        node: 28,
      });
      expect('node' in assembleDirectory(reads({ ...base, state: state(0) })).quorum).toBe(false);
      expect('node' in assembleDirectory(reads({ ...base })).quorum).toBe(false);
    });
  });

  describe('votes and fees', () => {
    const K1 = 'nHK1';
    const K2 = 'nHK2';
    const K3 = 'nHK3';
    const older = round(107_747_839, 1_400, { unl: [K1, K2] });
    const newest = round(107_748_095, 400, { unl: [K1, K2], negativeUnl: [K1] });
    const base = (over: Partial<DirectoryReads> = {}) =>
      reads({
        rounds: [older, newest],
        seen: [seenRow(K1), seenRow(K2), seenRow(K3)],
        ...over,
      });

    it('takes the newest round as the newest round', () => {
      const directory = assembleDirectory(base());
      expect(directory.newestRound).toEqual(newest);
    });

    it('differs between the record and the counted record for a member on the negative UNL', () => {
      const votes = [
        vote(older, K1, { amendments: ['AA'] }),
        vote(newest, K1, { amendments: ['BB'] }),
        vote(older, K2, { amendments: ['AA'] }),
        vote(newest, K2, { amendments: ['BB'] }),
        vote(newest, K3, { amendments: ['CC'] }),
      ];
      const directory = assembleDirectory(base({ votes }));
      // the record counts everybody (3.0): the newest full vote
      expect(entryOf(directory, K1).record).toMatchObject({ ledger_index: newest.ledgerIndex, amendments: ['BB'] });
      // the counted record skips the round at which K1 was on the negative UNL
      expect(entryOf(directory, K1).countedRecord).toMatchObject({
        ledger_index: older.ledgerIndex,
        amendments: ['AA'],
      });
      // a member off the negative UNL has the same record and counted record
      expect(entryOf(directory, K2).record?.ledger_index).toBe(newest.ledgerIndex);
      expect(entryOf(directory, K2).countedRecord?.ledger_index).toBe(newest.ledgerIndex);
      // a validator that is not a member of the newest round's UNL has a record and no counted record
      expect(entryOf(directory, K3).record?.ledger_index).toBe(newest.ledgerIndex);
      expect(entryOf(directory, K3).countedRecord).toBeUndefined();
    });

    it('has neither record nor fees for a validator without a full vote', () => {
      const partial = vote(newest, K2, { full: 0 });
      const directory = assembleDirectory(base({ votes: [partial] }));
      expect(entryOf(directory, K2).record).toBeUndefined();
      expect(entryOf(directory, K2).countedRecord).toBeUndefined();
      expect(entryOf(directory, K2).recordFees).toBeUndefined();
    });

    it('does not count a vote that closed more than 24 hours before the newest round', () => {
      const stale = round(107_000_000, 400 + 86_401, { unl: [K2] });
      const directory = assembleDirectory(base({ rounds: [stale, newest], votes: [vote(stale, K2)] }));
      expect(entryOf(directory, K2).record).toBeUndefined();
    });

    it('fills absent fee fields: recordFees takes the fees in force at the round of the record for the ones a vote leaves out', () => {
      const votes = [
        vote(newest, K1, { base_fee: '12' }),
        vote(newest, K2, { base_fee: '12', reserve_base: '2000000', reserve_inc: '300000' }),
        vote(newest, K3),
      ];
      const directory = assembleDirectory(base({ votes }));
      expect(entryOf(directory, K1).recordFees).toEqual({
        base_fee: '12',
        reserve_base: '1000000',
        reserve_inc: '200000',
      });
      expect(entryOf(directory, K2).recordFees).toEqual({
        base_fee: '12',
        reserve_base: '2000000',
        reserve_inc: '300000',
      });
      expect(entryOf(directory, K3).recordFees).toEqual(FEES);
    });

    it('takes the fees from the round of the record, not of the newest round', () => {
      const olderFees = { ...older, fees: { base_fee: '15', reserve_base: '5000000', reserve_inc: '500000' } };
      const directory = assembleDirectory(
        base({ rounds: [olderFees, newest], votes: [vote(olderFees, K2, { reserve_inc: '1' })] }),
      );
      expect(entryOf(directory, K2).recordFees).toEqual({ base_fee: '15', reserve_base: '5000000', reserve_inc: '1' });
    });

    it('has no record fees when the round of the record is unknown', () => {
      const orphan = vote(round(107_747_000, 500), K3);
      const directory = assembleDirectory(base({ votes: [orphan] }));
      expect(entryOf(directory, K3).record).toMatchObject({ ledger_index: 107_747_000 });
      expect(entryOf(directory, K3).recordFees).toBeUndefined();
    });
  });

  describe('versions', () => {
    const state = (list_: string[]) =>
      reads({
        publishers: [publisher('vl.ripple.com')],
        lists: [list('vl.ripple.com', list_)],
        seen: ['nHU1', 'nHU2', 'nHU3', 'nHO1', 'nHO2'].map((key) => seenRow(key)),
      });

    it('decodes the newest server version of a validator', () => {
      const directory = assembleDirectory({
        ...state(['nHU1']),
        versions: [{ key: 'nHU1', serverVersion: V341, recent: [V341] }],
      });
      expect(entryOf(directory, 'nHU1').version).toMatchObject({ version: '3.4.1', release: true });
      expect(entryOf(directory, 'nHU1').serverVersion).toBe(V341);
    });

    it('decodes with the software of the network: xahaud has the year offset and the build', () => {
      const xahau = encode(3, 10, 13, 0, 4119);
      const directory = assembleDirectory({
        ...state(['nHU1']),
        software: 'xahaud',
        versions: [{ key: 'nHU1', serverVersion: xahau, recent: [xahau] }],
      });
      expect(entryOf(directory, 'nHU1').version).toMatchObject({ version: '2026.10.13', build: 4119, release: true });
      expect(directory.latest).toMatchObject({ version: '2026.10.13', build: 4119 });
    });

    it('has no version for a server version that is not one (a foreign prefix), but keeps what was reported', () => {
      const foreign = '1311676707215769600';
      const directory = assembleDirectory({
        ...state(['nHU1']),
        versions: [{ key: 'nHU1', serverVersion: foreign, recent: [foreign] }],
      });
      expect(entryOf(directory, 'nHU1').version).toBeUndefined();
      expect(entryOf(directory, 'nHU1').versionLatest).toBeUndefined();
      expect(entryOf(directory, 'nHU1').serverVersion).toBe(foreign);
    });

    it('takes the latest version from release builds of trusted validators: latest ignores rc and non-UNL builds', () => {
      const directory = assembleDirectory({
        ...state(['nHU1', 'nHU2', 'nHU3']),
        versions: [
          // a release and an rc in the last 24 h: only the release counts for the latest
          { key: 'nHU1', serverVersion: V341, recent: [V341, V350RC1] },
          { key: 'nHU2', serverVersion: V340, recent: [V340] },
          // only a release candidate
          { key: 'nHU3', serverVersion: V350RC1, recent: [V350RC1] },
          // not on the UNL: a newer release does not count
          { key: 'nHO1', serverVersion: V360, recent: [V360] },
        ],
      });
      expect(directory.latest).toMatchObject({ version: '3.4.1', release: true });
    });

    it('has no latest version without a release build of a trusted validator in the last 24 h', () => {
      const directory = assembleDirectory({
        ...state(['nHU1']),
        versions: [
          { key: 'nHU1', serverVersion: V341, recent: [] },
          { key: 'nHO1', serverVersion: V360, recent: [V360] },
        ],
      });
      expect(directory.latest).toBeUndefined();
      // and no validator is then the latest
      expect(entryOf(directory, 'nHU1').versionLatest).toBe(false);
      expect(entryOf(directory, 'nHO1').versionLatest).toBe(false);
    });

    it('is the latest version for a triple at or above the latest, rc and other UNL included', () => {
      const directory = assembleDirectory({
        ...state(['nHU1', 'nHU2', 'nHU3']),
        versions: [
          { key: 'nHU1', serverVersion: V341, recent: [V341] },
          { key: 'nHU2', serverVersion: V340, recent: [V340] },
          { key: 'nHU3', serverVersion: V350RC1, recent: [V350RC1] },
          { key: 'nHO1', serverVersion: V360, recent: [V360] },
        ],
      });
      expect(entryOf(directory, 'nHU1').versionLatest).toBe(true);
      expect(entryOf(directory, 'nHU2').versionLatest).toBe(false);
      expect(entryOf(directory, 'nHU3').versionLatest).toBe(true);
      expect(entryOf(directory, 'nHO1').versionLatest).toBe(true);
      // a validator without a version has no versionLatest
      expect(entryOf(directory, 'nHO2').versionLatest).toBeUndefined();
    });
  });

  describe('activity', () => {
    it('gives the newest ledger of a validator and whether the validation there is partial', () => {
      const directory = assembleDirectory(
        reads({
          seen: [seenRow('nHA'), seenRow('nHB'), seenRow('nHC')],
          activity: [
            { key: 'nHA', ledgerIndex: 107_748_183, full: true },
            { key: 'nHB', ledgerIndex: 107_748_182, full: false },
          ],
        }),
      );
      expect(entryOf(directory, 'nHA')).toMatchObject({ currentIndex: 107_748_183, partial: false });
      expect(entryOf(directory, 'nHB')).toMatchObject({ currentIndex: 107_748_182, partial: true });
      expect(entryOf(directory, 'nHC').currentIndex).toBeUndefined();
      expect(entryOf(directory, 'nHC').partial).toBeUndefined();
    });
  });

  describe('agreement', () => {
    const sentinels = new Map<number, HourSentinel>(
      Array.from({ length: 720 }, (_, i) => [
        NEWEST_HOUR - (719 - i) * HOUR,
        { final: true, ledgers: 900, unobserved: 0 },
      ]),
    );
    const rowsOfKey = new Map<number, KeyHour>(
      [...sentinels.keys()].map((hour) => [hour, { agreed: 899, missed: 1, partial: 0 }]),
    );

    it('answers the three windows and the 30 days of every entry from the newest final hour', () => {
      const directory = assembleDirectory(
        reads({ seen: [seenRow('nHA'), seenRow('nHB')], sentinels, hourly: new Map([['nHA', rowsOfKey]]) }),
      );
      expect(directory.newestFinalHour).toBe(NEWEST_HOUR);
      const entry = entryOf(directory, 'nHA');
      expect(entry.agreement1h).toEqual({ missed: 1, total: 900, score: '0.9989', incomplete: false, partial: 0 });
      expect(entry.agreement24h.total).toBe(21_600);
      expect(entry.agreement30d).toMatchObject({ total: 648_000, missed: 720, incomplete: false });
      expect(entry.daily).toHaveLength(30);
      expect(entry.daily[29].date).toBe('2026-10-19');
      // a validator without rows has the windows with no score
      expect(entryOf(directory, 'nHB').agreement24h).toEqual({ missed: 0, total: 0, incomplete: false, partial: 0 });
    });

    it('answers the placeholder windows, incomplete, and no days before any hour is final', () => {
      const entry = entryOf(assembleDirectory(reads({ seen: [seenRow('nHA')] })), 'nHA');
      expect(entry.agreement1h).toEqual({ missed: 0, total: 0, incomplete: true, partial: 0 });
      expect(entry.agreement24h).toEqual({ missed: 0, total: 0, incomplete: true, partial: 0 });
      expect(entry.agreement30d).toEqual({ missed: 0, total: 0, incomplete: true, partial: 0 });
      expect(entry.daily).toEqual([]);
    });
  });

  describe('read-only', () => {
    // the directory is shared by every request for 10 s: the types do not let a route change it in place
    it('has no field a route can assign: of the directory, an entry, a window or a publisher', () => {
      const directory = assembleDirectory(
        reads({
          publishers: [publisher('vl.ripple.com')],
          lists: [list('vl.ripple.com', ['nHA'])],
          seen: [seenRow('nHA')],
        }),
      );
      const mutate = (d: Directory): void => {
        // @ts-expect-error a field of the directory is read-only
        d.builtAt = 1;
        // @ts-expect-error a field of the directory is read-only
        d.quorum = { value: 0, unlSize: 0, negativeOnUnl: 0 };
        // @ts-expect-error the list order is a read-only array
        d.ordered.push(d.ordered[0]);
        // @ts-expect-error the list order is a read-only array
        d.ordered[0] = d.ordered[1];
        // @ts-expect-error a field of an entry is read-only
        d.ordered[0].unl = false;
        // @ts-expect-error a field of a window is read-only
        d.ordered[0].agreement24h.total = 1;
        // @ts-expect-error the days of an entry are a read-only array
        d.ordered[0].daily.push(d.ordered[0].daily[0]);
        // @ts-expect-error the lists of an entry are a read-only array
        d.ordered[0].unlLists.push('x');
        // @ts-expect-error a field of a publisher is read-only
        d.publishers[0].status = 'ok';
        // @ts-expect-error the publishers are a read-only array
        d.publishers.push(d.publishers[0]);
      };
      expect(mutate).toBeDefined();
      expect(directory.ordered).toHaveLength(1);
    });

    it('shares one frozen placeholder between the entries before any hour is final', () => {
      const directory = assembleDirectory(reads({ seen: [seenRow('nHA'), seenRow('nHB')] }));
      const [a, b] = [entryOf(directory, 'nHA'), entryOf(directory, 'nHB')];
      expect(a.agreement1h).toBe(NO_AGREEMENT);
      expect(b.agreement30d).toBe(NO_AGREEMENT);
      expect(Object.isFrozen(a.agreement24h)).toBe(true);
    });
  });

  describe('state and head', () => {
    it('passes the head and the state of the network through', () => {
      const head = { ledgerIndex: 107_748_183, closeTime: NOW_S - 8, spanSeconds: 3800, spanLedgers: 1000 };
      const state = {
        ledgerIndex: 107_748_180,
        amendments: ['AB'],
        majorities: [{ amendment: 'CD', since: 1_760_000_000 }],
        negativeUnl: [],
        toDisable: 'nHDIS',
        fees: FEES,
        nodeQuorum: 0,
      };
      const directory = assembleDirectory(reads({ head, state }));
      expect(directory.head).toEqual(head);
      expect(directory.state).toEqual(state);
    });

    it('has the ledger of the state as the head, without a close time, when no ledger is indexed', () => {
      const state = {
        ledgerIndex: 107_748_180,
        amendments: [],
        majorities: [],
        negativeUnl: [],
        fees: FEES,
        nodeQuorum: 0,
      };
      expect(assembleDirectory(reads({ state })).head).toEqual({ ledgerIndex: 107_748_180 });
      // a committed ledger wins, newer or not
      const head = { ledgerIndex: 107_748_100, closeTime: NOW_S - 8 };
      expect(assembleDirectory(reads({ state, head })).head).toEqual(head);
      expect(assembleDirectory(reads()).head).toBeUndefined();
    });

    it('finds the newest final hour and the latest version', () => {
      const directory = assembleDirectory(
        reads({ sentinels: new Map([[NEWEST_HOUR, { final: true, ledgers: 1, unobserved: 0 }]]) }),
      );
      expect(directory.newestFinalHour).toBe(NEWEST_HOUR);
    });
  });
});
