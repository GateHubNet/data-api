import { deepFreeze } from '../../../../packages/shared/src/test-utils/deep-freeze';
import { AgreementWindow, DailyAgreement } from './agreement-windows';
import { AmendmentStatus, AmendmentView } from './amendment-status';
import { DirectoryEntry, DomainState, RecordRow } from './directory';
import {
  AGREEMENT_KEYS,
  buildValidatorsBody,
  DAILY_KEYS,
  DETAIL_AMENDMENT_VOTES_KEYS,
  DETAIL_TAIL_KEYS,
  DOMAIN_VERIFICATION_KEYS,
  FEE_VOTE_KEYS,
  LIST_BODY_KEYS,
  MANIFEST_KEYS,
  ROW_AMENDMENT_VOTES_KEYS,
  VALIDATOR_ROW_KEYS,
  validatorDetail,
  validatorRow,
  VOTE_ENTRY_KEYS,
  YES_ENTRY_KEYS,
} from './validator-object';

const NOW = Date.UTC(2026, 9, 19, 15, 42, 53) / 1000;

const ID_MAJORITY = '98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76';
const ID_VOTING = 'C98D98EE9616ACD36E81FDEB8D41D349BF5F1B41DD64A0ABC1FE9AA5EA267E9C';
const ID_UNKNOWN = '22'.repeat(32);
const ID_ENABLED = '33'.repeat(32);
const ID_OBSOLETE = '44'.repeat(32);
const ID_IDLE = '55'.repeat(32);

const view = (id: string, status: AmendmentStatus, name?: string): AmendmentView => ({
  id,
  ...(name === undefined ? {} : { name }),
  status,
  history: [],
});

/** The amendments in list order: majority, voting, voting, unknown, enabled, obsolete. */
const VIEWS: AmendmentView[] = [
  view(ID_MAJORITY, 'majority'),
  view(ID_VOTING, 'voting', 'XChainBridge'),
  view(ID_IDLE, 'voting', 'Idle'),
  view(ID_UNKNOWN, 'unknown'),
  view(ID_ENABLED, 'enabled', 'Enabled'),
  view(ID_OBSOLETE, 'obsolete', 'Obsolete'),
];
const AMENDMENTS = deepFreeze({ amendments: VIEWS, byId: new Map(VIEWS.map((each) => [each.id, each])) });

const window = (over: Partial<AgreementWindow> = {}): AgreementWindow => ({
  missed: 4,
  total: 22_096,
  score: '0.9998',
  incomplete: false,
  partial: 1,
  ...over,
});

const day = (date: string, over: Partial<AgreementWindow> = {}): DailyAgreement => ({ date, ...window(over) });

const record = (over: Partial<RecordRow> = {}): RecordRow => ({
  ledger_index: 107_748_095,
  validation_public_key: 'nHFull',
  close_time: NOW - 600,
  full: 1,
  amendments: [ID_MAJORITY],
  base_fee: '12',
  reserve_base: null,
  reserve_inc: null,
  server_version: null,
  ...over,
});

const VERIFIED: DomainState = {
  status: 'verified',
  tomlUrl: 'https://northpeak.example/.well-known/xrp-ledger.toml',
  checked: NOW - 600.511,
  verified: NOW - 600.511,
  accounts: ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
};

/** A validator with a value for every field of the row. */
const FULL: DirectoryEntry = {
  key: 'nHFull',
  domain: 'northpeak.example',
  signingKey: 'n9Signing',
  manifest: { sequence: 4, signingKey: 'n9Signing', signingKeysSeen: 4, domain: 'northpeak.example' },
  domainState: VERIFIED,
  currentIndex: 107_748_183,
  partial: false,
  agreement1h: window({ missed: 0, total: 921, score: '1.0000', partial: 0 }),
  agreement24h: window(),
  agreement30d: window({ missed: 152, total: 662_880, partial: 9 }),
  daily: [day('2026-09-20', { missed: 2, total: 22_101, score: '0.9999', partial: 0 }), day('2026-09-21')],
  unl: true,
  unlLists: ['unl.xrplf.org', 'vl.ripple.com'],
  negativeUnl: false,
  version: { version: '3.4.1', triple: [3, 4, 1], release: true, stage: 3 },
  serverVersion: '1745992596280311808',
  versionLatest: true,
  record: record({ amendments: [ID_MAJORITY, ID_VOTING] }),
  recordFees: { base_fee: '12', reserve_base: '1000000', reserve_inc: '200000' },
  firstSeen: NOW - 90 * 86_400,
  lastSeen: NOW - 2.796,
  seen24h: true,
  listed: true,
};

