import { getNetworkProfile, loadAmendmentsConfig, Table } from '@gatehub/data-api-shared';
import { join } from 'node:path';
import {
  AMENDMENT_DETAIL_KEYS,
  AMENDMENT_ROW_KEYS,
  AMENDMENT_VOTES_KEYS,
  AMENDMENTS_BODY_KEYS,
  ENABLED_KEYS,
  HISTORY_KEYS,
  MAJORITY_KEYS,
  ROUND_KEYS,
  ROUND_POINT_KEYS,
  UNL_VOTE_KEYS,
} from '../src/validators/amendment-object';
import type { Directory } from '../src/validators/directory';
import type { ValidatorDirectoryService } from '../src/validators/validator-directory.service';
import { ApiClient, Harness, HarnessOptions, NO_RATE_LIMIT, startHarness } from './harness';
import { csvDisposition } from './support/csv';
import { explain } from './support/plans';
import { readsOf } from './support/read-rows';
import {
  BOARD_IDS,
  BOARD_NAMES,
  BoardScenario,
  DAY,
  enableHash,
  fleet,
  HEAD_LEDGER,
  insertEnableAmendments,
  insertFeatures,
  insertLedgers,
  insertLists,
  insertPublishers,
  insertRound,
  insertSeen,
  insertState,
  seedAmendmentBoard,
  VOTING_LEDGER,
} from './support/validators-seed';

/**
 * `GET /v2/network/amendments` and `GET /v2/network/amendments/{name}` on a real ClickHouse: the board of an XRPL deployment
 * with an amendment in every state and a UNL of 36 validators (`seedAmendmentBoard`, with the made-up metadata file
 * `support/amendments-xrpl.json`), the rows and their order, the filter and the CSV, the detail (UNL votes, other votes,
 * rounds, history), the version sets of a round, the metadata files shipped for each network (the default of
 * `GH_AMENDMENTS_CONFIG`), an empty database, `Cache-Control` and the errors, the caches, and a file that fails the boot.
 *
 * The directory and the assembly are cached for 10 s, so each scenario has an app of its own (the cache is the app's).
 */

const LIST = '/v2/network/amendments';
const detailOf = (ref: string): string => `${LIST}/${ref}`;
const FIXTURE = join(__dirname, 'support', 'amendments-xrpl.json');
const INVALID = join(__dirname, 'support', 'amendments-invalid.json');
const HOLD_XRPL = 1_209_600;
const HOLD_XAHAU = 432_000;
const GOT = 0x10000;
const LOST = 0x20000;

/** `2026-10-19T15:42:45Z` */
const time = (seconds: number): string => `${new Date(Math.round(seconds * 1000)).toISOString().slice(0, 19)}Z`;
/** `2026-10-19T15:40:02.114Z` */
const instant = (seconds: number): string => new Date(Math.round(seconds * 1000)).toISOString();

interface Started {
  h: Harness;
  directory: () => Promise<Directory>;
}

/**
 * A harness and a way to read the directory its app built. The service class has to come from the registry of the app
 * (`jest.isolateModulesAsync` in the harness), which the `controllers` callback of the harness runs in.
 */
async function startWithDirectory(options: HarnessOptions): Promise<Started> {
  let directories: typeof ValidatorDirectoryService | undefined;
  const h = await startHarness({
    ...options,
    controllers: async () => {
      ({ ValidatorDirectoryService: directories } = await import('../src/validators/validator-directory.service'));
      return [];
    },
  });
  return { h, directory: () => h.app.get(directories as typeof ValidatorDirectoryService).get() };
}

// ===================================================================================================================
// the board
// ===================================================================================================================

