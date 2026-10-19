import {
  AMENDMENTS_OBJECT_INDEX,
  AmendmentsConfig,
  ClickHouseService,
  FEE_SETTINGS_OBJECT_INDEX,
  getNetworkProfile,
  loadAmendmentsConfig,
  NEGATIVE_UNL_OBJECT_INDEX,
  NodeClient,
  Table,
} from '@gatehub/data-api-shared';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import {
  featureRowsFrom,
  NETWORK_STATE_REQUEST_TIMEOUT_MS,
  NetworkStatePoller,
  networkStateRowFrom,
} from './network-state-poller';
import { ValidatorsWorkerOptions } from './validators.options';

const FIXTURES = join(__dirname, '../../../../packages/shared/test/fixtures');
type Network = 'xrpl' | 'xahau';

/** An answer of the node as `packages/shared/test/fixtures/<network>/network-state` holds it (recorded with `--network-state`). */
const recorded = (network: Network, name: string): Record<string, any> =>
  JSON.parse(readFileSync(join(FIXTURES, network, 'network-state', `${name}.json`), 'utf8'));

/** What the node served: the result, or (a recorded error message) the error `NodeClient.request` throws for it. */
function served(answer: Record<string, any>): Record<string, any> {
  if (answer.status !== 'error') return answer;
  throw Object.assign(new Error(answer.error_message ?? answer.error), { name: 'RippledError', data: answer });
}

const POLLED_AT = 1_760_000_000.123;
const RIPPLE_EPOCH = 946_684_800;
const ID_A = 'A'.repeat(64);
const ID_B = 'B'.repeat(64);
const ID_C = 'C'.repeat(64);
const KEY_HEX = 'EDC38F0AC1B575A6AAC59C60D375ABE2E270BF5FAF8B9DA4A010F3C35B44A4464C';
const KEY_BASE58 = 'nHUqZcdCzkccxHQJp43M7nTTbHDbj2Yv9R1ty8zM1zFbtQFPnDu7';
const KEY2_HEX = '03' + '1A'.repeat(32);

const amendmentsOf = (network: Network) => recorded(network, 'amendments') as Parameters<typeof networkStateRowFrom>[0];

/** The row of the answers recorded for a network. */
function recordedRow(network: Network) {
  const negativeUnl = recorded(network, 'negative_unl');
  return networkStateRowFrom(
    amendmentsOf(network),
    negativeUnl.status === 'error' ? undefined : negativeUnl.node,
    recorded(network, 'fee_settings').node,
    recorded(network, 'server_info').info.validation_quorum,
    POLLED_AT,
  );
}

/** The fee settings, hand-written for these tests (not recorded). */
const modernFees = { BaseFeeDrops: '10', ReserveBaseDrops: '1000000', ReserveIncrementDrops: '200000' };
/** An Amendments answer (hand-written) at ledger 100, or at whatever `ledger_index` says. */
const amendmentsWith = (node: Record<string, unknown> | undefined, ledger_index: unknown) =>
  ({ ledger_index, ledger_hash: '1A'.repeat(32), node }) as Parameters<typeof networkStateRowFrom>[0];
const amendmentsAt = (node: Record<string, unknown> | undefined) => amendmentsWith(node, 100);