/** A validator on a list that was never seen and has nothing else. */
const BARE: DirectoryEntry = {
  key: 'nHBare',
  agreement1h: window({ missed: 0, total: 0, score: undefined, incomplete: false, partial: 0 }),
  agreement24h: window({ missed: 0, total: 0, score: undefined, incomplete: false, partial: 0 }),
  agreement30d: window({ missed: 0, total: 0, score: undefined, incomplete: true, partial: 0 }),
  daily: [],
  unl: true,
  unlLists: ['vl.ripple.com'],
  negativeUnl: false,
  seen24h: false,
  listed: true,
};

describe('the key constants', () => {
  it('state the keys of the specification, in order', () => {
    expect([...LIST_BODY_KEYS]).toEqual(['result', 'count', 'marker', 'validators']);
    expect([...VALIDATOR_ROW_KEYS]).toEqual([
      'validation_public_key',
      'domain',
      'current_index',
      'agreement_1h',
      'agreement_24h',
      'partial',
      'unl',
      'agreement_30d',
      'signing_key',
      'domain_verification',
      'unl_lists',
      'negative_unl',
      'version',
      'version_build',
      'version_latest',
      'server_version',
      'fee_vote',
      'amendment_votes',
      'first_seen',
      'last_seen',
    ]);
    expect([...AGREEMENT_KEYS]).toEqual(['missed', 'total', 'score', 'incomplete', 'partial']);
    expect([...DOMAIN_VERIFICATION_KEYS]).toEqual([
      'status',
      'reason',
      'status_code',
      'toml_url',
      'checked',
      'verified',
      'accounts',
    ]);
    expect([...FEE_VOTE_KEYS]).toEqual(['ledger_index', 'base_fee', 'reserve_base', 'reserve_inc']);
    expect([...ROW_AMENDMENT_VOTES_KEYS]).toEqual(['ledger_index', 'yes']);
    expect([...YES_ENTRY_KEYS]).toEqual(['id', 'name']);
    expect([...DETAIL_AMENDMENT_VOTES_KEYS]).toEqual(['ledger_index', 'yes', 'votes']);
    expect([...VOTE_ENTRY_KEYS]).toEqual(['id', 'name', 'status', 'vote']);
    expect([...DETAIL_TAIL_KEYS]).toEqual(['manifest', 'daily_agreement', 'result']);
    expect([...MANIFEST_KEYS]).toEqual(['sequence', 'signing_key', 'signing_keys_seen', 'domain']);
    expect([...DAILY_KEYS]).toEqual(['date', 'missed', 'total', 'score', 'incomplete', 'partial']);
  });
});