describe('GET /v2/network/amendments: the board of an XRPL deployment', () => {
  let started: Started;
  let h: Harness;
  let api: ApiClient;
  let board: BoardScenario;
  let res: { status: number; body: Record<string, any>; headers: Record<string, string>; text: string };
  let list: Record<string, any>;
  let directoryBefore: string;

  const row = (id: string): Record<string, any> => {
    const found = list.amendments.find((a: { id: string }) => a.id === id);
    if (!found) throw new Error(`no row ${id}`);
    return found;
  };

  beforeAll(async () => {
    started = await startWithDirectory({
      seed: 'none',
      network: 'xrpl',
      env: { ...NO_RATE_LIMIT, GH_AMENDMENTS_CONFIG: FIXTURE },
    });
    h = started.h;
    api = await h.api();
    board = await seedAmendmentBoard(h.ch);
    res = await api.get(LIST);
    list = res.body;
    directoryBefore = JSON.stringify([...(await started.directory()).entries.values()]);
  });
  afterAll(async () => {
    await h?.close();
  });

  // -- the envelope ------------------------------------------------------------------------------------------------

  describe('the envelope', () => {
    it('has the keys of AMENDMENTS_BODY_KEYS, in order', () => {
      expect(res.status).toBe(200);
      expect(Object.keys(list)).toEqual([...AMENDMENTS_BODY_KEYS]);
      expect(list.result).toBe('success');
    });

    it('has the ledger of the summary and the rules of the network', () => {
      expect(list.ledger_index).toBe(HEAD_LEDGER);
      expect(list.rules).toEqual({ threshold_percent: 80, majority_hold_seconds: HOLD_XRPL, flag_interval: 256 });
      expect(Object.keys(list.rules)).toEqual(['threshold_percent', 'majority_hold_seconds', 'flag_interval']);
    });

    it('describes the newest stored round', () => {
      expect(list.round).toEqual({
        ledger_index: VOTING_LEDGER,
        date: time(board.roundClose(0)),
        unl_size: 36,
        trusted: 35,
        threshold: 28,
        needed: 29,
        observed: 35,
      });
      expect(Object.keys(list.round)).toEqual([...ROUND_KEYS]);
    });

    it('has the next flag ledger of the summary', async () => {
      const summary = (await api.get('/v2/network/validators/summary')).body;
      expect(list.next_flag_ledger).toEqual(summary.next_flag_ledger);
      expect(list.next_flag_ledger).toEqual({
        ledger_index: 107_748_352,
        voting_ledger: 107_748_351,
        // 169 ledgers at 4 s
        expected: time(board.headClose + 169 * 4),
      });
    });

    it('counts every status and the rows of the answer', () => {
      expect(list.counts).toEqual({ enabled: 3, majority: 2, voting: 5, obsolete: 2, unknown: 1 });
      expect(Object.keys(list.counts)).toEqual(['enabled', 'majority', 'voting', 'obsolete', 'unknown']);
      expect(list.count).toBe(13);
      expect(list.amendments).toHaveLength(13);
    });
  });

  // -- the list -----------------------------------------------------------------------------------------------------

  describe('the list', () => {
    it('lists the groups majority, voting, unknown, enabled, obsolete, each in its order', () => {
      expect(list.amendments.map((a: { id: string }) => a.id)).toEqual([
        // by expected activation: the majority gained five days ago before the one of two days ago
        BOARD_IDS.majorityNameless,
        BOARD_IDS.majority,
        // by yes, then name, the unnamed last
        BOARD_IDS.voting,
        BOARD_IDS.unsupportedVoted,
        BOARD_IDS.nodeOnly,
        BOARD_IDS.idle,
        BOARD_IDS.votedByOther,
        BOARD_IDS.unknown,
        // by the ledger it was enabled in, newest first, none last
        BOARD_IDS.enabledLedger,
        BOARD_IDS.enabledFile,
        BOARD_IDS.enabledBare,
        // by name
        BOARD_IDS.obsoleteNode,
        BOARD_IDS.obsolete,
      ]);
    });

    it('has the keys of a row in the order of AMENDMENT_ROW_KEYS, the ones with a value only', () => {
      for (const a of list.amendments) {
        const present = Object.keys(a);
        expect(present).toEqual(AMENDMENT_ROW_KEYS.filter((key) => present.includes(key)));
      }
    });

    it('never has a null', () => {
      expect(JSON.stringify(list)).not.toContain('null');
    });

    it('has a majority with an indexed tfGotMajority: its ledger and transaction, the newest of the amendment (G5)', () => {
      expect(row(BOARD_IDS.majority)).toEqual({
        id: BOARD_IDS.majority,
        name: BOARD_NAMES.majority,
        status: 'majority',
        introduced: '3.4.1',
        xls: 'XLS-99',
        xls_url: 'https://github.com/XRPLF/XRPL-Standards/discussions/99',
        node_supported: true,
        votes: { ledger_index: VOTING_LEDGER, yes: 31, trusted: 35, needed: 29, pct: 88.57 },
        majority: {
          since: time(board.since.majority),
          ledger_index: board.gotMajority.ledgerIndex,
          tx_hash: enableHash(board.gotMajority.ledgerIndex, BOARD_IDS.majority, GOT),
          expected_activation: time(board.since.majority + HOLD_XRPL),
        },
      });
      expect(Object.keys(row(BOARD_IDS.majority).majority)).toEqual([...MAJORITY_KEYS]);
      expect(Object.keys(row(BOARD_IDS.majority).votes)).toEqual([...AMENDMENT_VOTES_KEYS]);
    });

    it('has a majority with no indexed EnableAmendment without ledger_index and tx_hash (G5), and no name', () => {
      expect(row(BOARD_IDS.majorityNameless)).toEqual({
        id: BOARD_IDS.majorityNameless,
        status: 'majority',
        votes: { ledger_index: VOTING_LEDGER, yes: 30, trusted: 35, needed: 29, pct: 85.71 },
        majority: {
          since: time(board.since.majorityNameless),
          expected_activation: time(board.since.majorityNameless + HOLD_XRPL),
        },
      });
    });

    it('serves xls_url, introduced, xls and description of the file (G2)', () => {
      expect(row(BOARD_IDS.enabledLedger)).toMatchObject({
        introduced: '1.12.0',
        xls: 'XLS-30',
        xls_url: 'https://github.com/XRPLF/XRPL-Standards/tree/master/XLS-0030-automated-market-maker',
        description: 'Made up for the tests: enabled, with an indexed EnableAmendment that wins over the file.',
      });
      expect(row(BOARD_IDS.voting).description).toBe('Made up for the tests: voted for by four.');
    });

    it('has enabled.source ledger from an indexed EnableAmendment, which wins over the file', () => {
      expect(row(BOARD_IDS.enabledLedger)).toMatchObject({
        status: 'enabled',
        enabled: {
          ledger_index: board.enabledAt.ledgerIndex,
          date: time(board.enabledAt.closeTime),
          tx_hash: enableHash(board.enabledAt.ledgerIndex, BOARD_IDS.enabledLedger, 0),
          source: 'ledger',
        },
      });
      expect(Object.keys(row(BOARD_IDS.enabledLedger).enabled)).toEqual([...ENABLED_KEYS]);
      expect(row(BOARD_IDS.enabledLedger)).not.toHaveProperty('votes');
    });

    it('has enabled.source metadata from the file when nothing is indexed: its ledger and day', () => {
      expect(row(BOARD_IDS.enabledFile)).toEqual({
        id: BOARD_IDS.enabledFile,
        name: BOARD_NAMES.enabledFile,
        status: 'enabled',
        introduced: '2.0.0',
        enabled: { ledger_index: 90_000_001, date: '2025-02-03', source: 'metadata' },
      });
    });

    it('has an enabled amendment nothing else is known of as its id and status', () => {
      expect(row(BOARD_IDS.enabledBare)).toEqual({ id: BOARD_IDS.enabledBare, status: 'enabled' });
    });

    it('has the votes of the newest round for a voting amendment, and yes 0 for one with no tally row', () => {
      expect(row(BOARD_IDS.voting).votes).toEqual({
        ledger_index: VOTING_LEDGER,
        yes: 4,
        trusted: 35,
        needed: 29,
        pct: 11.43,
      });
      expect(row(BOARD_IDS.idle)).toEqual({
        id: BOARD_IDS.idle,
        name: BOARD_NAMES.idle,
        status: 'voting',
        votes: { ledger_index: VOTING_LEDGER, yes: 0, trusted: 35, needed: 29, pct: 0 },
      });
    });

    it('takes the name from the node when the file has none, and says what the node supports', () => {
      expect(row(BOARD_IDS.nodeOnly)).toEqual({
        id: BOARD_IDS.nodeOnly,
        name: 'NodeNamedOnly',
        status: 'voting',
        node_supported: true,
        votes: { ledger_index: VOTING_LEDGER, yes: 1, trusted: 35, needed: 29, pct: 2.86 },
      });
    });

    it('keeps a voting amendment the node does not support while a UNL validator votes yes', () => {
      expect(row(BOARD_IDS.unsupportedVoted)).toEqual({
        id: BOARD_IDS.unsupportedVoted,
        name: 'StillVoted',
        status: 'voting',
        node_supported: false,
        votes: { ledger_index: VOTING_LEDGER, yes: 2, trusted: 35, needed: 29, pct: 5.71 },
      });
    });

    it('is voting for a nameless amendment only an outsider voted for', () => {
      expect(row(BOARD_IDS.votedByOther)).toEqual({
        id: BOARD_IDS.votedByOther,
        status: 'voting',
        votes: { ledger_index: VOTING_LEDGER, yes: 0, trusted: 35, needed: 29, pct: 0 },
      });
    });

    it('is unknown for an ID the node lists without a name and nobody voted for; the newer row of the node wins', () => {
      expect(row(BOARD_IDS.unknown)).toEqual({
        id: BOARD_IDS.unknown,
        status: 'unknown',
        node_supported: true,
        votes: { ledger_index: VOTING_LEDGER, yes: 0, trusted: 35, needed: 29, pct: 0 },
      });
    });

    it('is obsolete by the file, or by a node that does not support it while nobody votes yes; no votes', () => {
      expect(row(BOARD_IDS.obsolete)).toEqual({
        id: BOARD_IDS.obsolete,
        name: BOARD_NAMES.obsolete,
        status: 'obsolete',
        introduced: '0.60.0',
      });
      expect(row(BOARD_IDS.obsoleteNode)).toEqual({
        id: BOARD_IDS.obsoleteNode,
        name: 'NodeGone',
        status: 'obsolete',
        node_supported: false,
      });
    });

    it('does not list an ID a validator voted for only before the last 30 days', () => {
      expect(list.amendments.some((a: { id: string }) => a.id === BOARD_IDS.votedLongAgo)).toBe(false);
    });

    it('reads the newest ledger state: the enabled amendments of an older poll are not the answer', () => {
      expect(row(BOARD_IDS.enabledBare).status).toBe('enabled');
      expect(row(BOARD_IDS.enabledLedger).status).toBe('enabled');
    });
  });

  // -- the filter, the CSV -------------------------------------------------------------------------------------------

  describe('status', () => {
    it('keeps the rows of the statuses of the comma list, in the order of the list, and the counts of all', async () => {
      const filtered = (await api.get(`${LIST}?status=voting,majority`)).body;
      expect(filtered.rules).toEqual(list.rules);
      expect(filtered.counts).toEqual(list.counts);
      expect(filtered.count).toBe(7);
      expect(filtered.amendments).toEqual(
        list.amendments.filter((a: { status: string }) => a.status === 'majority' || a.status === 'voting'),
      );
      expect(filtered.amendments.map((a: { status: string }) => a.status)).toEqual([
        'majority',
        'majority',
        ...Array(5).fill('voting'),
      ]);
    });

    it('takes one status, and a status with no rows is an empty list that still has the counts', async () => {
      const obsolete = (await api.get(`${LIST}?status=obsolete`)).body;
      expect(obsolete.count).toBe(2);
      expect(obsolete.counts).toEqual(list.counts);
      const rest = (await api.get(`${LIST}?status=unknown,obsolete`)).body;
      expect(rest.count).toBe(3);
    });

    it('is all the statuses when empty or left out', async () => {
      const empty = await api.get(`${LIST}?status=`);
      expect(empty.status).toBe(200);
      expect(empty.body.count).toBe(13);
    });

    it('is 400 invalid status for anything but the five words', async () => {
      for (const bad of ['nope', 'voting,nope', 'Voting', 'voting,,majority', 'enabled%20x']) {
        const refused = await api.get(`${LIST}?status=${bad}`);
        expect([bad, refused.status, refused.body]).toEqual([bad, 400, { result: 'error', message: 'invalid status' }]);
        expect(refused.headers['cache-control']).toBe('no-store');
      }
    });

    it('ignores the parameters it does not know', async () => {
      const res2 = await api.get(`${LIST}?limit=1&marker=x&scope=all`);
      expect(res2.status).toBe(200);
      expect(res2.body.count).toBe(13);
    });
  });

  describe('format=csv', () => {
    const cells = (line: string): string[] => line.split(',').map((cell) => cell.replace(/^"|"$/g, ''));

    it('is amendments.csv, one row per amendment', async () => {
      const csv = await api.get(`${LIST}?format=csv`);
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toMatch(/^text\/csv/);
      expect(csv.headers['content-disposition']).toBe(csvDisposition('amendments'));
      expect(csv.text.split('\n')).toHaveLength(1 + 13);
    });

    it('flattens the nested objects into columns and follows the filter', async () => {
      const csv = await api.get(`${LIST}?format=csv&status=majority`);
      const [header, first, second, ...rest] = csv.text.split('\n');
      expect(rest).toEqual([]);
      const columns = cells(header);
      expect(columns).toEqual(expect.arrayContaining(['id', 'status', 'votes.yes', 'votes.pct', 'majority.since']));
      expect(columns.indexOf('id')).toBe(0);
      const idOf = (line: string): string => cells(line)[columns.indexOf('id')];
      expect([idOf(first), idOf(second)]).toEqual([BOARD_IDS.majorityNameless, BOARD_IDS.majority]);
      expect(cells(second)[columns.indexOf('majority.tx_hash')]).toBe(
        enableHash(board.gotMajority.ledgerIndex, BOARD_IDS.majority, GOT),
      );
    });
  });

  describe('the transport', () => {
    it('sends Cache-Control: private, max-age=60 on the list and the detail', async () => {
      expect(res.headers['cache-control']).toBe('private, max-age=60');
      const detail = await api.get(detailOf(BOARD_NAMES.majority));
      expect(detail.headers['cache-control']).toBe('private, max-age=60');
    });

    it('requires the API key', async () => {
      const refused = await h.http().get(LIST);
      expect(refused.status).toBe(401);
      expect(refused.body).toEqual({ result: 'error', message: 'Missing or invalid API key.' });
      expect(refused.headers['cache-control']).toBe('no-store');
    });
  });

  // -- the detail ----------------------------------------------------------------------------------------------------

  describe('GET /v2/network/amendments/{name}', () => {
    const detail = async (ref: string): Promise<Record<string, any>> => (await api.ok(detailOf(ref))).body;

    describe('finding the amendment', () => {
      it('finds a name, a name in another case when only one amendment has it, and an ID in any case', async () => {
        for (const ref of [
          BOARD_NAMES.majority,
          BOARD_NAMES.majority.toLowerCase(),
          BOARD_NAMES.majority.toUpperCase(),
          BOARD_IDS.majority,
          BOARD_IDS.majority.toLowerCase(),
          `${BOARD_IDS.majority.slice(0, 20).toLowerCase()}${BOARD_IDS.majority.slice(20)}`,
        ]) {
          expect([ref, (await detail(ref)).id]).toEqual([ref, BOARD_IDS.majority]);
        }
      });

      it('finds a name the node gave, and an amendment that has no name, by its ID', async () => {
        expect((await detail('NodeNamedOnly')).id).toBe(BOARD_IDS.nodeOnly);
        const nameless = await detail(BOARD_IDS.majorityNameless.toLowerCase());
        expect(nameless.id).toBe(BOARD_IDS.majorityNameless);
        expect(nameless).not.toHaveProperty('name');
      });

      it('is 404 amendment not found for a name or an ID nobody has, or text that is neither', async () => {
        for (const ref of ['NoSuchAmendment', 'f'.repeat(64), BOARD_IDS.majority.slice(1), 'Test', '%20']) {
          const missing = await api.get(detailOf(ref));
          expect([ref, missing.status, missing.body]).toEqual([
            ref,
            404,
            { result: 'error', message: 'amendment not found' },
          ]);
          expect(missing.headers['cache-control']).toBe('no-store');
        }
      });

      it('is JSON only: format=csv is ignored', async () => {
        const csv = await api.get(`${detailOf(BOARD_NAMES.majority)}?format=csv`);
        expect(csv.status).toBe(200);
        expect(csv.headers['content-type']).toMatch(/json/);
        expect(csv.body.id).toBe(BOARD_IDS.majority);
      });
    });

    it('repeats the list envelope on the detail', async () => {
      for (const ref of [BOARD_NAMES.majority, BOARD_NAMES.voting, BOARD_NAMES.enabledLedger, BOARD_IDS.unknown]) {
        const d = await detail(ref);
        expect(d.ledger_index).toEqual(list.ledger_index);
        expect(d.rules).toEqual(list.rules);
        expect(d.round).toEqual(list.round);
        expect(d.next_flag_ledger).toEqual(list.next_flag_ledger);
      }
    });

    it('has the keys of AMENDMENT_DETAIL_KEYS in order, the row of the list inside, and the result last', async () => {
      const d = await detail(BOARD_NAMES.majority);
      expect(Object.keys(d)).toEqual([
        'ledger_index',
        'rules',
        'round',
        'next_flag_ledger',
        'id',
        'name',
        'status',
        'introduced',
        'xls',
        'xls_url',
        'node_supported',
        'votes',
        'majority',
        'unl_votes',
        'other_votes',
        'rounds',
        'history',
        'result',
      ]);
      expect(Object.keys(d)).toEqual(AMENDMENT_DETAIL_KEYS.filter((key) => key in d));
      expect(d.result).toBe('success');
      const { id, name, status, introduced, xls, xls_url, node_supported, votes, majority } = row(BOARD_IDS.majority);
      expect({ id, name, status, introduced, xls, xls_url, node_supported, votes, majority }).toEqual({
        id: d.id,
        name: d.name,
        status: d.status,
        introduced: d.introduced,
        xls: d.xls,
        xls_url: d.xls_url,
        node_supported: d.node_supported,
        votes: d.votes,
        majority: d.majority,
      });
      expect(JSON.stringify(d)).not.toContain('null');
    });

    describe('unl_votes', () => {
      it('is every member of the UNL of the newest round: domains first, then by key; yes, no or none', async () => {
        const d = await detail(BOARD_NAMES.majority);
        const keysInOrder = d.unl_votes.map((v: { validation_public_key: string }) => v.validation_public_key);
        const withDomain = [board.unl[0].key, board.unl[1].key];
        const rest = board.unl
          .slice(2)
          .map((m) => m.key)
          .sort();
        expect(keysInOrder).toEqual([...withDomain, ...rest]);
        expect(d.unl_votes).toHaveLength(36);

        const voteOf = (i: number): string => (i <= 30 ? 'yes' : i <= 34 ? 'no' : 'none');
        for (const [i, member] of board.unl.entries()) {
          const found = d.unl_votes.find(
            (v: { validation_public_key: string }) => v.validation_public_key === member.key,
          );
          expect([i, found.vote]).toEqual([i, voteOf(i)]);
        }
      });

      it('has the domain, the version, whether the version has the amendment, and when it was last seen', async () => {
        const d = await detail(BOARD_NAMES.majority);
        const at = (i: number) =>
          d.unl_votes.find((v: { validation_public_key: string }) => v.validation_public_key === board.unl[i].key);
        const lastSeen = instant(board.now - 60.25);
        expect(at(0)).toEqual({
          validation_public_key: board.unl[0].key,
          domain: 'northpeak.example',
          vote: 'yes',
          version: '3.4.1',
          version_supports: true,
          last_seen: lastSeen,
        });
        expect(Object.keys(at(0))).toEqual([...UNL_VOTE_KEYS]);
        expect(at(1).domain).toBe('shoreline.example');
        // unl[5] was recorded under its signing key: its vote and version are its master's
        expect(at(5)).toEqual({
          validation_public_key: board.unl[5].key,
          vote: 'yes',
          version: '3.4.1',
          version_supports: true,
          last_seen: lastSeen,
        });
        // 3.4.0 lacks an amendment introduced in 3.4.1, whether the validator votes yes or no
        expect(at(30)).toMatchObject({ vote: 'yes', version: '3.4.0', version_supports: false });
        expect(at(31)).toMatchObject({ vote: 'no', version: '3.4.0', version_supports: false });
        // never voted: no version, no way to tell; the validator is on the UNL and was seen
        expect(at(35)).toEqual({ validation_public_key: board.unl[35].key, vote: 'none', last_seen: lastSeen });
      });

      it('leaves out version_supports when the amendment has no introduced version', async () => {
        const d = await detail(BOARD_IDS.majorityNameless);
        for (const v of d.unl_votes) expect(v).not.toHaveProperty('version_supports');
        expect(d.unl_votes[0].version).toBe('3.4.1');
        // yes for the first 30 members of the UNL
        expect(d.unl_votes.filter((v: { vote: string }) => v.vote === 'yes')).toHaveLength(30);
      });
    });

    describe('other_votes', () => {
      it('is the validators off the UNL seen in 24 h with a record: the ones that voted, not the one seen days ago', async () => {
        const d = await detail(BOARD_NAMES.majority);
        // others[0] (a domain) votes for it, others[1] for nothing; others[2] never voted, others[3] was seen three days ago
        expect(d.other_votes).toEqual([
          {
            validation_public_key: board.others[0].key,
            domain: 'tidewater.example',
            vote: 'yes',
            version: '3.4.1',
            version_supports: true,
            last_seen: instant(board.now - 60.25),
          },
          {
            validation_public_key: board.others[1].key,
            vote: 'no',
            version: '3.5.0',
            version_supports: true,
            last_seen: instant(board.now - 60.25),
          },
        ]);
      });

      it('has the vote of an outsider for an amendment only outsiders vote for', async () => {
        const d = await detail(BOARD_IDS.votedByOther);
        expect(d.unl_votes.every((v: { vote: string }) => v.vote !== 'yes')).toBe(true);
        expect(d.other_votes.map((v: { vote: string }) => v.vote)).toEqual(['yes', 'no']);
      });
    });

    describe('rounds', () => {
      const flat = (d: Record<string, any>) =>
        d.rounds.map((r: { ledger_index: number; yes: number; passes: boolean }) => [r.ledger_index, r.yes, r.passes]);

      it('is one per stored round of the last 30 days, oldest first, a round with no tally row with yes 0', async () => {
        const d = await detail(BOARD_NAMES.voting);
        // the round of ten days ago has no row for it; the one of forty days ago is outside the window
        expect(d.rounds).toHaveLength(5);
        expect(flat(d)).toEqual([
          [board.oldLedger, 0, false],
          [board.roundLedger(3), 2, false],
          [board.roundLedger(2), 3, false],
          [board.roundLedger(1), 3, false],
          [board.roundLedger(0), 4, false],
        ]);
        expect(d.rounds[0]).toEqual({
          ledger_index: board.oldLedger,
          flag_ledger: board.oldLedger + 1,
          date: time(board.oldClose),
          yes: 0,
          trusted: 35,
          threshold: 28,
          passes: false,
        });
        expect(Object.keys(d.rounds[0])).toEqual([...ROUND_POINT_KEYS]);
        expect(d.rounds[4].date).toBe(time(board.roundClose(0)));
      });

      it('says whether each round passed: more yes than the threshold', async () => {
        const d = await detail(BOARD_NAMES.majority);
        expect(flat(d)).toEqual([
          [board.oldLedger, 0, false],
          [board.roundLedger(3), 25, false],
          [board.roundLedger(2), 29, true],
          [board.roundLedger(1), 31, true],
          [board.roundLedger(0), 31, true],
        ]);
      });

      it('is, for an enabled amendment, the rounds before the ledger it was enabled in', async () => {
        const d = await detail(BOARD_NAMES.enabledLedger);
        // enabled two ledgers after the voting ledger of round 1: that round is the last, round 0 is after
        expect(flat(d)).toEqual([
          [board.oldLedger, 20, false],
          [board.roundLedger(3), 32, true],
          [board.roundLedger(2), 32, true],
          [board.roundLedger(1), 32, true],
        ]);
      });

      it('is empty for an enabled amendment enabled before every stored round, or whose ledger nobody knows', async () => {
        expect((await detail(BOARD_NAMES.enabledFile)).rounds).toEqual([]);
        expect((await detail(BOARD_IDS.enabledBare)).rounds).toEqual([]);
      });

      it('is every round of an obsolete and of an unknown amendment', async () => {
        expect((await detail(BOARD_NAMES.obsolete)).rounds).toHaveLength(5);
        expect((await detail(BOARD_IDS.unknown)).rounds).toHaveLength(5);
      });
    });

    describe('history', () => {
      it('is every indexed EnableAmendment of the amendment, oldest first, as the event it was', async () => {
        const d = await detail(BOARD_NAMES.majority);
        expect(d.history).toEqual([
          {
            event: 'got_majority',
            ledger_index: 106_500_001,
            date: time(board.now - 60 * DAY),
            tx_hash: enableHash(106_500_001, BOARD_IDS.majority, GOT),
          },
          {
            event: 'lost_majority',
            ledger_index: 106_600_001,
            date: time(board.now - 50 * DAY),
            tx_hash: enableHash(106_600_001, BOARD_IDS.majority, LOST),
          },
          {
            event: 'got_majority',
            ledger_index: board.gotMajority.ledgerIndex,
            date: time(board.gotMajority.closeTime),
            tx_hash: enableHash(board.gotMajority.ledgerIndex, BOARD_IDS.majority, GOT),
          },
        ]);
        expect(Object.keys(d.history[0])).toEqual([...HISTORY_KEYS]);
      });

      it('reads a transaction without Flags as the enabling', async () => {
        const d = await detail(BOARD_NAMES.enabledLedger);
        expect(d.history.map((e: { event: string; ledger_index: number }) => [e.event, e.ledger_index])).toEqual([
          ['got_majority', 107_000_001],
          ['enabled', board.enabledAt.ledgerIndex],
        ]);
      });

      it('is empty for an amendment with none, and has no event of another amendment', async () => {
        expect((await detail(BOARD_IDS.unknown)).history).toEqual([]);
        expect((await detail(BOARD_NAMES.voting)).history).toHaveLength(1);
      });
    });

    it('leaves the directory it shares untouched', async () => {
      await detail(BOARD_NAMES.majority);
      await detail(BOARD_NAMES.enabledLedger);
      expect(JSON.stringify([...(await started.directory()).entries.values()])).toBe(directoryBefore);
    });
  });
});

