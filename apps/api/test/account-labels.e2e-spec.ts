import { Table } from '@gatehub/data-api-shared';
import { Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { accountAt, hashOf } from './support/amm';

/**
 * Labels (ADR-0014): the operator puts a label (`scam`, `spam`, `advisory`) on an address by inserting a row into
 * `account_labels` of the shared database, and `GET /v2/accounts/{address}` carries the labels of the address as
 * `account_labels` on every network: an object keyed by label, each with its description and, when given, its source and
 * url. The rows are written here with plain SQL inserts, the operator's write path; the api loads the labels whole with
 * the account names and reloads them on the same timer (`GH_NAMES_AND_LABELS_RELOAD_MS`, 60 s by default, a fraction of a
 * second in these suites).
 *
 * `/v2/accounts/{address}` answers only for an address with an activation on the network, so each account here gets an
 * `accounts_created` row by hand.
 */

const RELOAD_MS = '100';
// the tests ask again and again until a reload shows a row
const FAST_RELOAD = { GH_NAMES_AND_LABELS_RELOAD_MS: RELOAD_MS, ...NO_RATE_LIMIT };

const SCAMMER = accountAt(0x5ca3);
const SPAMMER = accountAt(0x5aa3);
const ADVISED = accountAt(0xad51);
const GATEHUB = accountAt(0x6a7e);
const UNLABELLED = accountAt(0x0b0d);
const NEVER_ACTIVATED = accountAt(0xdead);

const RIPPLE_KEYS = ['account', 'parent', 'initial_balance', 'inception', 'ledger_index', 'tx_hash'];

/** An activation of each account in ledger 1000, made by hand: what makes `/v2/accounts/{address}` answer. */
async function activate(h: Harness, ...accounts: string[]): Promise<void> {
  await h.ch.insert(
    Table.AccountsCreated,
    accounts.map((account, i) => ({
      account,
      parent: accountAt(1),
      initial_balance: '20',
      ledger_index: 1000,
      tx_index: i,
      tx_hash: hashOf(1000 + i),
      inception: 1_700_000_000,
      genesis_balance: null,
      genesis_index: null,
    })),
  );
}

interface LabelInsert {
  description?: string;
  source?: string;
  url?: string;
  removed?: 0 | 1;
  addedBy?: string;
}

/**
 * The operator's insert, as in the runbook: a label on an address, or with `removed` the removal of that label. Columns
 * left out are left out of the insert too, so `source` and `url` take their defaults.
 */
async function labelAddress(h: Harness, address: string, label: string, row: LabelInsert = {}): Promise<void> {
  const { description = '', source, url, removed = 0, addedBy = 'compliance@gatehub.net' } = row;
  const params: Record<string, string | number> = { address, label, description, removed, added_by: addedBy };
  if (source !== undefined) params.source = source;
  if (url !== undefined) params.url = url;
  const columns = Object.keys(params);
  const types: Record<string, string> = { removed: 'UInt8' };
  await h.ch.command(
    `INSERT INTO ${h.sharedDatabase}.account_labels (${columns.join(', ')})
     VALUES (${columns.map((c) => `{${c}:${types[c] ?? 'String'}}`).join(', ')})`,
    params,
  );
}

/** The operator's insert of an account name, to see the labels next to it. */
async function nameAddress(h: Harness, address: string, name: string): Promise<void> {
  await h.ch.command(
    `INSERT INTO ${h.sharedDatabase}.account_names (address, name, added_by) VALUES ({address:String}, {name:String}, 'ops@gatehub.net')`,
    { address, name },
  );
}

/** The operator's insert of an account network name, in the network database of `h`. */
async function nameAccountOnNetwork(h: Harness, address: string, name: string): Promise<void> {
  await h.ch.command(
    `INSERT INTO ${h.database}.account_network_names (address, name, added_by) VALUES ({address:String}, {name:String}, 'ops@gatehub.net')`,
    { address, name },
  );
}

/** `account_data` of an address on `h`. */
async function accountData(h: Harness, address: string): Promise<Record<string, unknown>> {
  const res = await (await h.api()).get(`/v2/accounts/${address}`);
  if (res.status !== 200) throw new Error(`GET /v2/accounts/${address} answered ${res.status}: ${res.text}`);
  return res.body.account_data;
}

/**
 * `account_data` of an address once `until` holds for it, asked again and again for up to `timeoutMs`: a row the
 * operator inserted shows at the next reload. Throws with the last answer when it never does.
 */
async function eventually(
  h: Harness,
  address: string,
  until: (data: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let data = await accountData(h, address);
  while (!until(data)) {
    if (Date.now() > deadline) throw new Error(`still ${JSON.stringify(data)} after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    data = await accountData(h, address);
  }
  return data;
}

/** The labels of `account_data`, `{}` when it has none. */
const labelsOf = (data: Record<string, unknown>) =>
  (data.account_labels ?? {}) as Record<string, Record<string, string>>;

describe('labels on /v2/accounts/{address}', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ env: FAST_RELOAD });
    await activate(h, SCAMMER, SPAMMER, ADVISED, GATEHUB, UNLABELLED);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('a label with a source and a url carries all three, after the Ripple keys', async () => {
    await labelAddress(h, ADVISED, 'advisory', {
      description: 'On the regulator warning list',
      source: 'FCA',
      url: 'https://www.fca.org.uk/scamsmart/warning-list',
    });
    const data = await eventually(h, ADVISED, (d) => 'account_labels' in d);
    expect(Object.keys(data)).toEqual([...RIPPLE_KEYS, 'account_labels']);
    expect(data.account_labels).toEqual({
      advisory: {
        description: 'On the regulator warning list',
        source: 'FCA',
        url: 'https://www.fca.org.uk/scamsmart/warning-list',
      },
    });
    expect(Object.keys(labelsOf(data).advisory)).toEqual(['description', 'source', 'url']);
  });

  it('a label without a source or a url carries the description only', async () => {
    await labelAddress(h, SPAMMER, 'spam', { description: 'Sends dust payments with memos' });
    const data = await eventually(h, SPAMMER, (d) => 'account_labels' in d);
    expect(data.account_labels).toEqual({ spam: { description: 'Sends dust payments with memos' } });
  });

  it('an empty source or url is left out like a missing one', async () => {
    await labelAddress(h, SPAMMER, 'spam', { description: 'Sends dust payments', source: '', url: '' });
    const data = await eventually(h, SPAMMER, (d) => labelsOf(d).spam?.description === 'Sends dust payments');
    expect(data.account_labels).toEqual({ spam: { description: 'Sends dust payments' } });
  });

  it('two labels on one address are both carried, keyed by label in the order scam, spam, advisory', async () => {
    await labelAddress(h, SCAMMER, 'advisory', { description: 'Named in a warning', source: 'XRPL Foundation' });
    await labelAddress(h, SCAMMER, 'scam', { description: 'Fake giveaway', url: 'https://example.com/report/1' });
    const data = await eventually(h, SCAMMER, (d) => Object.keys(labelsOf(d)).length === 2);
    expect(data.account_labels).toEqual({
      scam: { description: 'Fake giveaway', url: 'https://example.com/report/1' },
      advisory: { description: 'Named in a warning', source: 'XRPL Foundation' },
    });
    expect(Object.keys(labelsOf(data))).toEqual(['scam', 'advisory']);
  });

  it('a newer row of a label replaces the older one', async () => {
    await labelAddress(h, SCAMMER, 'scam', {
      description: 'Fake giveaway, confirmed',
      source: 'GateHub compliance',
      addedBy: 'someone.else@gatehub.net',
    });
    const data = await eventually(h, SCAMMER, (d) => labelsOf(d).scam?.description === 'Fake giveaway, confirmed');
    // the newer row has no url: the older row's url is gone with it
    expect(labelsOf(data).scam).toEqual({ description: 'Fake giveaway, confirmed', source: 'GateHub compliance' });
    expect(labelsOf(data).advisory).toEqual({ description: 'Named in a warning', source: 'XRPL Foundation' });
  });

  it('a removal row removes that label and keeps the others, and the last removal leaves account_labels out', async () => {
    await labelAddress(h, SCAMMER, 'advisory', { removed: 1 });
    const one = await eventually(h, SCAMMER, (d) => !('advisory' in labelsOf(d)));
    expect(Object.keys(labelsOf(one))).toEqual(['scam']);

    await labelAddress(h, SCAMMER, 'scam', { removed: 1 });
    const none = await eventually(h, SCAMMER, (d) => !('account_labels' in d));
    expect(Object.keys(none)).toEqual(RIPPLE_KEYS);

    await labelAddress(h, SCAMMER, 'scam', { description: 'Back again' });
    expect((await eventually(h, SCAMMER, (d) => 'account_labels' in d)).account_labels).toEqual({
      scam: { description: 'Back again' },
    });
  });

  it('an address without a label has no account_labels', async () => {
    expect(Object.keys(await accountData(h, UNLABELLED))).toEqual(RIPPLE_KEYS);
  });

  it('an address with a name and a label carries account_name, then account_labels', async () => {
    await nameAddress(h, GATEHUB, 'GateHub');
    await labelAddress(h, GATEHUB, 'advisory', { description: 'Test label on a known address' });
    const data = await eventually(h, GATEHUB, (d) => 'account_name' in d && 'account_labels' in d);
    expect(Object.keys(data)).toEqual([...RIPPLE_KEYS, 'account_name', 'account_labels']);
  });

  it('an account with a name, a network name and a label carries account_labels last', async () => {
    await nameAccountOnNetwork(h, GATEHUB, 'USD Issuer');
    const data = await eventually(h, GATEHUB, (d) => 'account_network_name' in d && 'account_labels' in d);
    expect(Object.keys(data)).toEqual([...RIPPLE_KEYS, 'account_name', 'account_network_name', 'account_labels']);
  });

  it('an address with a label and no activation on the network is still not found', async () => {
    await labelAddress(h, NEVER_ACTIVATED, 'scam', { description: 'Never funded here' });
    // the label is loaded by the time a label inserted after it shows
    await labelAddress(h, UNLABELLED, 'spam', { description: 'Marker' });
    await eventually(h, UNLABELLED, (d) => 'account_labels' in d);
    const res = await (await h.api()).get(`/v2/accounts/${NEVER_ACTIVATED}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ result: 'error', message: 'Account not found' });
  });
});