describe('networkStateRowFrom', () => {
  describe('over the answers recorded from the XRPL (wss://s2.ripple.com)', () => {
    it('reads the Amendments object, the fees and the quorum, and the absent NegativeUNL as empty', () => {
      // what was recorded on 2026-10-19: the object does not exist, because no validator is disabled
      expect(recorded('xrpl', 'negative_unl')).toMatchObject({ error: 'entryNotFound', status: 'error' });
      const amendments = recorded('xrpl', 'amendments');
      const row = recordedRow('xrpl');
      expect(row).toEqual({
        ledger_index: 107760758,
        ledger_hash: '75B3F5DE8A04C31028C08CD612921551DEA6B16C3F3203D0F2B509221830EF19',
        polled_at: POLLED_AT,
        amendments: amendments.node.Amendments,
        majorities: [
          { amendment: '98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76', since: 1791538470 },
        ],
        negative_unl: [],
        to_disable: '',
        to_reenable: '',
        base_fee: '10',
        reserve_base: '1000000',
        reserve_inc: '200000',
        node_quorum: 28,
      });
      expect(row.amendments).toHaveLength(97);
    });

    it('turns the CloseTime of a majority, in Ripple time, into unix time', () => {
      const [majority] = recordedRow('xrpl').majorities;
      expect(recorded('xrpl', 'amendments').node.Majorities[0].Majority.CloseTime).toBe(844853670);
      expect(majority.since).toBe(844853670 + RIPPLE_EPOCH);
      expect(new Date(majority.since * 1000).toISOString()).toBe('2026-10-09T09:34:30.000Z');
    });
  });

  describe('over the answers recorded from Xahau (wss://xahau.network, ledger 26633715)', () => {
    it('reads the disabled validator with its key in base58 and the ledger it was disabled in', () => {
      // the NegativeUNL as the node served it: one validator, hex key
      expect(recorded('xahau', 'negative_unl').node.DisabledValidators).toEqual([
        { DisabledValidator: { FirstLedgerSequence: 26615296, PublicKey: KEY_HEX } },
      ]);
      const row = recordedRow('xahau');
      expect(row.negative_unl).toEqual([{ validation_public_key: KEY_BASE58, first_ledger: 26615296 }]);
      expect(row.to_disable).toBe('');
      expect(row.to_reenable).toBe('');
    });

    it('reads the rest of the object, its two majorities, the fees and the quorum of 0 the node reports', () => {
      const row = recordedRow('xahau');
      expect(row).toMatchObject({
        ledger_index: 26633715,
        ledger_hash: 'D6C133939B3B166C11F88645C4D5913C030D057B03DAEABA9EC73CF868362B80',
        polled_at: POLLED_AT,
        base_fee: '10',
        reserve_base: '1000000',
        reserve_inc: '200000',
        node_quorum: 0,
      });
      expect(row.amendments).toHaveLength(75);
      expect(row.majorities).toEqual([
        {
          amendment: '2339E37C9DCD516CABC37FE91C4BBBFBA3EA152FD45331C3C18F183129AEF65F',
          since: 845332143 + RIPPLE_EPOCH,
        },
        {
          amendment: '6902B1DEAFD9C05D0E897EBEF5A5F7C563D1F9681EA957C4C6B0874C8E009E1A',
          since: 845352140 + RIPPLE_EPOCH,
        },
      ]);
      expect(new Date(row.majorities[0].since * 1000).toISOString()).toBe('2026-10-14T22:29:03.000Z');
    });
  });

  describe('the fees', () => {
    const feesOf = (settings: Record<string, unknown>) => {
      const { base_fee, reserve_base, reserve_inc } = networkStateRowFrom(
        amendmentsAt({ Amendments: [] }),
        undefined,
        settings,
        undefined,
        POLLED_AT,
      );
      return { base_fee, reserve_base, reserve_inc };
    };

    it('reads the legacy form: BaseFee as hex, ReserveBase and ReserveIncrement as numbers (hand-written input)', () => {
      expect(feesOf({ BaseFee: '000000000000000A', ReserveBase: 10000000, ReserveIncrement: 2000000 })).toEqual({
        base_fee: '10',
        reserve_base: '10000000',
        reserve_inc: '2000000',
      });
    });

    it('reads a BaseFee in hex above 2^53 exactly', () => {
      expect(feesOf({ BaseFee: 'FFFFFFFFFFFFFFFF', ReserveBase: 1, ReserveIncrement: 2 }).base_fee).toBe(
        '18446744073709551615',
      );
    });

    it('reads the drops form', () => {
      expect(feesOf(modernFees)).toEqual({ base_fee: '10', reserve_base: '1000000', reserve_inc: '200000' });
    });

    it('takes the drops of a field before its legacy value, field by field', () => {
      expect(feesOf({ ...modernFees, BaseFee: '0000000000000063', ReserveBase: 5, ReserveIncrement: 6 })).toEqual({
        base_fee: '10',
        reserve_base: '1000000',
        reserve_inc: '200000',
      });
      expect(feesOf({ BaseFeeDrops: '12', ReserveBase: 77, ReserveIncrementDrops: '200000' })).toEqual({
        base_fee: '12',
        reserve_base: '77',
        reserve_inc: '200000',
      });
    });

    it('refuses fees that are missing or are not amounts', () => {
      expect(() => feesOf({})).toThrow(/BaseFeeDrops or BaseFee/);
      expect(() => feesOf({ BaseFeeDrops: '10', ReserveBaseDrops: '1' })).toThrow(
        /ReserveIncrementDrops or ReserveIncrement/,
      );
      expect(() => feesOf({ ...modernFees, BaseFeeDrops: 'ten' })).toThrow(/BaseFeeDrops/);
      expect(() => feesOf({ ...modernFees, BaseFeeDrops: '-1' })).toThrow(/BaseFeeDrops/);
      expect(() => feesOf({ ...modernFees, BaseFeeDrops: '18446744073709551616' })).toThrow(/BaseFeeDrops/);
      expect(() => feesOf({ BaseFee: 'XYZ', ReserveBase: 1, ReserveIncrement: 2 })).toThrow(/BaseFee/);
      expect(() => feesOf({ BaseFee: '0A', ReserveBase: 1.5, ReserveIncrement: 2 })).toThrow(/ReserveBase/);
    });
  });

  describe('the negative UNL (hand-written input)', () => {
    const rowOf = (negativeUnl: Record<string, unknown> | undefined) =>
      networkStateRowFrom(amendmentsAt({ Amendments: [] }), negativeUnl, modernFees, 28, POLLED_AT);

    it('has nothing in it when the object does not exist', () => {
      expect(rowOf(undefined)).toMatchObject({ negative_unl: [], to_disable: '', to_reenable: '' });
    });

    it('has nothing in it when the object has no fields', () => {
      expect(rowOf({ LedgerEntryType: 'NegativeUNL' })).toMatchObject({
        negative_unl: [],
        to_disable: '',
        to_reenable: '',
      });
    });

    it('keeps the order of the disabled validators, and turns the key of each into base58', () => {
      const row = rowOf({
        DisabledValidators: [
          { DisabledValidator: { FirstLedgerSequence: 300, PublicKey: KEY2_HEX } },
          { DisabledValidator: { FirstLedgerSequence: 200, PublicKey: KEY_HEX.toLowerCase() } },
        ],
      });
      expect(row.negative_unl).toEqual([
        { validation_public_key: expect.stringMatching(/^n9/), first_ledger: 300 },
        { validation_public_key: KEY_BASE58, first_ledger: 200 },
      ]);
    });

    it('turns the validator to disable and the one to re-enable into base58, and leaves the others empty', () => {
      expect(rowOf({ ValidatorToDisable: KEY_HEX })).toMatchObject({ to_disable: KEY_BASE58, to_reenable: '' });
      expect(rowOf({ ValidatorToReEnable: KEY_HEX })).toMatchObject({ to_disable: '', to_reenable: KEY_BASE58 });
    });

    it('refuses what is not a key or a ledger sequence', () => {
      const disabled = (PublicKey: unknown, FirstLedgerSequence: unknown = 5) => ({
        DisabledValidators: [{ DisabledValidator: { PublicKey, FirstLedgerSequence } }],
      });
      expect(() => rowOf(disabled('not hex'))).toThrow(/PublicKey/);
      expect(() => rowOf(disabled('04' + '00'.repeat(32)))).toThrow(/PublicKey/);
      expect(() => rowOf(disabled(KEY_HEX, -1))).toThrow(/FirstLedgerSequence/);
      expect(() => rowOf(disabled(KEY_HEX, '5'))).toThrow(/FirstLedgerSequence/);
      expect(() => rowOf({ DisabledValidators: [{ Other: {} }] })).toThrow(/DisabledValidator/);
      expect(() => rowOf({ DisabledValidators: 'x' })).toThrow(/DisabledValidators/);
      expect(() => rowOf({ ValidatorToDisable: 'zz' })).toThrow(/ValidatorToDisable/);
      expect(() => rowOf({ ValidatorToReEnable: 7 })).toThrow(/ValidatorToReEnable/);
    });
  });

  describe('the Amendments object (hand-written input)', () => {
    const row = (node: Record<string, unknown> | undefined, over: { ledger?: unknown; quorum?: number } = {}) =>
      networkStateRowFrom(
        amendmentsWith(node, 'ledger' in over ? over.ledger : 100),
        undefined,
        modernFees,
        'quorum' in over ? over.quorum : 28,
        POLLED_AT,
      );

    it('has no amendments and no majorities when the fields are absent', () => {
      expect(row({})).toMatchObject({ amendments: [], majorities: [] });
    });

    it('writes the ID of an amendment in upper case', () => {
      expect(row({ Amendments: [ID_A.toLowerCase(), ID_B] }).amendments).toEqual([ID_A, ID_B]);
    });

    it('reads the majorities in the order of the object', () => {
      const majority = (Amendment: string, CloseTime: number) => ({ Majority: { Amendment, CloseTime } });
      expect(row({ Majorities: [majority(ID_B, 100), majority(ID_A, 0)] }).majorities).toEqual([
        { amendment: ID_B, since: 100 + RIPPLE_EPOCH },
        { amendment: ID_A, since: RIPPLE_EPOCH },
      ]);
    });

    it('takes the ledger hash as given in upper case, and none as an empty text', () => {
      expect(networkStateRowFrom({ ledger_index: 5, node: {} }, undefined, modernFees, 1, POLLED_AT).ledger_hash).toBe(
        '',
      );
      expect(row({}).ledger_hash).toBe('1A'.repeat(32));
    });

    it('takes a missing quorum as 0', () => {
      expect(row({}, { quorum: undefined }).node_quorum).toBe(0);
    });

    it('refuses an answer that is not an Amendments object', () => {
      expect(() => row(undefined)).toThrow(/Amendments object/);
      expect(() => row({}, { ledger: undefined })).toThrow(/ledger_index/);
      expect(() => row({}, { ledger: 0 })).toThrow(/ledger_index/);
      expect(() => row({}, { ledger: 4294967296 })).toThrow(/ledger_index/);
      expect(() => row({}, { ledger: '100' })).toThrow(/ledger_index/);
      expect(() => row({ Amendments: 'x' })).toThrow(/Amendments/);
      expect(() => row({ Amendments: ['abc'] })).toThrow(/amendment ID/);
      expect(() => row({ Amendments: [5] })).toThrow(/amendment ID/);
      expect(() => row({ Majorities: [{ Majority: { Amendment: 'abc', CloseTime: 5 } }] })).toThrow(/amendment ID/);
      expect(() => row({ Majorities: [{ Majority: { Amendment: ID_A, CloseTime: '5' } }] })).toThrow(/CloseTime/);
      expect(() => row({ Majorities: [{ Majority: { Amendment: ID_A, CloseTime: -1 } }] })).toThrow(/CloseTime/);
      expect(() => row({ Majorities: [{ Amendment: ID_A }] })).toThrow(/Majority/);
      expect(() => row({ Majorities: {} })).toThrow(/Majorities/);
    });
  });
});