// ===================================================================================================================
// the SQL
// ===================================================================================================================

describe('the SQL of the amendment routes', () => {
  let h: Harness;
  let queries: { sql: string; params: Record<string, unknown> }[];

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', network: 'xrpl', env: { ...NO_RATE_LIMIT, GH_AMENDMENTS_CONFIG: FIXTURE } });
    await seedAmendmentBoard(h.ch);
    const api = await h.api();
    // the directory first, so that the statements below are the ones of the amendments alone
    expect((await api.get('/v2/network/validators/summary')).status).toBe(200);
    queries = [];
    const original = h.ch.query.bind(h.ch);
    jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, params: Record<string, unknown> = {}, s?: object) => {
      queries.push({ sql, params });
      return original(sql, params, s as never);
    }) as never);
    expect((await api.get(LIST)).status).toBe(200);
    expect((await api.get(detailOf(BOARD_NAMES.majority))).status).toBe(200);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('reads what the amendments need, and nothing of the directory again', () => {
    const tables = (Object.values(Table) as string[]).filter((table) =>
      queries.some(({ sql }) => new RegExp(`\\b(FROM|JOIN)\\s+${table}\\b`).test(sql)),
    );
    expect(tables.sort()).toEqual(
      [
        Table.AmendmentFeatures,
        Table.AmendmentTallies,
        Table.Transactions,
        Table.TxByType,
        Table.ValidatorVotes,
      ].sort(),
    );
  });

  it('binds its values, uses no FINAL, and takes its tables from the Table enum', () => {
    const tables = Object.values(Table) as string[];
    expect(queries.length).toBeGreaterThanOrEqual(5);
    for (const { sql } of queries) {
      expect(sql).not.toMatch(/\bFROM\s+[\w.]+\s+FINAL\b/i);
      for (const [, name] of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z_0-9.]*)/gi)) expect(tables).toContain(name);
    }
    // nothing the data says is in the text of a statement: no amendment ID, no ledger, no version
    const text = queries.map(({ sql }) => sql).join('\n');
    expect(text).not.toMatch(/[0-9A-F]{64}/);
    expect(text).not.toContain('107748');
    expect(text).not.toContain(BOARD_NAMES.majority);
  });

  it('adds up nothing by validator, so that it has no key to map through the manifest map', () => {
    // the votes of each validator are the directory's, which maps them; these reads count amendments and rounds
    expect(queries.map(({ sql }) => sql).join('\n')).not.toContain('validation_public_key');
  });

  it('reads the rows of the newest sentinel version of a round only: every statement on the version sets filters by it', () => {
    const sets = queries.filter(({ sql }) => /\bFROM\s+(validator_votes|amendment_tallies)\b/.test(sql));
    expect(sets.length).toBeGreaterThanOrEqual(4);
    for (const { sql } of sets) {
      // the sentinels are read for their newest version; every other read takes the rows of that version only
      expect(sql).toMatch(/max\(version\)|version = toUInt64\(/);
    }
  });

  it('reads the rounds of an amendment by the key of amendment_tallies: its amendment_id and a range of ledgers', async () => {
    const read = queries.find(({ sql }) => sql.includes('amendment_id IN {amendments:Array(String)}'));
    if (!read) throw new Error('no read of the rounds of an amendment');
    const plan = await explain(h, 'indexes = 1', read.sql, read.params);
    expect(plan).toContain('PrimaryKey');
    expect(plan).toMatch(/Keys:\s+amendment_id\s+ledger_index/);
  });
});