describe('validatorRow', () => {
  it('is the row of the specification for a validator with a value for everything', () => {
    expect(validatorRow(FULL, AMENDMENTS)).toEqual({
      validation_public_key: 'nHFull',
      domain: 'northpeak.example',
      current_index: 107_748_183,
      agreement_1h: { missed: 0, total: 921, score: '1.0000', incomplete: false, partial: 0 },
      agreement_24h: { missed: 4, total: 22_096, score: '0.9998', incomplete: false, partial: 1 },
      partial: false,
      unl: true,
      agreement_30d: { missed: 152, total: 662_880, score: '0.9998', incomplete: false, partial: 9 },
      signing_key: 'n9Signing',
      domain_verification: {
        status: 'verified',
        toml_url: 'https://northpeak.example/.well-known/xrp-ledger.toml',
        checked: '2026-10-19T15:32:52.489Z',
        verified: '2026-10-19T15:32:52.489Z',
        accounts: ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
      },
      unl_lists: ['unl.xrplf.org', 'vl.ripple.com'],
      negative_unl: false,
      version: '3.4.1',
      version_latest: true,
      server_version: '1745992596280311808',
      fee_vote: { ledger_index: 107_748_095, base_fee: '0.000012', reserve_base: '1', reserve_inc: '0.2' },
      amendment_votes: {
        ledger_index: 107_748_095,
        yes: [{ id: ID_MAJORITY }, { id: ID_VOTING, name: 'XChainBridge' }],
      },
      first_seen: '2026-07-21T15:42:53.000Z',
      last_seen: '2026-10-19T15:42:50.204Z',
    });
  });

  it('lists its keys in the order of VALIDATOR_ROW_KEYS', () => {
    const withBuild: DirectoryEntry = {
      ...FULL,
      version: { version: '2026.10.13', build: 4119, triple: [2026, 10, 13], release: true, stage: 3 },
    };
    const row = validatorRow(withBuild, AMENDMENTS);
    expect(Object.keys(row)).toEqual([...VALIDATOR_ROW_KEYS]);
    expect(Object.keys(row.agreement_1h)).toEqual([...AGREEMENT_KEYS]);
    expect(Object.keys(row.agreement_24h)).toEqual([...AGREEMENT_KEYS]);
    expect(Object.keys(row.agreement_30d)).toEqual([...AGREEMENT_KEYS]);
    expect(Object.keys(row.domain_verification ?? {})).toEqual(
      [...DOMAIN_VERIFICATION_KEYS].filter((k) => k !== 'reason' && k !== 'status_code'),
    );
    expect(Object.keys(row.fee_vote ?? {})).toEqual([...FEE_VOTE_KEYS]);
    expect(Object.keys(row.amendment_votes ?? {})).toEqual([...ROW_AMENDMENT_VOTES_KEYS]);
    expect(Object.keys(row.amendment_votes?.yes[1] ?? {})).toEqual([...YES_ENTRY_KEYS]);
  });

  it('has the build number of a validator right after its version (Xahau)', () => {
    const row = validatorRow(
      { ...FULL, version: { version: '2026.10.13', build: 4119, triple: [2026, 10, 13], release: true, stage: 3 } },
      AMENDMENTS,
    );
    expect(row.version).toBe('2026.10.13');
    expect(row.version_build).toBe(4119);
    const keys = Object.keys(row);
    expect(keys.indexOf('version_build')).toBe(keys.indexOf('version') + 1);
  });

  it('leaves out every key a validator has no value for, and never has a null', () => {
    const row = validatorRow(BARE, AMENDMENTS);
    expect(row).toEqual({
      validation_public_key: 'nHBare',
      agreement_1h: { missed: 0, total: 0, incomplete: false, partial: 0 },
      agreement_24h: { missed: 0, total: 0, incomplete: false, partial: 0 },
      unl: true,
      agreement_30d: { missed: 0, total: 0, incomplete: true, partial: 0 },
      unl_lists: ['vl.ripple.com'],
      negative_unl: false,
    });
    expect(JSON.stringify(row)).not.toContain('null');
    expect(Object.keys(row)).toEqual(VALIDATOR_ROW_KEYS.filter((key) => key in row));
  });

  it('has no version_latest and no build without a version, and the server version as text on its own', () => {
    const row = validatorRow({ ...FULL, version: undefined, versionLatest: undefined, serverVersion: '5' }, AMENDMENTS);
    expect(row).not.toHaveProperty('version');
    expect(row).not.toHaveProperty('version_build');
    expect(row).not.toHaveProperty('version_latest');
    expect(row.server_version).toBe('5');
  });

  it('has version_latest false for a validator behind the latest', () => {
    expect(validatorRow({ ...FULL, versionLatest: false }, AMENDMENTS).version_latest).toBe(false);
  });

  it('has partial for the kind of the newest validation, true or false', () => {
    expect(validatorRow({ ...FULL, partial: true }, AMENDMENTS).partial).toBe(true);
    expect(validatorRow({ ...FULL, partial: false }, AMENDMENTS).partial).toBe(false);
    expect(validatorRow({ ...FULL, partial: undefined, currentIndex: undefined }, AMENDMENTS)).not.toHaveProperty(
      'current_index',
    );
  });

  it('has the negative UNL flag and the sorted lists as the directory has them', () => {
    const row = validatorRow({ ...FULL, negativeUnl: true, unlLists: [] }, AMENDMENTS);
    expect(row.negative_unl).toBe(true);
    expect(row.unl_lists).toEqual([]);
  });

  describe('fee_vote', () => {
    it('is in whole units, exact: 12 drops is 0.000012, a million 1, 200,000 0.2', () => {
      expect(validatorRow(FULL, AMENDMENTS).fee_vote).toEqual({
        ledger_index: 107_748_095,
        base_fee: '0.000012',
        reserve_base: '1',
        reserve_inc: '0.2',
      });
    });

    it('takes the fields the validation left out from recordFees, which the directory filled from its round', () => {
      const filled = validatorRow(
        {
          ...FULL,
          record: record({ base_fee: null, reserve_base: null, reserve_inc: null }),
          recordFees: { base_fee: '10', reserve_base: '10000000', reserve_inc: '2000000' },
        },
        AMENDMENTS,
      );
      expect(filled.fee_vote).toEqual({
        ledger_index: 107_748_095,
        base_fee: '0.00001',
        reserve_base: '10',
        reserve_inc: '2',
      });
    });

    it('is exact for drops no float holds', () => {
      const row = validatorRow(
        { ...FULL, recordFees: { base_fee: '1', reserve_base: '123456789012345678', reserve_inc: '3' } },
        AMENDMENTS,
      );
      expect(row.fee_vote).toMatchObject({
        base_fee: '0.000001',
        reserve_base: '123456789012.345678',
        reserve_inc: '0.000003',
      });
    });

    it('is absent without a record, or when the fees are not known', () => {
      expect(validatorRow({ ...FULL, record: undefined, recordFees: undefined }, AMENDMENTS)).not.toHaveProperty(
        'fee_vote',
      );
      expect(validatorRow({ ...FULL, recordFees: undefined }, AMENDMENTS)).not.toHaveProperty('fee_vote');
    });
  });

  describe('amendment_votes', () => {
    it('is absent without a record', () => {
      expect(validatorRow({ ...FULL, record: undefined, recordFees: undefined }, AMENDMENTS)).not.toHaveProperty(
        'amendment_votes',
      );
    });

    it('lists the yes votes in the order of the record, with a name where one is known', () => {
      const row = validatorRow(
        { ...FULL, record: record({ amendments: [ID_VOTING, ID_MAJORITY, ID_UNKNOWN, ID_ENABLED] }) },
        AMENDMENTS,
      );
      expect(row.amendment_votes).toEqual({
        ledger_index: 107_748_095,
        yes: [
          { id: ID_VOTING, name: 'XChainBridge' },
          { id: ID_MAJORITY },
          { id: ID_UNKNOWN },
          { id: ID_ENABLED, name: 'Enabled' },
        ],
      });
    });

    it('is an empty yes for a record that votes for nothing', () => {
      const row = validatorRow({ ...FULL, record: record({ amendments: [] }) }, AMENDMENTS);
      expect(row.amendment_votes).toEqual({ ledger_index: 107_748_095, yes: [] });
    });

    it('writes an ID as upper-case hex and finds its name whatever the case the record has', () => {
      const row = validatorRow({ ...FULL, record: record({ amendments: [ID_VOTING.toLowerCase()] }) }, AMENDMENTS);
      expect(row.amendment_votes?.yes).toEqual([{ id: ID_VOTING, name: 'XChainBridge' }]);
    });

    it('names an ID the amendments do not know with nothing', () => {
      const row = validatorRow({ ...FULL, record: record({ amendments: ['AB'.repeat(32)] }) }, AMENDMENTS);
      expect(row.amendment_votes?.yes).toEqual([{ id: 'AB'.repeat(32) }]);
    });
  });

  describe('domain_verification', () => {
    const verification = (state: DomainState | undefined) =>
      validatorRow({ ...FULL, domainState: state }, AMENDMENTS).domain_verification;

    it('is absent without a domain', () => {
      expect(verification(undefined)).toBeUndefined();
      expect(validatorRow({ ...FULL, domain: undefined, domainState: undefined }, AMENDMENTS)).not.toHaveProperty(
        'domain_verification',
      );
    });

    it('is pending without a check: the address it will be checked at, nothing else', () => {
      expect(verification({ status: 'pending', tomlUrl: 'https://north.example/.well-known/xahau.toml' })).toEqual({
        status: 'pending',
        toml_url: 'https://north.example/.well-known/xahau.toml',
      });
    });

    it('is unverified with its reason, the status code of an http_status, and when it was checked', () => {
      expect(
        verification({
          status: 'unverified',
          reason: 'http_status',
          statusCode: 404,
          tomlUrl: 'https://a.example/.well-known/xrp-ledger.toml',
          checked: NOW - 60.25,
        }),
      ).toEqual({
        status: 'unverified',
        reason: 'http_status',
        status_code: 404,
        toml_url: 'https://a.example/.well-known/xrp-ledger.toml',
        checked: '2026-10-19T15:41:52.750Z',
      });
      const keys = Object.keys(
        verification({
          status: 'unverified',
          reason: 'http_status',
          statusCode: 404,
          tomlUrl: 'u',
          checked: NOW - 60.25,
        }) ?? {},
      );
      expect(keys).toEqual(['status', 'reason', 'status_code', 'toml_url', 'checked']);
    });

    it('is unverified with the last success a validator once had in verified', () => {
      expect(
        verification({
          status: 'unverified',
          reason: 'not_listed',
          tomlUrl: 'https://a.example/.well-known/xrp-ledger.toml',
          checked: NOW - 60,
          verified: NOW - 86_400,
        }),
      ).toEqual({
        status: 'unverified',
        reason: 'not_listed',
        toml_url: 'https://a.example/.well-known/xrp-ledger.toml',
        checked: '2026-10-19T15:41:53.000Z',
        verified: '2026-10-18T15:42:53.000Z',
      });
    });

    it('has the accounts of a domain that verified, last', () => {
      const result = verification(VERIFIED);
      expect(result?.accounts).toEqual(['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh']);
      expect(Object.keys(result ?? {}).pop()).toBe('accounts');
    });

    it('has accounts only with verified, and none when the list is empty', () => {
      const unverified: DomainState = {
        status: 'unverified',
        reason: 'not_listed',
        tomlUrl: 'u',
        checked: NOW,
        verified: NOW - 86_400,
        accounts: ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
      };
      expect(verification(unverified)).not.toHaveProperty('accounts');
      expect(verification({ ...VERIFIED, accounts: [] })).not.toHaveProperty('accounts');
      expect(verification({ ...VERIFIED, accounts: undefined })).not.toHaveProperty('accounts');
      expect(
        verification({ status: 'pending', tomlUrl: 'u', accounts: ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'] }),
      ).not.toHaveProperty('accounts');
    });

    it('has reason only for unverified and status_code only for an http_status', () => {
      expect(verification({ ...VERIFIED, reason: 'oops', statusCode: 500 })).not.toHaveProperty('reason');
      expect(verification({ ...VERIFIED, reason: 'oops', statusCode: 500 })).not.toHaveProperty('status_code');
      expect(
        verification({ status: 'unverified', reason: 'timeout', statusCode: 500, tomlUrl: 'u', checked: NOW }),
      ).not.toHaveProperty('status_code');
    });
  });

  it('writes the instants of receipt with milliseconds', () => {
    const row = validatorRow({ ...FULL, firstSeen: 1_760_000_000.004, lastSeen: 1_760_000_000.9996 }, AMENDMENTS);
    expect(row.first_seen).toBe('2025-10-09T08:53:20.004Z');
    expect(row.last_seen).toBe('2025-10-09T08:53:21.000Z');
  });

  it('does not change the entry, and shares none of its arrays with the row', () => {
    const frozen = deepFreeze({
      ...FULL,
      unlLists: [...FULL.unlLists],
      domainState: { ...VERIFIED, accounts: [...(VERIFIED.accounts ?? [])] },
    });
    const row = validatorRow(frozen, AMENDMENTS);
    expect(row.unl_lists).not.toBe(frozen.unlLists);
    expect(row.domain_verification?.accounts).not.toBe(frozen.domainState?.accounts);
    row.unl_lists.push('x');
    expect(frozen.unlLists).toEqual(['unl.xrplf.org', 'vl.ripple.com']);
  });
});

describe('buildValidatorsBody', () => {
  it('has result, count and the rows, and the marker when there is one', () => {
    const body = buildValidatorsBody([FULL, BARE], 'WzAsIngiXQ', AMENDMENTS);
    expect(Object.keys(body)).toEqual([...LIST_BODY_KEYS]);
    expect(body.result).toBe('success');
    expect(body.count).toBe(2);
    expect(body.marker).toBe('WzAsIngiXQ');
    expect(body.validators.map((row) => row.validation_public_key)).toEqual(['nHFull', 'nHBare']);
  });

  it('has no marker key on the last page', () => {
    const body = buildValidatorsBody([BARE], undefined, AMENDMENTS);
    expect(Object.keys(body)).toEqual(['result', 'count', 'validators']);
  });

  it('is an empty list when nothing matches', () => {
    expect(buildValidatorsBody([], undefined, AMENDMENTS)).toEqual({ result: 'success', count: 0, validators: [] });
  });
});

describe('validatorDetail', () => {
  it('is the row, with amendment_votes in its place and the manifest, the days and the result after it', () => {
    const detail = validatorDetail(FULL, AMENDMENTS);
    // FULL is a rippled validator: no build number
    expect(Object.keys(detail)).toEqual(
      [...VALIDATOR_ROW_KEYS, ...DETAIL_TAIL_KEYS].filter((key) => key !== 'version_build'),
    );
    expect(detail.result).toBe('success');
    // everything but the votes and the tail is the row's
    const { amendment_votes: rowVotes, ...row } = validatorRow(FULL, AMENDMENTS);
    const { amendment_votes: votes, manifest, daily_agreement: daily, result, ...rest } = detail;
    expect(rest).toEqual(row);
    expect(manifest).toBeDefined();
    expect(daily).toBeDefined();
    expect(result).toBe('success');
    expect(votes.ledger_index).toBe(rowVotes?.ledger_index);
    expect(votes.yes).toEqual(rowVotes?.yes);
  });

  it('puts amendment_votes where the row has it even for a validator whose row has none', () => {
    const detail = validatorDetail({ ...BARE }, AMENDMENTS);
    expect(Object.keys(detail)).toEqual([
      'validation_public_key',
      'agreement_1h',
      'agreement_24h',
      'unl',
      'agreement_30d',
      'unl_lists',
      'negative_unl',
      'amendment_votes',
      'daily_agreement',
      'result',
    ]);
  });

  describe('amendment_votes', () => {
    it('has one vote for each amendment still being decided, in the order of the list, yes or no by the record', () => {
      const detail = validatorDetail(FULL, AMENDMENTS);
      expect(Object.keys(detail.amendment_votes)).toEqual([...DETAIL_AMENDMENT_VOTES_KEYS]);
      expect(detail.amendment_votes).toEqual({
        ledger_index: 107_748_095,
        yes: [{ id: ID_MAJORITY }, { id: ID_VOTING, name: 'XChainBridge' }],
        votes: [
          { id: ID_MAJORITY, status: 'majority', vote: 'yes' },
          { id: ID_VOTING, name: 'XChainBridge', status: 'voting', vote: 'yes' },
          { id: ID_IDLE, name: 'Idle', status: 'voting', vote: 'no' },
          { id: ID_UNKNOWN, status: 'unknown', vote: 'no' },
        ],
      });
      for (const vote of detail.amendment_votes.votes ?? []) {
        expect(Object.keys(vote)).toEqual(VOTE_ENTRY_KEYS.filter((key) => key in vote));
      }
    });

    it('leaves out the amendments that are enabled or obsolete', () => {
      const detail = validatorDetail(
        { ...FULL, record: record({ amendments: [ID_ENABLED, ID_OBSOLETE] }) },
        AMENDMENTS,
      );
      const ids = (detail.amendment_votes.votes ?? []).map((vote) => vote.id);
      expect(ids).toEqual([ID_MAJORITY, ID_VOTING, ID_IDLE, ID_UNKNOWN]);
      // the yes list still says what the validator voted for, enabled or not
      expect(detail.amendment_votes.yes.map((entry) => entry.id)).toEqual([ID_ENABLED, ID_OBSOLETE]);
    });

    it('gives an unknown amendment a vote with no name (G4)', () => {
      const detail = validatorDetail({ ...FULL, record: record({ amendments: [ID_UNKNOWN] }) }, AMENDMENTS);
      const unknown = (detail.amendment_votes.votes ?? []).find((vote) => vote.id === ID_UNKNOWN);
      expect(unknown).toEqual({ id: ID_UNKNOWN, status: 'unknown', vote: 'yes' });
    });

    it('is none for every amendment, without a ledger_index and with an empty yes, when the validator has no record', () => {
      const detail = validatorDetail({ ...FULL, record: undefined, recordFees: undefined }, AMENDMENTS);
      expect(Object.keys(detail.amendment_votes)).toEqual(['yes', 'votes']);
      expect(detail.amendment_votes.yes).toEqual([]);
      expect(detail.amendment_votes.votes?.map((vote) => vote.vote)).toEqual(['none', 'none', 'none', 'none']);
      expect(detail).not.toHaveProperty('fee_vote');
    });

    it('is empty when the network has no amendment being decided', () => {
      const none = { amendments: [], byId: new Map() };
      const detail = validatorDetail(FULL, none);
      expect(detail.amendment_votes.votes).toEqual([]);
      expect(detail.amendment_votes.yes).toEqual([{ id: ID_MAJORITY }, { id: ID_VOTING }]);
    });
  });

  describe('manifest', () => {
    it('is the sequence, the signing key, how many signing keys were seen and the domain', () => {
      const detail = validatorDetail(FULL, AMENDMENTS);
      expect(detail.manifest).toEqual({
        sequence: 4,
        signing_key: 'n9Signing',
        signing_keys_seen: 4,
        domain: 'northpeak.example',
      });
      expect(Object.keys(detail.manifest ?? {})).toEqual([...MANIFEST_KEYS]);
    });

    it('has no domain when the manifest has none', () => {
      const detail = validatorDetail(
        { ...FULL, manifest: { sequence: 1, signingKey: 'n9Signing', signingKeysSeen: 1 } },
        AMENDMENTS,
      );
      expect(detail.manifest).toEqual({ sequence: 1, signing_key: 'n9Signing', signing_keys_seen: 1 });
    });

    it('is absent for a validator with no manifest', () => {
      const detail = validatorDetail(BARE, AMENDMENTS);
      expect(detail).not.toHaveProperty('manifest');
      expect(detail).not.toHaveProperty('signing_key');
    });
  });

  describe('daily_agreement', () => {
    it('is the days of the entry, oldest first, with the keys of DAILY_KEYS', () => {
      const detail = validatorDetail(FULL, AMENDMENTS);
      expect(detail.daily_agreement).toEqual([
        { date: '2026-09-20', missed: 2, total: 22_101, score: '0.9999', incomplete: false, partial: 0 },
        { date: '2026-09-21', missed: 4, total: 22_096, score: '0.9998', incomplete: false, partial: 1 },
      ]);
      for (const entry of detail.daily_agreement) expect(Object.keys(entry)).toEqual([...DAILY_KEYS]);
    });

    it('has no score for a day with no ledger a validator was held to', () => {
      const detail = validatorDetail(
        {
          ...FULL,
          daily: [day('2026-09-20', { missed: 0, total: 0, score: undefined, incomplete: true, partial: 0 })],
        },
        AMENDMENTS,
      );
      expect(detail.daily_agreement).toEqual([
        { date: '2026-09-20', missed: 0, total: 0, incomplete: true, partial: 0 },
      ]);
      expect(Object.keys(detail.daily_agreement[0])).toEqual(['date', 'missed', 'total', 'incomplete', 'partial']);
    });

    it('is empty while no hour of agreement is final', () => {
      expect(validatorDetail(BARE, AMENDMENTS).daily_agreement).toEqual([]);
    });
  });

  it('never has a null, and changes nothing it was given', () => {
    const frozen = deepFreeze({ ...FULL });
    const detail = validatorDetail(frozen, AMENDMENTS);
    expect(JSON.stringify(detail)).not.toContain('null');
    detail.daily_agreement.push({ date: 'x', missed: 0, total: 0, incomplete: true, partial: 0 });
    detail.amendment_votes.yes.push({ id: 'x' });
    expect(frozen.daily).toHaveLength(2);
    expect(frozen.record?.amendments).toEqual([ID_MAJORITY, ID_VOTING]);
  });
});