describe('featureRowsFrom', () => {
  it('has a row for each amendment of the answer recorded from the XRPL, sorted by ID', () => {
    const answer = recorded('xrpl', 'feature');
    const rows = featureRowsFrom(answer, POLLED_AT);
    expect(rows).toHaveLength(115);
    const ids = Object.keys(answer.features).sort();
    expect(rows.map((r) => r.amendment_id)).toEqual(ids);
    for (const row of rows) {
      const feature = answer.features[row.amendment_id];
      expect(row).toEqual({
        amendment_id: row.amendment_id,
        name: feature.name,
        supported: feature.supported ? 1 : 0,
        polled_at: POLLED_AT,
      });
    }
    // the node knows 11 amendments that this build does not support
    expect(rows.filter((r) => r.supported === 0)).toHaveLength(11);
  });

  it('has a row for each amendment of the answer recorded from Xahau', () => {
    const rows = featureRowsFrom(recorded('xahau', 'feature'), POLLED_AT);
    expect(rows).toHaveLength(114);
    expect(rows.every((r) => r.supported === 1 && r.name !== '')).toBe(true);
  });

  it('keeps an ID without a name, with name "" (hand-written input)', () => {
    expect(
      featureRowsFrom(
        { features: { [ID_B]: { enabled: false, supported: false }, [ID_A]: { name: 'Fake', supported: true } } },
        7,
      ),
    ).toEqual([
      { amendment_id: ID_A, name: 'Fake', supported: 1, polled_at: 7 },
      { amendment_id: ID_B, name: '', supported: 0, polled_at: 7 },
    ]);
  });

  it('writes an ID in upper case, and counts only `true` as supported', () => {
    expect(
      featureRowsFrom({ features: { [ID_A.toLowerCase()]: { name: 'x', supported: 'yes' }, [ID_B]: { name: 5 } } }, 7),
    ).toEqual([
      { amendment_id: ID_A, name: 'x', supported: 0, polled_at: 7 },
      { amendment_id: ID_B, name: '', supported: 0, polled_at: 7 },
    ]);
  });

  it('has no rows when the node knows no amendment', () => {
    expect(featureRowsFrom({ features: {} }, 7)).toEqual([]);
  });

  it('refuses an answer that is not a list of features', () => {
    expect(() => featureRowsFrom(undefined, 7)).toThrow(/features/);
    expect(() => featureRowsFrom({}, 7)).toThrow(/features/);
    expect(() => featureRowsFrom({ features: [] }, 7)).toThrow(/features/);
    expect(() => featureRowsFrom({ features: { abc: { name: 'x' } } }, 7)).toThrow(/amendment ID/);
    expect(() => featureRowsFrom({ features: { [ID_A]: 'x' } }, 7)).toThrow(/feature/);
  });
});