// ===================================================================================================================
// version sets
// ===================================================================================================================

// A version is a UInt64 (a wall-clock millisecond today). These are above 2^53, where a JavaScript number is not exact.
const OLDER_ROUND = '9007199254740991';
const NEWER_ROUND = '9007199254740993';

describe('GET /v2/network/amendments: a round written twice', () => {
  const X = 'AB'.repeat(32);
  const Y = 'CD'.repeat(32);
  let h: Harness;
  let api: ApiClient;
  let list: Record<string, any>;

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', network: 'xrpl', env: { ...NO_RATE_LIMIT, GH_AMENDMENTS_CONFIG: FIXTURE } });
    api = await h.api();
    const [a, b, ghost] = fleet('xrpl', 3);
    const now = Math.floor(Date.now() / 1000);
    // a rewritten round must not be mixed with its older version: stop the merges that would hide it
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.ValidatorVotes}`);
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.AmendmentTallies}`);
    await insertLists(h.ch, [
      { publisher: 'vl.ripple.com', sequence: 1, expiration: now + DAY, validators: [a.key, b.key] },
    ]);
    await insertPublishers(h.ch, [{ publisher: 'vl.ripple.com', checked_at: now - 10 }]);
    await insertSeen(
      h.ch,
      [a, b, ghost].map((m) => ({ key: m.key, first: now - DAY, last: now - 30 })),
    );
    await insertLedgers(h.ch, HEAD_LEDGER, now - 8, 10, 4);
    await insertState(h.ch, [{ ledger_index: HEAD_LEDGER, polled_at: now - 5 }]);
    const close = now - 600;
    // the older set: three trusted validators, X with five yes and Y voted for
    await insertRound(h.ch, {
      ledgerIndex: VOTING_LEDGER,
      closeTime: close,
      version: OLDER_ROUND,
      unl: [a.key, b.key, ghost.key],
      votes: [
        { key: a.key, amendments: [X, Y] },
        { key: b.key, amendments: [X] },
        { key: ghost.key, amendments: [X] },
      ],
      tallies: [
        { id: X, yes: 3 },
        { id: Y, yes: 1 },
      ],
    });
    // the newer set: two trusted validators, X with two yes, nobody votes for Y
    await insertRound(h.ch, {
      ledgerIndex: VOTING_LEDGER,
      closeTime: close,
      version: NEWER_ROUND,
      unl: [a.key, b.key],
      votes: [
        { key: a.key, amendments: [X] },
        { key: b.key, amendments: [X] },
      ],
      tallies: [{ id: X, yes: 2 }],
    });
    list = (await api.get(LIST)).body;
  });
  afterAll(async () => {
    await h?.close();
  });

  it('reads the tallies and the votes of the newest sentinel version of the round only', () => {
    expect(list.round).toMatchObject({ ledger_index: VOTING_LEDGER, unl_size: 2, trusted: 2, threshold: 1, needed: 2 });
    const ids = list.amendments.map((a: { id: string }) => a.id);
    // Y was voted for only in the older set
    expect(ids).toContain(X);
    expect(ids).not.toContain(Y);
    expect(list.amendments.find((a: { id: string }) => a.id === X)).toEqual({
      id: X,
      status: 'voting',
      votes: { ledger_index: VOTING_LEDGER, yes: 2, trusted: 2, needed: 2, pct: 100 },
    });
  });

  it('has the rounds of the amendment from the newer set', async () => {
    const d = (await api.ok(detailOf(X))).body;
    expect(d.rounds).toEqual([
      {
        ledger_index: VOTING_LEDGER,
        flag_ledger: VOTING_LEDGER + 1,
        date: expect.any(String),
        yes: 2,
        trusted: 2,
        threshold: 1,
        passes: true,
      },
    ]);
    expect(d.unl_votes.map((v: { vote: string }) => v.vote)).toEqual(['yes', 'yes']);
    expect((await api.get(detailOf(Y))).status).toBe(404);
  });
});

