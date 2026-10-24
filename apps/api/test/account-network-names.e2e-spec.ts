import { Table } from '@gatehub/data-api-shared';
import { Harness, startHarness } from './harness';
import { accountAt, hashOf } from './support/amm';

/**
 * Account network names (ADR-0014): the operator gives an account a name on one network ("USD Issuer" on the XRP
 * Ledger) by inserting a row into `account_network_names` of that network's database, and `GET /v2/accounts/{address}`
 * of that network carries it as `account_network_name`, beside the account name of the shared database. The rows are
 * written here with plain SQL inserts, the operator's write path; the api loads them with the names and reloads them on
 * the same timer (`GH_NAMES_AND_LABELS_RELOAD_MS`, 60 s by default, a fraction of a second in these suites).
 *
 * `/v2/accounts/{address}` answers only for an address with an activation on the network, so each account here gets an
 * `accounts_created` row by hand.
 */

const RELOAD_MS = '100';
const FAST_RELOAD = { GH_NAMES_AND_LABELS_RELOAD_MS: RELOAD_MS };

const ISSUER = accountAt(0x05d1);
const HOT_WALLET = accountAt(0x0407);
const NAMELESS = accountAt(0x0b0d);

const RIPPLE_KEYS = ['account', 'parent', 'initial_balance', 'inception', 'ledger_index', 'tx_hash'];

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

interface Removal {
  removed?: 0 | 1;
}

/** The operator's insert into the network database of `h`: a network name for an address, or its removal. */
async function nameOnNetwork(h: Harness, address: string, name: string, { removed = 0 }: Removal = {}): Promise<void> {
  await h.ch.command(
    `INSERT INTO ${h.database}.account_network_names (address, name, removed, added_by)
     VALUES ({address:String}, {name:String}, {removed:UInt8}, 'ops@gatehub.net')`,
    { address, name, removed },
  );
}

/** The operator's insert into the shared database: an account name for an address, the same on every network. */
async function nameAddress(h: Harness, address: string, name: string): Promise<void> {
  await h.ch.command(
    `INSERT INTO ${h.sharedDatabase}.account_names (address, name, added_by)
     VALUES ({address:String}, {name:String}, 'ops@gatehub.net')`,
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

describe('account network names on /v2/accounts/{address}', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ env: FAST_RELOAD });
    await activate(h, ISSUER, HOT_WALLET, NAMELESS);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('an account with a network name and no account name carries account_network_name alone', async () => {
    await nameOnNetwork(h, HOT_WALLET, 'Hot wallet');
    const data = await eventually(h, HOT_WALLET, (d) => 'account_network_name' in d);
    expect(data.account_network_name).toBe('Hot wallet');
    expect(Object.keys(data)).toEqual([...RIPPLE_KEYS, 'account_network_name']);
  });

  it('an account with an account name and a network name carries both, account_name first', async () => {
    await nameAddress(h, ISSUER, 'GateHub');
    await nameOnNetwork(h, ISSUER, 'USD Issuer');
    const data = await eventually(h, ISSUER, (d) => 'account_name' in d && 'account_network_name' in d);
    expect(data).toMatchObject({ account_name: 'GateHub', account_network_name: 'USD Issuer' });
    expect(Object.keys(data)).toEqual([...RIPPLE_KEYS, 'account_name', 'account_network_name']);
  });

  it('an account with neither has neither key', async () => {
    expect(Object.keys(await accountData(h, NAMELESS))).toEqual(RIPPLE_KEYS);
  });

  it('a newer network name replaces the older one, and the account name stays', async () => {
    await nameOnNetwork(h, ISSUER, 'USD Issuer');
    await eventually(h, ISSUER, (d) => d.account_network_name === 'USD Issuer');
    await nameOnNetwork(h, ISSUER, 'USD and EUR Issuer');
    const data = await eventually(h, ISSUER, (d) => d.account_network_name !== 'USD Issuer');
    expect(data).toMatchObject({ account_name: 'GateHub', account_network_name: 'USD and EUR Issuer' });
  });

  it('a removal row removes the network name and leaves the account name, and a name given after it shows again', async () => {
    await nameOnNetwork(h, ISSUER, 'USD Issuer');
    await eventually(h, ISSUER, (d) => d.account_network_name === 'USD Issuer');
    await nameOnNetwork(h, ISSUER, '', { removed: 1 });
    const removed = await eventually(h, ISSUER, (d) => !('account_network_name' in d));
    expect(Object.keys(removed)).toEqual([...RIPPLE_KEYS, 'account_name']);
    expect(removed.account_name).toBe('GateHub');

    await nameOnNetwork(h, ISSUER, 'EUR Issuer');
    expect((await eventually(h, ISSUER, (d) => 'account_network_name' in d)).account_network_name).toBe('EUR Issuer');
  });
});

describe('account network names on one network only', () => {
  let xrpl: Harness;
  let xahau: Harness;

  beforeAll(async () => {
    xrpl = await startHarness({ network: 'xrpl', env: FAST_RELOAD });
    xahau = await startHarness({ network: 'xahau', sharedDatabase: xrpl.sharedDatabase, env: FAST_RELOAD });
    await activate(xrpl, ISSUER);
    await activate(xahau, ISSUER);
  });
  afterAll(async () => {
    await xahau?.close();
    await xrpl?.close();
  });

  it('a network name given on xrpl shows on xrpl and not on xahau, where the account name does show', async () => {
    await nameOnNetwork(xrpl, ISSUER, 'USD Issuer');
    await nameAddress(xrpl, ISSUER, 'GateHub');
    expect(await eventually(xrpl, ISSUER, (d) => 'account_name' in d && 'account_network_name' in d)).toMatchObject({
      account_name: 'GateHub',
      account_network_name: 'USD Issuer',
    });
    const onXahau = await eventually(xahau, ISSUER, (d) => 'account_name' in d);
    expect(Object.keys(onXahau)).toEqual([...RIPPLE_KEYS, 'account_name']);
  });
});

describe('the reload of the account network names', () => {
  let h: Harness;

  beforeAll(async () => {
    // the default reload, 60 s: no reload happens during this suite
    h = await startHarness();
    await activate(h, ISSUER);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('a network name inserted after the api started does not show before the next reload', async () => {
    await nameOnNetwork(h, ISSUER, 'USD Issuer');
    await new Promise((resolve) => setTimeout(resolve, 3 * Number(RELOAD_MS)));
    expect(Object.keys(await accountData(h, ISSUER))).toEqual(RIPPLE_KEYS);
  });
});