// -- the poller --------------------------------------------------------------------------------------------------------

/** A node that answers from the recorded files of `network`, and lets a test change or break an answer. */
function recordedNode(network: Network, overrides: Record<string, (request: Record<string, any>) => unknown> = {}) {
  const requests: Array<{ request: Record<string, any>; options: unknown }> = [];
  const answers: Record<string, (request: Record<string, any>) => unknown> = {
    [AMENDMENTS_OBJECT_INDEX]: () => served(recorded(network, 'amendments')),
    [NEGATIVE_UNL_OBJECT_INDEX]: () => served(recorded(network, 'negative_unl')),
    [FEE_SETTINGS_OBJECT_INDEX]: () => served(recorded(network, 'fee_settings')),
    server_info: () => served(recorded(network, 'server_info')),
    feature: () => served(recorded(network, 'feature')),
    ...overrides,
  };
  const request = jest.fn(async (req: Record<string, any>, options?: unknown) => {
    requests.push({ request: req, options });
    const answer = answers[req.command === 'ledger_entry' ? req.index : req.command];
    if (answer === undefined) throw new Error(`no answer for ${JSON.stringify(req)}`);
    return answer(req);
  });
  return { request, requests, answers };
}

const rippledError = (code: string) =>
  Object.assign(new Error(`${code} (the text of the message)`), { name: 'RippledError', data: { error: code } });

interface Made {
  poller: NetworkStatePoller;
  node: ReturnType<typeof recordedNode>;
  inserts: Array<{ table: unknown; rows: any[] }>;
  polls: Array<{ labels: Record<string, string> }>;
  gauge: jest.Mock;
  logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
  query: jest.Mock;
}
const made: NetworkStatePoller[] = [];

function setup(
  o: {
    network?: Network;
    node?: ReturnType<typeof recordedNode>;
    amendments?: Partial<AmendmentsConfig>;
    insert?: jest.Mock;
    query?: jest.Mock;
    options?: ValidatorsWorkerOptions;
  } = {},
): Made {
  const network = o.network ?? 'xrpl';
  const node = o.node ?? recordedNode(network);
  const inserts: Made['inserts'] = [];
  const insert = o.insert ?? jest.fn(async (table: unknown, rows: any[]) => void inserts.push({ table, rows }));
  const query = o.query ?? jest.fn(async () => []);
  const polls: Made['polls'] = [];
  const gauge = jest.fn();
  const metrics = {
    validatorsNodePollsTotal: { inc: jest.fn((labels: Record<string, string>) => void polls.push({ labels })) },
    amendmentsWithoutMetadata: { set: gauge },
  };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const poller = new NetworkStatePoller(
    node as unknown as NodeClient,
    { query, insert } as unknown as ClickHouseService,
    metrics as unknown as PrometheusService,
    (o.amendments ?? loadAmendmentsConfig(getNetworkProfile(network))) as AmendmentsConfig,
    { logger, now: () => POLLED_AT * 1000, ...o.options },
  );
  made.push(poller);
  return { poller, node, inserts, polls, gauge, logger, query };
}

/** The outcomes counted for a request, in order. */
const counted = (t: Made, request: string) =>
  t.polls.filter((p) => p.labels.request === request).map((p) => p.labels.outcome);