describe('GET /v2/network/amendments/{name}: one trusted validator', () => {
  const X = 'EF'.repeat(32);
  let h: Harness;
  let d: Record<string, any>;

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', network: 'xrpl', env: NO_RATE_LIMIT });
    const [a] = fleet('xrpl', 1);
    const now = Math.floor(Date.now() / 1000);
    await insertSeen(h.ch, [{ key: a.key, first: now - DAY, last: now - 30 }]);
    await insertRound(h.ch, {
      ledgerIndex: VOTING_LEDGER - 256,
      closeTime: now - 4000,
      version: 1,
      unl: [a.key],
      votes: [{ key: a.key, amendments: [X] }],
      tallies: [{ id: X, yes: 1 }],
    });
    await insertRound(h.ch, {
      ledgerIndex: VOTING_LEDGER,
      closeTime: now - 3000,
      version: 2,
      unl: [a.key],
      votes: [{ key: a.key, amendments: [] }],
    });
    d = (await (await h.api()).ok(detailOf(X))).body;
  });
  afterAll(async () => {
    await h?.close();
  });

  it('passes at trusted 1 with one yes', () => {
    expect(d.rounds).toMatchObject([
      { yes: 1, trusted: 1, threshold: 1, passes: true },
      { yes: 0, trusted: 1, threshold: 1, passes: false },
    ]);
  });

  it('needs one vote', () => {
    expect(d.round).toMatchObject({ trusted: 1, threshold: 1, needed: 1 });
    expect(d.votes).toEqual({ ledger_index: VOTING_LEDGER, yes: 0, trusted: 1, needed: 1, pct: 0 });
  });
});

