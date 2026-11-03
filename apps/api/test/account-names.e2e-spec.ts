import { Table } from '@gatehub/data-api-shared';
import { Harness, startHarness } from './harness';
import { accountAt, hashOf } from './support/amm';

/**
 * Account names (ADR-0014): the operator names an address by inserting a row into `account_names` of the shared
 * database, and `GET /v2/accounts/{address}` carries the name as `account_name` on every network. The rows are written
 * here with plain SQL inserts, the operator's write path; the api loads the names whole and reloads them on a timer
 * (`GH_NAMES_AND_LABELS_RELOAD_MS`, 60 s by default, a fraction of a second in these suites).
 *
 * `/v2/accounts/{address}` answers only for an address with an activation on the network, so each account here gets an
 * `accounts_created` row by hand.
 */

const RELOAD_MS = '100';
const FAST_RELOAD = { GH_NAMES_AND_LABELS_RELOAD_MS: RELOAD_MS };

const GATEHUB = accountAt(0x6a7e);
const BITSTAMP = accountAt(0xb175);
const NAMELESS = accountAt(0x0b0d);
const NEVER_ACTIVATED = accountAt(0xdead);

/** An activation of `account` in ledger 1000, made by hand: what makes `/v2/accounts/{address}` answer. */
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

/** The operator's insert: a name for an address, or with `removed` the removal of its name. */
async function nameAddress(
  h: Harness,
  address: string,
  name: string,
  { removed = 0, addedBy = 'ops@gatehub.net' }: { removed?: 0 | 1; addedBy?: string } = {},
): Promise<void> {
  await h.ch.command(
    `INSERT INTO ${h.sharedDatabase}.account_names (address, name, removed, added_by)
     VALUES ({address:String}, {name:String}, {removed:UInt8}, {addedBy:String})`,
    { address, name, removed, addedBy },
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

const RIPPLE_KEYS = ['account', 'parent', 'initial_balance', 'inception', 'ledger_index', 'tx_hash'];

describe('account names on /v2/accounts/{address}', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ env: FAST_RELOAD });
    await activate(h, GATEHUB, BITSTAMP, NAMELESS);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('an account whose address has a name carries it as account_name, after the Ripple keys', async () => {
    await nameAddress(h, GATEHUB, 'GateHub');
    const data = await eventually(h, GATEHUB, (d) => 'account_name' in d);
    expect(data.account_name).toBe('GateHub');
    expect(Object.keys(data)).toEqual([...RIPPLE_KEYS, 'account_name']);
  });

  it('an account whose address has no name has no account_name', async () => {
    await nameAddress(h, BITSTAMP, 'Bitstamp');
    await eventually(h, BITSTAMP, (d) => 'account_name' in d);
    expect(Object.keys(await accountData(h, NAMELESS))).toEqual(RIPPLE_KEYS);
  });

  it('a newer name of the address replaces the older one', async () => {
    await nameAddress(h, BITSTAMP, 'Bitstamp');
    await eventually(h, BITSTAMP, (d) => d.account_name === 'Bitstamp');
    await nameAddress(h, BITSTAMP, 'Bitstamp Ltd', { addedBy: 'someone.else@gatehub.net' });
    expect((await eventually(h, BITSTAMP, (d) => d.account_name !== 'Bitstamp')).account_name).toBe('Bitstamp Ltd');
  });

  it('a removal row removes the name, and a name given after it shows again', async () => {
    await nameAddress(h, GATEHUB, 'GateHub');
    await eventually(h, GATEHUB, (d) => d.account_name === 'GateHub');
    await nameAddress(h, GATEHUB, '', { removed: 1 });
    const removed = await eventually(h, GATEHUB, (d) => !('account_name' in d));
    expect(Object.keys(removed)).toEqual(RIPPLE_KEYS);

    await nameAddress(h, GATEHUB, 'GateHub Limited');
    expect((await eventually(h, GATEHUB, (d) => 'account_name' in d)).account_name).toBe('GateHub Limited');
  });

  it('an address with a name and no activation on the network is still not found', async () => {
    await nameAddress(h, NEVER_ACTIVATED, 'Nobody');
    // the name is loaded by the time the next name inserted after it shows
    await nameAddress(h, NAMELESS, 'Marker');
    await eventually(h, NAMELESS, (d) => d.account_name === 'Marker');
    const res = await (await h.api()).get(`/v2/accounts/${NEVER_ACTIVATED}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ result: 'error', message: 'Account not found' });
  });
});

describe('the reload of the account names', () => {
  // `fast` reloads every RELOAD_MS, `slow` at the default of 60 s; both read the shared database of `fast`.
  let fast: Harness;
  let slow: Harness;

  beforeAll(async () => {
    fast = await startHarness({ env: FAST_RELOAD });
    await activate(fast, GATEHUB);
    await nameAddress(fast, GATEHUB, 'GateHub');
    slow = await startHarness({ sharedDatabase: fast.sharedDatabase });
    await activate(slow, GATEHUB);
  });
  afterAll(async () => {
    await slow?.close();
    await fast?.close();
  });

  it('the names are loaded when the api starts', async () => {
    expect((await accountData(slow, GATEHUB)).account_name).toBe('GateHub');
  });

  it('a name inserted later shows at the next reload, not before', async () => {
    await nameAddress(fast, GATEHUB, 'GateHub Limited');
    await eventually(fast, GATEHUB, (d) => d.account_name === 'GateHub Limited');
    // `fast` has reloaded since the insert; `slow` has not reached its first reload yet
    expect((await accountData(slow, GATEHUB)).account_name).toBe('GateHub');
  });
});

describe('account names on every network', () => {
  let xrpl: Harness;
  let xahau: Harness;

  beforeAll(async () => {
    xrpl = await startHarness({ network: 'xrpl', env: FAST_RELOAD });
    xahau = await startHarness({ network: 'xahau', sharedDatabase: xrpl.sharedDatabase, env: FAST_RELOAD });
    await activate(xrpl, GATEHUB);
    await activate(xahau, GATEHUB);
  });
  afterAll(async () => {
    await xahau?.close();
    await xrpl?.close();
  });

  it('the name of an address is served by the api of each network', async () => {
    await nameAddress(xrpl, GATEHUB, 'GateHub');
    expect((await eventually(xrpl, GATEHUB, (d) => 'account_name' in d)).account_name).toBe('GateHub');
    expect((await eventually(xahau, GATEHUB, (d) => 'account_name' in d)).account_name).toBe('GateHub');
  });
});

describe('account names when the shared database cannot be read', () => {
  let h: Harness;

  beforeAll(async () => {
    // a shared database nobody created: every load fails
    h = await startHarness({ sharedDatabase: 'api_e2e_shared_missing', env: FAST_RELOAD });
    await activate(h, GATEHUB);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('the account is still served, without a name', async () => {
    await new Promise((resolve) => setTimeout(resolve, 3 * Number(RELOAD_MS)));
    expect(await accountData(h, GATEHUB)).toEqual({
      account: GATEHUB,
      parent: accountAt(1),
      initial_balance: '20',
      inception: '2023-11-14T22:13:20Z',
      ledger_index: 1000,
      tx_hash: hashOf(1000),
    });
  });
});