describe('NetworkStatePoller', () => {
  afterEach(async () => {
    jest.useRealTimers();
    await Promise.all(made.splice(0).map((poller) => poller.stop()));
  });

  describe('pollState', () => {
    it('asks for the Amendments object at the validated ledger, then for the other objects at that ledger', async () => {
      const t = setup();
      expect(await t.poller.pollState()).toBe(true);
      const [first, ...rest] = t.node.requests.map((r) => r.request);
      expect(first).toEqual({ command: 'ledger_entry', index: AMENDMENTS_OBJECT_INDEX, ledger_index: 'validated' });
      expect(rest).toHaveLength(3);
      expect(rest).toEqual(
        expect.arrayContaining([
          { command: 'ledger_entry', index: NEGATIVE_UNL_OBJECT_INDEX, ledger_index: 107760758 },
          { command: 'ledger_entry', index: FEE_SETTINGS_OBJECT_INDEX, ledger_index: 107760758 },
          { command: 'server_info' },
        ]),
      );
    });

    it('gives every request a timeout of 5 s and no retry', async () => {
      expect(NETWORK_STATE_REQUEST_TIMEOUT_MS).toBe(5_000);
      const t = setup();
      await t.poller.pollState();
      expect(t.node.requests).toHaveLength(4);
      for (const { options } of t.node.requests) expect(options).toEqual({ timeoutMs: 5_000, retries: 0 });
    });

    it('takes the timeout of a test option', async () => {
      const t = setup({ options: { nodeRequestTimeoutMs: 123 } });
      await t.poller.pollState();
      for (const { options } of t.node.requests) expect(options).toEqual({ timeoutMs: 123, retries: 0 });
    });

    it('writes one network_state row from the recorded answers, and counts four requests as ok', async () => {
      const t = setup();
      expect(await t.poller.pollState()).toBe(true);
      expect(t.inserts).toEqual([{ table: Table.NetworkState, rows: [recordedRow('xrpl')] }]);
      for (const request of ['amendments', 'negative_unl', 'fee_settings', 'server_info']) {
        expect(counted(t, request)).toEqual(['ok']);
      }
      expect(counted(t, 'feature')).toEqual([]);
    });

    it('reads a NegativeUNL that exists (Xahau)', async () => {
      const t = setup({ network: 'xahau' });
      await t.poller.pollState();
      expect(t.inserts[0].rows[0].negative_unl).toEqual([
        { validation_public_key: KEY_BASE58, first_ledger: 26615296 },
      ]);
      expect(t.inserts[0].rows[0].node_quorum).toBe(0);
    });

    it('writes an empty NegativeUNL when the node says entryNotFound, and counts that request as ok', async () => {
      const t = setup();
      await t.poller.pollState();
      expect(recorded('xrpl', 'negative_unl').error).toBe('entryNotFound');
      expect(t.inserts[0].rows[0]).toMatchObject({ negative_unl: [], to_disable: '', to_reenable: '' });
      expect(counted(t, 'negative_unl')).toEqual(['ok']);
    });

    it('takes a quorum the node does not report as 0', async () => {
      const t = setup({ node: recordedNode('xrpl', { server_info: () => ({ info: {} }) }) });
      await t.poller.pollState();
      expect(t.inserts[0].rows[0].node_quorum).toBe(0);
    });

    it('stamps the row with the time it was made at, in unix seconds with the milliseconds as the fraction', async () => {
      const t = setup({ options: { now: () => 1_760_000_123_456 } });
      await t.poller.pollState();
      expect(t.inserts[0].rows[0].polled_at).toBe(1_760_000_123.456);
    });

    it.each([
      ['amendments', AMENDMENTS_OBJECT_INDEX],
      ['negative_unl', NEGATIVE_UNL_OBJECT_INDEX],
      ['fee_settings', FEE_SETTINGS_OBJECT_INDEX],
      ['server_info', 'server_info'],
    ])('writes nothing, and counts %s as an error, when that request fails', async (name, key) => {
      const t = setup({
        node: recordedNode('xrpl', {
          [key]: () => {
            throw new Error('timeout');
          },
        }),
      });
      expect(await t.poller.pollState()).toBe(false);
      expect(t.inserts).toEqual([]);
      expect(counted(t, name)).toEqual(['error']);
      // the others were asked all the same, except when the first fails: there is no ledger to ask them at
      const others = ['negative_unl', 'fee_settings', 'server_info'].filter((n) => n !== name);
      if (name === 'amendments') {
        expect(t.node.requests).toHaveLength(1);
        expect(t.polls).toHaveLength(1);
      } else {
        expect(t.node.requests).toHaveLength(4);
        for (const other of ['amendments', ...others]) expect(counted(t, other)).toEqual(['ok']);
      }
    });

    it('counts an error answer other than entryNotFound for the NegativeUNL as an error', async () => {
      const t = setup({
        node: recordedNode('xrpl', {
          [NEGATIVE_UNL_OBJECT_INDEX]: () => {
            throw rippledError('lgrNotFound');
          },
        }),
      });
      expect(await t.poller.pollState()).toBe(false);
      expect(counted(t, 'negative_unl')).toEqual(['error']);
      expect(t.inserts).toEqual([]);
    });

    it('counts entryNotFound for the FeeSettings as an error: that object always exists', async () => {
      const t = setup({
        node: recordedNode('xrpl', {
          [FEE_SETTINGS_OBJECT_INDEX]: () => {
            throw rippledError('entryNotFound');
          },
        }),
      });
      expect(await t.poller.pollState()).toBe(false);
      expect(counted(t, 'fee_settings')).toEqual(['error']);
      expect(t.inserts).toEqual([]);
    });

    it('counts an answer that is not what was asked for as an error, and writes nothing', async () => {
      for (const [name, key, answer] of [
        ['amendments', AMENDMENTS_OBJECT_INDEX, { ledger_index: 5 }],
        ['amendments', AMENDMENTS_OBJECT_INDEX, { node: {} }],
        ['negative_unl', NEGATIVE_UNL_OBJECT_INDEX, { ledger_index: 5 }],
        ['fee_settings', FEE_SETTINGS_OBJECT_INDEX, {}],
        ['server_info', 'server_info', {}],
      ] as const) {
        const t = setup({ node: recordedNode('xrpl', { [key]: () => answer }) });
        expect(await t.poller.pollState()).toBe(false);
        expect(counted(t, name)).toEqual(['error']);
        expect(t.inserts).toEqual([]);
      }
    });

    describe('the ledger of the answers', () => {
      /** The recorded answer for an object, said to be of another ledger. */
      const of = (network: Network, name: string, ledger_index: unknown) => ({
        ...recorded(network, name),
        ledger_index,
      });

      it.each([
        ['negative_unl', NEGATIVE_UNL_OBJECT_INDEX, 'negative_unl', 'fee_settings'],
        ['fee_settings', FEE_SETTINGS_OBJECT_INDEX, 'fee_settings', 'negative_unl'],
      ])(
        'fails the poll, with a warning naming the request and both ledgers, when the answer for %s is of another ledger',
        async (name, key, file, other) => {
          // the Xahau NegativeUNL exists, so that it has a ledger of its own to be wrong about
          const t = setup({
            network: 'xahau',
            node: recordedNode('xahau', { [key]: () => of('xahau', file, 26633716) }),
          });
          expect(await t.poller.pollState()).toBe(false);
          expect(t.inserts).toEqual([]);
          expect(counted(t, name)).toEqual(['error']);
          expect(counted(t, other)).toEqual(['ok']);
          expect(counted(t, 'amendments')).toEqual(['ok']);
          expect(t.logger.warn).toHaveBeenCalledTimes(1);
          const line = String(t.logger.warn.mock.calls[0][0]);
          expect(line).toContain(name);
          expect(line).toContain('26633716');
          expect(line).toContain('26633715');
        },
      );

      it('counts an answer without a ledger_index as an error too', async () => {
        for (const [name, key, file] of [
          ['negative_unl', NEGATIVE_UNL_OBJECT_INDEX, 'negative_unl'],
          ['fee_settings', FEE_SETTINGS_OBJECT_INDEX, 'fee_settings'],
        ] as const) {
          const t = setup({
            network: 'xahau',
            node: recordedNode('xahau', { [key]: () => of('xahau', file, undefined) }),
          });
          expect(await t.poller.pollState()).toBe(false);
          expect(t.inserts).toEqual([]);
          expect(counted(t, name)).toEqual(['error']);
        }
      });

      it('asks for the ledger it was given, whatever the node says validated is now', async () => {
        const t = setup({ network: 'xahau' });
        expect(await t.poller.pollState()).toBe(true);
        expect(t.inserts[0].rows[0].ledger_index).toBe(26633715);
      });
    });

    describe('the ledger of the Amendments answer', () => {
      it.each([[0], [-1], [1.5], ['107760758'], [null], [4294967296]])(
        'counts an answer whose ledger_index is %p as an error, and sends no follow-up',
        async (ledger_index) => {
          const t = setup({
            node: recordedNode('xrpl', {
              [AMENDMENTS_OBJECT_INDEX]: () => ({ ...recorded('xrpl', 'amendments'), ledger_index }),
            }),
          });
          expect(await t.poller.pollState()).toBe(false);
          expect(t.inserts).toEqual([]);
          expect(t.node.requests).toHaveLength(1);
          expect(counted(t, 'amendments')).toEqual(['error']);
          expect(t.polls).toHaveLength(1);
          expect(String(t.logger.warn.mock.calls[0][0])).toContain('ledger_index');
        },
      );
    });

    describe('the quorum', () => {
      it.each([[-1], [1.5], ['28'], [null], [4294967296], [{}]])(
        'fails the poll, with a warning naming the field, when validation_quorum is %p',
        async (validation_quorum) => {
          const t = setup({
            node: recordedNode('xrpl', { server_info: () => ({ info: { validation_quorum } }) }),
          });
          expect(await t.poller.pollState()).toBe(false);
          expect(t.inserts).toEqual([]);
          expect(counted(t, 'server_info')).toEqual(['error']);
          expect(t.logger.warn).toHaveBeenCalledTimes(1);
          expect(String(t.logger.warn.mock.calls[0][0])).toContain('validation_quorum');
        },
      );

      it('is 0 when the node reports none, and the count when it reports one, 0 included', async () => {
        for (const [info, quorum] of [
          [{}, 0],
          [{ validation_quorum: 0 }, 0],
          [{ validation_quorum: 28 }, 28],
        ] as const) {
          const t = setup({ node: recordedNode('xrpl', { server_info: () => ({ info }) }) });
          expect(await t.poller.pollState()).toBe(true);
          expect(t.inserts[0].rows[0].node_quorum).toBe(quorum);
          expect(counted(t, 'server_info')).toEqual(['ok']);
        }
      });
    });

    it('writes nothing, and says why, when the answers are complete but one is malformed', async () => {
      const t = setup({
        node: recordedNode('xrpl', {
          [FEE_SETTINGS_OBJECT_INDEX]: () => ({ ledger_index: 107760758, node: { LedgerEntryType: 'FeeSettings' } }),
        }),
      });
      expect(await t.poller.pollState()).toBe(false);
      expect(t.inserts).toEqual([]);
      expect(t.logger.warn).toHaveBeenCalledTimes(1);
      expect(t.logger.warn.mock.calls[0][0]).toContain('BaseFeeDrops or BaseFee');
    });

    it('lets a failure of ClickHouse reject the poll', async () => {
      const t = setup({ insert: jest.fn().mockRejectedValue(new Error('ClickHouse is down')) });
      await expect(t.poller.pollState()).rejects.toThrow('ClickHouse is down');
    });

    it('is one poll when it is called while a poll is under way', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const node = recordedNode('xrpl', {
        [AMENDMENTS_OBJECT_INDEX]: async () => {
          await gate;
          return served(recorded('xrpl', 'amendments'));
        },
      });
      const t = setup({ node });
      const first = t.poller.pollState();
      const second = t.poller.pollState();
      release();
      expect(await Promise.all([first, second])).toEqual([true, true]);
      expect(t.node.requests).toHaveLength(4);
      expect(t.inserts).toHaveLength(1);
      // and when it is over, the next call polls again
      await t.poller.pollState();
      expect(t.inserts).toHaveLength(2);
    });

    it('writes nothing, and asks nothing more, once stopped', async () => {
      const t = setup();
      await t.poller.stop();
      expect(await t.poller.pollState()).toBe(false);
      expect(t.node.requests).toEqual([]);
      expect(await t.poller.pollFeatures()).toBe(false);
      expect(t.node.requests).toEqual([]);
    });

    it('waits for the poll under way when stopped, and drops its answer', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const t = setup({
        node: recordedNode('xrpl', {
          server_info: async () => {
            await gate;
            return served(recorded('xrpl', 'server_info'));
          },
        }),
      });
      const polling = t.poller.pollState();
      await new Promise((resolve) => setImmediate(resolve));
      let stopped = false;
      const stopping = t.poller.stop().then(() => (stopped = true));
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      release();
      await stopping;
      expect(await polling).toBe(false);
      expect(t.inserts).toEqual([]);
    });

    describe('the log', () => {
      const failing = (message: string) =>
        recordedNode('xrpl', {
          server_info: () => {
            throw Object.assign(new Error(message), { secret: 'SECRET' });
          },
        });

      it('names the request that failed and the message, and nothing more', async () => {
        const t = setup({ node: failing('the node did not answer') });
        await t.poller.pollState();
        expect(t.logger.warn).toHaveBeenCalledTimes(1);
        const [line, ...rest] = t.logger.warn.mock.calls[0];
        expect(rest).toEqual([]);
        expect(line).toContain('server_info');
        expect(line).toContain('the node did not answer');
        expect(String(line)).not.toContain('SECRET');
      });

      it('names the code of an answer of the node, not its text', async () => {
        const t = setup({
          node: recordedNode('xrpl', {
            [FEE_SETTINGS_OBJECT_INDEX]: () => {
              throw rippledError('slowDown');
            },
          }),
        });
        await t.poller.pollState();
        const line = String(t.logger.warn.mock.calls[0][0]);
        expect(line).toContain('fee_settings');
        expect(line).toContain('slowDown');
        expect(line).not.toContain('the text of the message');
      });

      it('says it once while a failure goes on, and says again when it is another, and when it ends', async () => {
        let message = 'first failure';
        const node = recordedNode('xrpl', {
          server_info: () => {
            if (message === '') return served(recorded('xrpl', 'server_info'));
            throw new Error(message);
          },
        });
        const t = setup({ node });
        await t.poller.pollState();
        await t.poller.pollState();
        expect(t.logger.warn).toHaveBeenCalledTimes(1);
        message = 'another failure';
        await t.poller.pollState();
        expect(t.logger.warn).toHaveBeenCalledTimes(2);
        expect(t.logger.log).not.toHaveBeenCalled();
        message = '';
        await t.poller.pollState();
        expect(t.logger.log).toHaveBeenCalledTimes(1);
        expect(String(t.logger.log.mock.calls[0][0])).toContain('recovered');
        await t.poller.pollState();
        expect(t.logger.log).toHaveBeenCalledTimes(1);
        // and a new failure after the recovery is said again
        message = 'another failure';
        await t.poller.pollState();
        expect(t.logger.warn).toHaveBeenCalledTimes(3);
      });
    });
  });

  describe('pollFeatures', () => {
    it('asks for the features, with a timeout of 5 s and no retry, and writes a row for each', async () => {
      const t = setup();
      expect(await t.poller.pollFeatures()).toBe(true);
      expect(t.node.requests).toEqual([{ request: { command: 'feature' }, options: { timeoutMs: 5_000, retries: 0 } }]);
      expect(t.inserts).toEqual([
        { table: Table.AmendmentFeatures, rows: featureRowsFrom(recorded('xrpl', 'feature'), POLLED_AT) },
      ]);
      expect(counted(t, 'feature')).toEqual(['ok']);
    });

    it('writes nothing, and counts an error, when the request fails', async () => {
      const t = setup({
        node: recordedNode('xrpl', {
          feature: () => {
            throw new Error('timeout');
          },
        }),
      });
      expect(await t.poller.pollFeatures()).toBe(false);
      expect(t.inserts).toEqual([]);
      expect(counted(t, 'feature')).toEqual(['error']);
      expect(t.logger.warn).toHaveBeenCalledTimes(1);
      expect(String(t.logger.warn.mock.calls[0][0])).toContain('feature');
    });

    it('writes nothing, and counts an error, when the answer has no features', async () => {
      const t = setup({ node: recordedNode('xrpl', { feature: () => ({}) }) });
      expect(await t.poller.pollFeatures()).toBe(false);
      expect(t.inserts).toEqual([]);
      expect(counted(t, 'feature')).toEqual(['error']);
    });

    it('is one poll when it is called while a poll is under way', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const t = setup({
        node: recordedNode('xrpl', {
          feature: async () => {
            await gate;
            return served(recorded('xrpl', 'feature'));
          },
        }),
      });
      const first = t.poller.pollFeatures();
      const second = t.poller.pollFeatures();
      release();
      await Promise.all([first, second]);
      expect(t.node.requests).toHaveLength(1);
    });

    it('keeps the polls of the state and of the features apart', async () => {
      const t = setup();
      await Promise.all([t.poller.pollState(), t.poller.pollFeatures()]);
      expect(t.node.requests).toHaveLength(5);
      expect(t.inserts.map((i) => i.table).sort()).toEqual([Table.AmendmentFeatures, Table.NetworkState].sort());
    });
  });

  describe('updateMetadataGauge', () => {
    // the metadata of a network the poller is of: Fake1 only
    const config = (...ids: string[]): Partial<AmendmentsConfig> => ({
      byId: new Map(ids.map((id) => [id, { name: `Meta${id[0]}`, id }])),
    });

    /** ClickHouse as the gauge reads it: the amendment IDs of the newest rows of each table. */
    function stored(rows: { features?: string[]; amendments?: string[]; majorities?: string[]; tallies?: string[] }) {
      return jest.fn(async (sql: string, _params?: Record<string, unknown>) => {
        if (sql.includes(Table.AmendmentFeatures))
          return (rows.features ?? []).map((amendment_id) => ({ amendment_id }));
        if (sql.includes(Table.NetworkState)) {
          return rows.amendments || rows.majorities
            ? [{ amendments: rows.amendments ?? [], majority_ids: rows.majorities ?? [] }]
            : [];
        }
        if (sql.includes(Table.AmendmentTallies) && sql.includes('GROUP BY')) {
          return rows.tallies ? [{ ledger_index: 512, version: '1760000000000' }] : [];
        }
        if (sql.includes(Table.AmendmentTallies)) return (rows.tallies ?? []).map((amendment_id) => ({ amendment_id }));
        throw new Error(`unexpected query ${sql}`);
      });
    }

    it('is 0 when nothing is stored yet', async () => {
      const t = setup({ amendments: config(), query: stored({}) });
      await t.poller.updateMetadataGauge();
      expect(t.gauge).toHaveBeenLastCalledWith(0);
      expect(t.logger.warn).not.toHaveBeenCalled();
    });

    it('counts each ID without metadata once, from the features, the enabled list, the majorities and the tallies', async () => {
      const t = setup({
        amendments: config(ID_A),
        query: stored({
          features: [ID_A, ID_B],
          amendments: [ID_A, ID_B, ID_C],
          majorities: [ID_C, 'D'.repeat(64)],
          tallies: ['E'.repeat(64)],
        }),
      });
      await t.poller.updateMetadataGauge();
      expect(t.gauge).toHaveBeenLastCalledWith(4);
    });

    it('is 0 when the metadata names every ID seen', async () => {
      const t = setup({
        amendments: config(ID_A, ID_B),
        query: stored({ features: [ID_A], amendments: [ID_B], majorities: [ID_A] }),
      });
      await t.poller.updateMetadataGauge();
      expect(t.gauge).toHaveBeenLastCalledWith(0);
      expect(t.logger.warn).not.toHaveBeenCalled();
    });

    it('warns once for each new ID, and not again on the next call', async () => {
      const query = stored({ features: [ID_B] });
      const t = setup({ amendments: config(), query });
      await t.poller.updateMetadataGauge();
      expect(t.logger.warn).toHaveBeenCalledTimes(1);
      expect(t.logger.warn).toHaveBeenCalledWith(`amendment ${ID_B} has no metadata entry`);
      await t.poller.updateMetadataGauge();
      expect(t.logger.warn).toHaveBeenCalledTimes(1);
      expect(t.gauge).toHaveBeenLastCalledWith(1);
      // a second ID is a new warning
      query.mockImplementation(stored({ features: [ID_B], amendments: [ID_C] }));
      await t.poller.updateMetadataGauge();
      expect(t.logger.warn).toHaveBeenCalledTimes(2);
      expect(t.logger.warn).toHaveBeenLastCalledWith(`amendment ${ID_C} has no metadata entry`);
      expect(t.gauge).toHaveBeenLastCalledWith(2);
    });

    it('falls to 0 when the ID is named later, and stays quiet about it', async () => {
      const query = stored({ features: [ID_B] });
      const amendments = config();
      const t = setup({ amendments, query });
      await t.poller.updateMetadataGauge();
      expect(t.gauge).toHaveBeenLastCalledWith(1);
      (amendments.byId as Map<string, unknown>).set(ID_B, { name: 'Named', id: ID_B });
      await t.poller.updateMetadataGauge();
      expect(t.gauge).toHaveBeenLastCalledWith(0);
      expect(t.logger.warn).toHaveBeenCalledTimes(1);
    });

    it('asks only for the newest rows of each table, in the order of the key', async () => {
      const query = stored({ tallies: [ID_B] });
      const t = setup({ amendments: config(), query });
      await t.poller.updateMetadataGauge();
      const sql = query.mock.calls.map(([text]) => String(text));
      expect(sql.find((s) => s.includes(Table.AmendmentFeatures))).toMatch(/polled_at = \(SELECT max\(polled_at\)/);
      expect(sql.find((s) => s.includes(Table.NetworkState))).toMatch(/ORDER BY ledger_index DESC\s+LIMIT 1/);
      // the newest round's tallies: the sentinel's newest version, then that version's rows, as query parameters
      const rows = query.mock.calls.find(
        ([text]) => !String(text).includes('GROUP BY') && String(text).includes(Table.AmendmentTallies),
      );
      expect(rows?.[1]).toEqual({ ledger: 512, version: '1760000000000' });
      expect(sql.join('\n')).not.toMatch(/\bFINAL\b/);
    });

    it('does nothing once stopped', async () => {
      const t = setup({ amendments: config(), query: stored({ features: [ID_B] }) });
      await t.poller.stop();
      await t.poller.updateMetadataGauge();
      expect(t.query).not.toHaveBeenCalled();
      expect(t.gauge).not.toHaveBeenCalled();
    });
  });
});