describe('GET /v2/network/amendments: a newest round rewritten after the directory was built', () => {
  const X = 'AB'.repeat(32);
  let started: Started;
  let h: Harness;
  let list: Record<string, any>;
  let d: Record<string, any>;

  beforeAll(async () => {
    started = await startWithDirectory({
      seed: 'none',
      network: 'xrpl',
      env: { ...NO_RATE_LIMIT, GH_AMENDMENTS_CONFIG: FIXTURE },
    });
    h = started.h;
    const api = await h.api();
    const [a, b, c] = fleet('xrpl', 3);
    const now = Math.floor(Date.now() / 1000);
    // the rewrite must not hide the older version: stop the merges
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.ValidatorVotes}`);
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.AmendmentTallies}`);
    await insertSeen(
      h.ch,
      [a, b, c].map((m) => ({ key: m.key, first: now - DAY, last: now - 30 })),
    );
    const close = now - 600;
    await insertRound(h.ch, {
      ledgerIndex: VOTING_LEDGER,
      closeTime: close,
      version: OLDER_ROUND,
      unl: [a.key, b.key],
      votes: [
        { key: a.key, amendments: [X] },
        { key: b.key, amendments: [X] },
      ],
      tallies: [{ id: X, yes: 2 }],
    });
    // the directory reads the round as it is now ...
    await started.directory();
    // ... and the syncer writes it again, with three trusted validators and one yes
    await insertRound(h.ch, {
      ledgerIndex: VOTING_LEDGER,
      closeTime: close,
      version: NEWER_ROUND,
      unl: [a.key, b.key, c.key],
      votes: [
        { key: a.key, amendments: [X] },
        { key: b.key, amendments: [] },
        { key: c.key, amendments: [] },
      ],
      tallies: [{ id: X, yes: 1 }],
    });
    // the answers right after: within the 10 s the directory built above is kept, however slow the runner
    list = (await api.ok(LIST)).body;
    d = (await api.ok(detailOf(X))).body;
  });
  afterAll(async () => {
    await h?.close();
  });

  it('states the round, its votes and its tallies of one version: the one the directory has', () => {
    expect(list.round).toMatchObject({ ledger_index: VOTING_LEDGER, unl_size: 2, trusted: 2, threshold: 1, needed: 2 });
    expect(list.amendments.find((a: { id: string }) => a.id === X)).toEqual({
      id: X,
      status: 'voting',
      votes: { ledger_index: VOTING_LEDGER, yes: 2, trusted: 2, needed: 2, pct: 100 },
    });
  });

  it('has the rounds and the votes of the validators of that version too', () => {
    expect(d.round).toMatchObject({ trusted: 2, unl_size: 2 });
    expect(d.rounds).toMatchObject([{ ledger_index: VOTING_LEDGER, yes: 2, trusted: 2, threshold: 1, passes: true }]);
    expect(d.unl_votes.map((v: { vote: string }) => v.vote)).toEqual(['yes', 'yes']);
  });
});

describe('GET /v2/network/amendments: a newest round older than 30 days', () => {
  const X = 'AB'.repeat(32);
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', network: 'xrpl', env: { ...NO_RATE_LIMIT, GH_AMENDMENTS_CONFIG: FIXTURE } });
    api = await h.api();
    const [a, b] = fleet('xrpl', 2);
    const now = Math.floor(Date.now() / 1000);
    await insertSeen(
      h.ch,
      [a, b].map((m) => ({ key: m.key, first: now - 60 * DAY, last: now - 40 * DAY })),
    );
    // the syncer has stood still for 40 days: this is the newest round there is
    await insertRound(h.ch, {
      ledgerIndex: VOTING_LEDGER,
      closeTime: now - 40 * DAY,
      version: 1,
      unl: [a.key, b.key],
      votes: [
        { key: a.key, amendments: [X] },
        { key: b.key, amendments: [X] },
      ],
      tallies: [{ id: X, yes: 2 }],
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('still counts the votes of the newest round and lists what was voted for in it', async () => {
    const list = (await api.ok(LIST)).body;
    expect(list.round).toMatchObject({ ledger_index: VOTING_LEDGER, trusted: 2 });
    expect(list.amendments.find((a: { id: string }) => a.id === X)).toMatchObject({
      status: 'voting',
      votes: { ledger_index: VOTING_LEDGER, yes: 2, trusted: 2, needed: 2, pct: 100 },
    });
  });

  it('has the newest round among the rounds of the amendment', async () => {
    const d = (await api.ok(detailOf(X))).body;
    expect(d.rounds).toMatchObject([{ ledger_index: VOTING_LEDGER, yes: 2, trusted: 2, passes: true }]);
  });
});

describe('GET /v2/network/amendments: a majority regained, the EnableAmendment not indexed yet', () => {
  const REGAINED = 'AB'.repeat(32);
  const KEPT = 'CD'.repeat(32);
  let h: Harness;
  let list: Record<string, any>;
  let now: number;

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', network: 'xrpl', env: { ...NO_RATE_LIMIT, GH_AMENDMENTS_CONFIG: FIXTURE } });
    const [a] = fleet('xrpl', 1);
    now = Math.floor(Date.now() / 1000);
    await insertSeen(h.ch, [{ key: a.key, first: now - DAY, last: now - 30 }]);
    await insertState(h.ch, [
      {
        ledger_index: HEAD_LEDGER,
        polled_at: now - 5,
        majorities: [
          { amendment: REGAINED, since: now - 2 * DAY },
          { amendment: KEPT, since: now - 3 * DAY },
        ],
      },
    ]);
    await insertEnableAmendments(h.ch, [
      { amendment: REGAINED, flags: 0x10000, ledgerIndex: 106_500_001, closeTime: now - 30 * DAY },
      { amendment: REGAINED, flags: 0x20000, ledgerIndex: 106_600_001, closeTime: now - 20 * DAY },
      // the majority it has now was gained after: nothing of it is indexed
      { amendment: KEPT, flags: 0x10000, ledgerIndex: 107_700_001, closeTime: now - 3 * DAY + 5 },
    ]);
    await insertRound(h.ch, {
      ledgerIndex: VOTING_LEDGER,
      closeTime: now - 600,
      version: 1,
      unl: [a.key],
      votes: [{ key: a.key, amendments: [REGAINED, KEPT] }],
      tallies: [
        { id: REGAINED, yes: 1 },
        { id: KEPT, yes: 1 },
      ],
    });
    list = (await (await h.api()).ok(LIST)).body;
  });
  afterAll(async () => {
    await h?.close();
  });

  it('has the majority without ledger_index and tx_hash when a lost_majority is newer than the got_majority (G5)', () => {
    const row = list.amendments.find((a: { id: string }) => a.id === REGAINED);
    expect(row.status).toBe('majority');
    expect(row.majority).toEqual({
      since: time(now - 2 * DAY),
      expected_activation: time(now - 2 * DAY + HOLD_XRPL),
    });
  });

  it('keeps them for an amendment whose newest event is the got_majority', () => {
    const row = list.amendments.find((a: { id: string }) => a.id === KEPT);
    expect(row.majority).toMatchObject({
      ledger_index: 107_700_001,
      tx_hash: enableHash(107_700_001, KEPT, 0x10000),
    });
  });

  it('still lists the events of the earlier majority in the history', async () => {
    const d = (await (await h.api()).ok(detailOf(REGAINED))).body;
    expect(d.history.map((e: { event: string }) => e.event)).toEqual(['got_majority', 'lost_majority']);
  });
});