describe('the reload of the labels', () => {
  // `fast` reloads every RELOAD_MS, `slow` at the default of 60 s; both read the shared database of `fast`.
  let fast: Harness;
  let slow: Harness;

  beforeAll(async () => {
    fast = await startHarness({ env: FAST_RELOAD });
    await activate(fast, SCAMMER);
    await labelAddress(fast, SCAMMER, 'scam', { description: 'Fake giveaway' });
    slow = await startHarness({ sharedDatabase: fast.sharedDatabase, env: NO_RATE_LIMIT });
    await activate(slow, SCAMMER);
  });
  afterAll(async () => {
    await slow?.close();
    await fast?.close();
  });

  it('the labels are loaded when the api starts', async () => {
    expect((await accountData(slow, SCAMMER)).account_labels).toEqual({ scam: { description: 'Fake giveaway' } });
  });

  it('a label inserted later shows at the next reload, not before', async () => {
    await labelAddress(fast, SCAMMER, 'spam', { description: 'Dust' });
    await eventually(fast, SCAMMER, (d) => 'spam' in labelsOf(d));
    // `fast` has reloaded since the insert; `slow` has not reached its first reload yet
    expect(Object.keys(labelsOf(await accountData(slow, SCAMMER)))).toEqual(['scam']);
  });
});

describe('labels on every network', () => {
  let xrpl: Harness;
  let xahau: Harness;

  beforeAll(async () => {
    xrpl = await startHarness({ network: 'xrpl', env: FAST_RELOAD });
    xahau = await startHarness({ network: 'xahau', sharedDatabase: xrpl.sharedDatabase, env: FAST_RELOAD });
    await activate(xrpl, SCAMMER);
    await activate(xahau, SCAMMER);
  });
  afterAll(async () => {
    await xahau?.close();
    await xrpl?.close();
  });

  it('a label on an address is served by the api of each network', async () => {
    await labelAddress(xrpl, SCAMMER, 'scam', { description: 'Fake giveaway' });
    const expected = { scam: { description: 'Fake giveaway' } };
    expect((await eventually(xrpl, SCAMMER, (d) => 'account_labels' in d)).account_labels).toEqual(expected);
    expect((await eventually(xahau, SCAMMER, (d) => 'account_labels' in d)).account_labels).toEqual(expected);
  });
});