describe('GET /v2/network/amendments: IDs written in lower case', () => {
  const X = 'AB'.repeat(32);
  const ENABLED = 'EF'.repeat(32);
  let h: Harness;
  let api: ApiClient;
  let list: Record<string, any>;

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', network: 'xrpl', env: { ...NO_RATE_LIMIT, GH_AMENDMENTS_CONFIG: FIXTURE } });
    api = await h.api();
    const [a, b] = fleet('xrpl', 2);
    const now = Math.floor(Date.now() / 1000);
    await insertSeen(
      h.ch,
      [a, b].map((m) => ({ key: m.key, first: now - DAY, last: now - 30 })),
    );
    // everything a writer could have written in lower case: the ledger state, the node, the votes, the tallies, the index
    await insertState(h.ch, [
      {
        ledger_index: HEAD_LEDGER,
        polled_at: now - 5,
        amendments: [ENABLED.toLowerCase()],
        majorities: [{ amendment: X.toLowerCase(), since: now - DAY }],
      },
    ]);
    await insertFeatures(h.ch, [{ amendment_id: X.toLowerCase(), name: 'WrittenInLower', polled_at: now - 60 }]);
    await insertEnableAmendments(h.ch, [
      { amendment: X.toLowerCase(), flags: 0x10000, ledgerIndex: 107_700_001, closeTime: now - DAY + 5 },
    ]);
    await insertRound(h.ch, {
      ledgerIndex: VOTING_LEDGER,
      closeTime: now - 600,
      version: 1,
      unl: [a.key, b.key],
      votes: [
        { key: a.key, amendments: [X.toLowerCase()] },
        { key: b.key, amendments: [] },
      ],
      tallies: [{ id: X.toLowerCase(), yes: 1 }],
    });
    list = (await api.ok(LIST)).body;
  });
  afterAll(async () => {
    await h?.close();
  });

  it('serves every ID in upper case, and finds what was written in lower case', () => {
    for (const a of list.amendments) expect(a.id).toBe(a.id.toUpperCase());
    expect(list.amendments.find((a: { id: string }) => a.id === ENABLED)).toEqual({ id: ENABLED, status: 'enabled' });
    expect(list.amendments.find((a: { id: string }) => a.id === X)).toEqual({
      id: X,
      name: 'WrittenInLower',
      status: 'majority',
      node_supported: true,
      votes: { ledger_index: VOTING_LEDGER, yes: 1, trusted: 2, needed: 2, pct: 50 },
      majority: {
        since: expect.any(String),
        ledger_index: 107_700_001,
        tx_hash: enableHash(107_700_001, X.toLowerCase(), 0x10000),
        expected_activation: expect.any(String),
      },
    });
  });

  it('counts the votes and the rounds of an amendment written in lower case', async () => {
    const d = (await api.ok(detailOf(X.toLowerCase()))).body;
    expect(d.id).toBe(X);
    expect(d.unl_votes.map((v: { vote: string }) => v.vote).sort()).toEqual(['no', 'yes']);
    expect(d.rounds).toMatchObject([{ ledger_index: VOTING_LEDGER, yes: 1, trusted: 2, passes: false }]);
    expect(d.history).toHaveLength(1);
  });
});

// ===================================================================================================================
// the metadata files that ship
// ===================================================================================================================

describe('the metadata file of the network (GH_AMENDMENTS_CONFIG left empty)', () => {
  describe('XRPL', () => {
    const config = loadAmendmentsConfig(getNetworkProfile('xrpl'));
    const withUrl = config.amendments.find((a) => a.xls_url !== undefined && a.enabled?.ledger_index !== undefined);
    const obsolete = config.amendments.find((a) => a.obsolete === true);
    let h: Harness;
    let list: Record<string, any>;

    beforeAll(async () => {
      if (!withUrl || !obsolete)
        throw new Error('the XRPL file has no entry with an xls_url and a ledger, or no obsolete one');
      h = await startHarness({ seed: 'none', network: 'xrpl', env: NO_RATE_LIMIT });
      await insertState(h.ch, [{ ledger_index: HEAD_LEDGER, polled_at: Date.now() / 1000, amendments: [withUrl.id] }]);
      list = (await (await h.api()).ok(LIST)).body;
    });
    afterAll(async () => {
      await h?.close();
    });

    it('names, describes and dates an amendment from the file: enabled with source metadata, and the standard linked', () => {
      const found = list.amendments.find((a: { id: string }) => a.id === withUrl?.id);
      expect(found).toMatchObject({
        name: withUrl?.name,
        status: 'enabled',
        xls_url: withUrl?.xls_url,
        enabled: { ledger_index: withUrl?.enabled?.ledger_index, source: 'metadata' },
      });
      expect(found.xls_url).toMatch(/^https:\/\/github\.com\/XRPLF\/XRPL-Standards\//);
    });

    it('has every amendment of the file, the obsolete ones obsolete and the rest voting', () => {
      expect(list.count).toBe(config.amendments.length);
      expect(list.counts.obsolete).toBe(config.amendments.filter((a) => a.obsolete === true).length);
      const found = list.amendments.find((a: { id: string }) => a.id === obsolete?.id);
      expect(found).toMatchObject({ name: obsolete?.name, status: 'obsolete' });
    });
  });

  describe('Xahau', () => {
    const profile = getNetworkProfile('xahau');
    const config = loadAmendmentsConfig(profile);
    const retired = config.amendments.find((a) => a.retired === true);
    const voting = config.amendments.find((a) => a.retired !== true && a.obsolete !== true && a.enabled === undefined);
    const xrplName = config.amendments.find((a) => a.obsolete === true);
    let h: Harness;
    let list: Record<string, any>;
    let now: number;

    beforeAll(async () => {
      if (!retired || !voting || !xrplName)
        throw new Error('the Xahau file lacks a retired, a plain and an obsolete entry');
      h = await startHarness({ seed: 'none', network: 'xahau', env: NO_RATE_LIMIT });
      now = Math.floor(Date.now() / 1000);
      await insertLedgers(h.ch, 26_633_500, now - 8, 10, 4);
      await insertState(h.ch, [
        { ledger_index: 26_633_500, polled_at: now - 5, majorities: [{ amendment: voting.id, since: now - DAY }] },
      ]);
      list = (await (await h.api()).ok(LIST)).body;
    });
    afterAll(async () => {
      await h?.close();
    });

    it('holds a majority for 5 days: the rules and the expected activation', () => {
      expect(list.rules).toEqual({ threshold_percent: 80, majority_hold_seconds: HOLD_XAHAU, flag_interval: 256 });
      const found = list.amendments.find((a: { id: string }) => a.id === voting?.id);
      expect(found.status).toBe('majority');
      expect(found.majority).toEqual({
        since: time(now - DAY),
        expected_activation: time(now - DAY + HOLD_XAHAU),
      });
    });

    it('has a retired name enabled, and retired, with no enabled object', () => {
      const found = list.amendments.find((a: { id: string }) => a.id === retired?.id);
      expect(found).toEqual({ id: retired?.id, name: retired?.name, status: 'enabled', retired: true });
    });

    it('has an XRPL-era name that Xahau never uses obsolete', () => {
      const found = list.amendments.find((a: { id: string }) => a.id === xrplName?.id);
      expect(found).toMatchObject({ name: xrplName?.name, status: 'obsolete' });
      expect(found).not.toHaveProperty('retired');
    });

    it('serves the detail of a retired name by its name', async () => {
      const d = (await (await h.api()).ok(detailOf(retired?.name ?? ''))).body;
      expect(d).toMatchObject({ id: retired?.id, status: 'enabled', retired: true, rounds: [], history: [] });
      expect(d.rules.majority_hold_seconds).toBe(HOLD_XAHAU);
    });
  });
});

describe('GET /v2/network/amendments: an empty database', () => {
  const config = loadAmendmentsConfig(getNetworkProfile('xrpl'));
  let h: Harness;
  let list: Record<string, any>;

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', network: 'xrpl', env: NO_RATE_LIMIT });
    list = (await (await h.api()).ok(LIST)).body;
  });
  afterAll(async () => {
    await h?.close();
  });

  it('answers 200 with the rules and the amendments of the file, and no ledger, round or flag ledger', () => {
    expect(Object.keys(list)).toEqual(['result', 'rules', 'counts', 'count', 'amendments']);
    expect(list.rules).toEqual({ threshold_percent: 80, majority_hold_seconds: HOLD_XRPL, flag_interval: 256 });
    expect(list.count).toBe(config.amendments.length);
    expect(list.counts.majority).toBe(0);
    expect(list.counts.unknown).toBe(0);
    for (const a of list.amendments) expect(a).not.toHaveProperty('votes');
  });

  it('answers the detail of an amendment of the file with no members and no rounds', async () => {
    const name = config.amendments.find((a) => a.obsolete !== true)?.name ?? '';
    const d = (await (await h.api()).ok(detailOf(name))).body;
    expect(d).toMatchObject({ result: 'success', unl_votes: [], other_votes: [], rounds: [], history: [] });
    expect(d).not.toHaveProperty('round');
  });
});

// ===================================================================================================================
// failures
// ===================================================================================================================

describe('GET /v2/network/amendments: when ClickHouse fails', () => {
  let h: Harness;

  beforeAll(async () => {
    // an app that has built nothing yet: a built assembly is answered from the cache for 10 s
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('is a failure of the route: 500 unable to retrieve amendments, no-store, and the failure is not cached', async () => {
    const api = await h.api();
    const spy = jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('Code: 241. Memory limit exceeded'));
    for (const path of [LIST, detailOf(BOARD_NAMES.majority)]) {
      const failed = await api.get(path);
      expect([path, failed.status, failed.body]).toEqual([
        path,
        500,
        { result: 'error', message: 'unable to retrieve amendments' },
      ]);
      expect(failed.headers['cache-control']).toBe('no-store');
      // the cause is not sent
      expect(JSON.stringify(failed.body)).not.toContain('Memory limit');
    }
    spy.mockRestore();
    const recovered = await api.get(LIST);
    expect(recovered.status).toBe(200);
    expect(recovered.headers['cache-control']).toBe('private, max-age=60');
  });

  it('is a 400 before it reads anything for a status it does not know', async () => {
    const spy = jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('down'));
    const refused = await (await h.api()).get(`${LIST}?status=nope`);
    expect([refused.status, refused.body]).toEqual([400, { result: 'error', message: 'invalid status' }]);
    spy.mockRestore();
  });
});

describe('GET /v2/network/amendments: when only a read of the amendments fails', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('fails the same with the directory built, and the failure is not cached', async () => {
    const api = await h.api();
    expect((await api.get('/v2/network/validators/summary')).status).toBe(200);
    const original = h.ch.query.bind(h.ch);
    const spy = jest
      .spyOn(h.ch, 'query')
      .mockImplementation(((sql: string, p: Record<string, unknown> = {}, s?: object) =>
        sql.includes(Table.AmendmentFeatures)
          ? Promise.reject(new Error('down'))
          : original(sql, p, s as never)) as never);
    for (const path of [LIST, detailOf(BOARD_NAMES.majority)]) {
      const failed = await api.get(path);
      expect([path, failed.status, failed.body]).toEqual([
        path,
        500,
        { result: 'error', message: 'unable to retrieve amendments' },
      ]);
      expect(failed.headers['cache-control']).toBe('no-store');
    }
    spy.mockRestore();
    expect((await api.get(LIST)).status).toBe(200);
  });
});

describe('GET /v2/network/amendments: with GH_CACHE_CONTROL empty', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: { ...NO_RATE_LIMIT, GH_CACHE_CONTROL: '' } });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('sends no-store on an error and no Cache-Control on a success', async () => {
    const api = await h.api();
    const ok = await api.get(LIST);
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBeUndefined();
    const detail = await api.get(detailOf(loadAmendmentsConfig(getNetworkProfile('xrpl')).amendments[0].name));
    expect(detail.status).toBe(200);
    expect(detail.headers['cache-control']).toBeUndefined();
    const missing = await api.get(detailOf('NoSuchAmendment'));
    expect(missing.status).toBe(404);
    expect(missing.headers['cache-control']).toBe('no-store');
  });
});

// ===================================================================================================================
// the caches
// ===================================================================================================================

describe('GET /v2/network/amendments: the assembly is built once', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', network: 'xrpl', env: { ...NO_RATE_LIMIT, GH_AMENDMENTS_CONFIG: FIXTURE } });
    await seedAmendmentBoard(h.ch);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('builds once for requests that come together, and reads the rounds of an amendment once for 10 s', async () => {
    const api = await h.api();
    const features = await readsOf(h, Table.AmendmentFeatures, async () => {
      const answers = await Promise.all([
        api.get(LIST),
        api.get(detailOf(BOARD_NAMES.voting)),
        api.get(LIST),
        api.get(detailOf(BOARD_NAMES.majority)),
      ]);
      expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200]);
    });
    expect(features).toHaveLength(1);

    // a later request within the 10 s is served from the assembly: no read of the node features at all
    const later = await readsOf(h, Table.AmendmentFeatures, async () => {
      expect((await api.get(LIST)).status).toBe(200);
      expect((await api.get(detailOf(BOARD_NAMES.voting))).status).toBe(200);
    });
    expect(later).toHaveLength(0);

    // the rounds of one amendment are read once for requests of the same 10 s; the next amendment has its own read
    const again = await readsOf(h, Table.AmendmentTallies, async () => {
      await api.get(detailOf(BOARD_NAMES.voting));
      await api.get(detailOf(BOARD_NAMES.voting));
    });
    expect(again).toHaveLength(0);
    const fresh = await readsOf(h, Table.AmendmentTallies, async () => {
      await api.get(detailOf(BOARD_NAMES.obsolete));
      await api.get(detailOf(BOARD_NAMES.obsolete));
    });
    expect(fresh).toHaveLength(1);
  });
});

// ===================================================================================================================
// a file that fails the boot
// ===================================================================================================================

describe('GH_AMENDMENTS_CONFIG', () => {
  it('fails the boot of the API when the file is invalid, and says which entry', async () => {
    await expect(startHarness({ seed: 'none', env: { GH_AMENDMENTS_CONFIG: INVALID } })).rejects.toThrow(
      /Invalid amendments config: amendments\[0\] \(TestBadUrl\): xls_url: must use https:/,
    );
  });

  it('fails the boot when the file is missing', async () => {
    await expect(
      startHarness({ seed: 'none', env: { GH_AMENDMENTS_CONFIG: join(__dirname, 'support', 'no-such-file.json') } }),
    ).rejects.toThrow(/Invalid amendments config: .*no-such-file\.json/);
  });

  it('fails the boot when the file is for the other network', async () => {
    await expect(
      startHarness({ seed: 'none', network: 'xahau', env: { GH_AMENDMENTS_CONFIG: FIXTURE } }),
    ).rejects.toThrow(/Invalid amendments config: network/);
  });

  it('reads the file the variable names instead of the one that ships', async () => {
    const h = await startHarness({
      seed: 'none',
      network: 'xrpl',
      env: { ...NO_RATE_LIMIT, GH_AMENDMENTS_CONFIG: FIXTURE },
    });
    try {
      const list = (await (await h.api()).ok(LIST)).body;
      expect(list.count).toBe(6);
      expect(list.amendments.map((a: { name: string }) => a.name).sort()).toEqual(Object.values(BOARD_NAMES).sort());
    } finally {
      await h.close();
    }
  });
});
