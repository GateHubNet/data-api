import { getNetworkProfile, Table } from '@gatehub/data-api-shared';
import { createHash } from 'node:crypto';
import { classicAddressToXAddress, encodeAccountID } from 'ripple-address-codec';
import { ACCOUNT_DOMAINS_SQL } from '../src/names/account-domains.service';
import {
  ACCOUNT_NAME_ENTRY_KEYS,
  ACCOUNT_NAMES_BODY_KEYS,
  DISPLAY_NAME_KEYS,
  LABEL_KEYS,
} from '../src/names/account-names-object';
import { TOML_LISTINGS_SQL } from '../src/names/domain-tomls.service';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { accountAt } from './support/amm';
import {
  failToml,
  hexOf,
  holds,
  insertTomlsBulk,
  nameAddress,
  nameOnNetwork,
  putToml,
  setAccountDomain,
  tomlOf,
} from './support/names-seed';
import { explain } from './support/plans';
import { BULK_BASES, BULK_PER_PART, BULK_ROWS, insertBulk, readsOf } from './support/read-rows';

/**
 * `GET /v2/account_names` (D4, spec 5.2): the display names of up to 100 addresses in one call. The suite is also the real
 * ClickHouse test of what the api reads for it: the account domain by key from `account_domains` (the newest row of an account
 * by `version`, never `FINAL`) and what the toml of each account's domain says of it, by key from `domain_tomls` (the newest
 * row of each domain of the batch, the entries of the addresses asked that count on the network).
 *
 * The rows are written with plain inserts, the way their writers do: `account_domains` as the ingest does (one insert, so one
 * part, a row), `domain_tomls` through `recordToml` as the tomls worker does, and the operator's names and labels with SQL. The
 * api reloads the names every `GH_NAMES_AND_LABELS_RELOAD_MS` (a fraction of a second here) and keeps the account domain of
 * each address and what its domain's toml says of it 60 s, so a step that changes `account_domains` or `domain_tomls` clears
 * the caches first (the test route of `cache-controllers.ts`) and a step that changes the names waits for the next reload
 * (`eventually`).
 *
 * Every domain is a `*.example` name, every name fictional.
 */

const FAST_RELOAD = { GH_NAMES_AND_LABELS_RELOAD_MS: '100', ...NO_RATE_LIMIT };
const CACHE_ROUTE = async () => (await import('./cache-controllers')).CACHE_CONTROLLERS;

const XRPL = getNetworkProfile('xrpl');
const XAHAU = getNetworkProfile('xahau');

type Entry = Record<string, unknown>;

/** `entry` has the keys of `order` it has, and in that order: none out of place, none made up. */
function expectKeysInOrder(entry: object, order: readonly string[]): void {
  const keys = Object.keys(entry);
  expect(keys).toEqual(order.filter((k) => keys.includes(k)));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The path of a call. */
const pathOf = (addresses: readonly string[]): string => `/v2/account_names?addresses=${addresses.join(',')}`;

/** The entries of the answer for `addresses` (any status but 200 throws). */
async function entriesOf(api: ApiClient, addresses: readonly string[]): Promise<Entry[]> {
  return (await api.ok<{ account_names: Entry[] }>(pathOf(addresses), 'account_names')).body.account_names;
}

/**
 * The entries for `addresses` once `until` holds for them, asked again and again for up to `timeoutMs`: a row of the names shows
 * at the next reload. Throws with the last answer when it never does.
 */
async function eventually(
  api: ApiClient,
  addresses: readonly string[],
  until: (entries: Entry[]) => boolean,
  timeoutMs = 15_000,
): Promise<Entry[]> {
  const deadline = Date.now() + timeoutMs;
  let entries = await entriesOf(api, addresses);
  while (!until(entries)) {
    if (Date.now() > deadline) throw new Error(`still ${JSON.stringify(entries)} after ${timeoutMs} ms`);
    await sleep(25);
    entries = await entriesOf(api, addresses);
  }
  return entries;
}

/** Empties the caches of the app (the shared one and the one of the names): the next call reads `account_domains` and `domain_tomls` again. */
const clearCaches = (api: ApiClient): Promise<unknown> => api.ok('/v2/test-cache/clear', 'result');

/** The kind of the display name of each entry (`undefined` for none). */
const kinds = (entries: Entry[]): (string | undefined)[] =>
  entries.map((entry) => (entry.display_name as { kind?: string } | undefined)?.kind);

// ---------------------------------------------------------------------------------------------------------------------
// What the suite writes
// ---------------------------------------------------------------------------------------------------------------------

/** The operator's insert of a label (the shared database); `source` and `url` are left empty when not given. */
async function labelAddress(
  h: Harness,
  address: string,
  label: 'scam' | 'spam' | 'advisory',
  description: string,
  { source = '', url = '' }: { source?: string; url?: string } = {},
): Promise<void> {
  await h.ch.command(
    `INSERT INTO ${h.sharedDatabase}.account_labels (address, label, description, source, url, added_by)
     VALUES ({address:String}, {label:String}, {description:String}, {source:String}, {url:String}, 'compliance@gatehub.net')`,
    { address, label, description, source, url },
  );
}

/** Stops the merges of the tables the api reads for the names: the rows a reader must choose between stay in their parts. */
async function keepRows(h: Harness): Promise<void> {
  for (const table of [Table.AccountDomains, Table.DomainTomls])
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${table}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// The answer of spec 5.2
// ---------------------------------------------------------------------------------------------------------------------

const TREASURY = accountAt(0x7e01); // northpeak.example lists it: verified
const PAYROLL = accountAt(0x7e02); // northpeak.example lists it, with no desc
const HARBOR = accountAt(0x7e03); // named, with a network name and an advisory label; no domain, no account
const LOWTIDE = accountAt(0x7e04); // lowtide.example does not list it: an unverified domain
const NOBODY = accountAt(0x7e05); // nothing names it
const WATCHED = accountAt(0x7e06); // the three labels, with and without a source and a url; no account
const LOWTIDE_RESERVE = accountAt(0x7e07); // the one account lowtide.example lists

/** The four accounts of spec 5.2's example, as the api answers them. */
const EXAMPLE: Entry[] = [
  { address: TREASURY, display_name: { text: 'Northpeak Treasury', kind: 'verified' }, domain: 'northpeak.example' },
  {
    address: HARBOR,
    display_name: { text: 'Harborline Exchange', kind: 'account' },
    account_name: 'Harborline Exchange',
    account_network_name: 'hot wallet',
    labels: {
      advisory: { description: 'Withdrawals paused since 2026-10-01', url: 'https://harborline.example/status' },
    },
  },
  { address: LOWTIDE, display_name: { text: 'lowtide.example', kind: 'domain' }, domain: 'lowtide.example' },
  { address: NOBODY },
];

describe('GET /v2/account_names', () => {
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ env: FAST_RELOAD, controllers: CACHE_ROUTE });
    api = await h.api();
    await keepRows(h);

    await holds(h, TREASURY, 'northpeak.example');
    await holds(h, PAYROLL, 'northpeak.example');
    await holds(h, LOWTIDE, 'lowtide.example');
    await putToml(
      h,
      XRPL,
      'northpeak.example',
      tomlOf({ address: TREASURY, desc: 'Northpeak Treasury' }, { address: PAYROLL }),
    );
    await putToml(h, XRPL, 'lowtide.example', tomlOf({ address: LOWTIDE_RESERVE, desc: 'Lowtide Reserve' }));

    await nameAddress(h, HARBOR, 'Harborline Exchange');
    await nameOnNetwork(h, HARBOR, 'hot wallet');
    await labelAddress(h, HARBOR, 'advisory', 'Withdrawals paused since 2026-10-01', {
      url: 'https://harborline.example/status',
    });
    // inserted in the opposite order of the answer
    await labelAddress(h, WATCHED, 'advisory', 'Named in a warning');
    await labelAddress(h, WATCHED, 'spam', 'Dust payments', { source: 'Harbor compliance desk' });
    await labelAddress(h, WATCHED, 'scam', 'Fake giveaway', {
      source: 'Harbor compliance desk',
      url: 'https://harborline.example/reports/1',
    });

    await clearCaches(api);
    // the first reload after the inserts has loaded the names
    await eventually(
      api,
      [TREASURY, PAYROLL, HARBOR, WATCHED],
      (entries) =>
        kinds(entries)[0] === 'verified' &&
        kinds(entries)[1] === 'verified' &&
        entries[2].account_network_name === 'hot wallet' &&
        Object.keys((entries[2].labels ?? {}) as object).length === 1 &&
        Object.keys((entries[3].labels ?? {}) as object).length === 3,
    );
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it('answers the four accounts of the example exactly: verified with its domain, named with a network name and an advisory label, an unverified domain, nothing', async () => {
    const res = await api.get(pathOf([TREASURY, HARBOR, LOWTIDE, NOBODY]));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: 'success', count: 4, account_names: EXAMPLE });
    expect(Object.keys(res.body)).toEqual([...ACCOUNT_NAMES_BODY_KEYS]);
    for (const entry of res.body.account_names as Entry[]) expectKeysInOrder(entry, ACCOUNT_NAME_ENTRY_KEYS);
    expect(Object.keys(res.body.account_names[0].display_name)).toEqual([...DISPLAY_NAME_KEYS]);
    expect(Object.keys(res.body.account_names[1].labels.advisory)).toEqual(['description', 'url']);
    expect(res.headers['cache-control']).toBe('private, max-age=60');
    expect(res.text).not.toContain('null');
  });

  it('carries the source and the url of a label when the operator gave them, the labels in the order scam, spam, advisory', async () => {
    const [entry] = await entriesOf(api, [WATCHED]);

    expect(entry).toEqual({
      address: WATCHED,
      labels: {
        scam: {
          description: 'Fake giveaway',
          source: 'Harbor compliance desk',
          url: 'https://harborline.example/reports/1',
        },
        spam: { description: 'Dust payments', source: 'Harbor compliance desk' },
        advisory: { description: 'Named in a warning' },
      },
    });
    const labels = entry.labels as Record<string, object>;
    expect(Object.keys(labels)).toEqual(['scam', 'spam', 'advisory']);
    expect(Object.keys(labels.scam)).toEqual([...LABEL_KEYS]);
    expect(Object.keys(labels.spam)).toEqual(['description', 'source']);
    expect(Object.keys(labels.advisory)).toEqual(['description']);
  });

  it('names a verified account that its toml lists with no desc by its domain', async () => {
    expect(await entriesOf(api, [PAYROLL])).toEqual([
      { address: PAYROLL, display_name: { text: 'northpeak.example', kind: 'verified' }, domain: 'northpeak.example' },
    ]);
  });

  it('answers each address asked at its place, in the order asked, a repeated one at each place', async () => {
    const asked = [LOWTIDE, TREASURY, NOBODY, TREASURY, HARBOR, HARBOR, WATCHED];
    const res = await api.ok(pathOf(asked), 'account_names');
    const { count, account_names: names } = res.body as { count: number; account_names: Entry[] };

    expect(count).toBe(7);
    expect(names.map((entry) => entry.address)).toEqual(asked);
    expect(names[1]).toEqual(EXAMPLE[0]);
    expect(names[3]).toEqual(EXAMPLE[0]);
    expect(names[4]).toEqual(EXAMPLE[1]);
    expect(names[5]).toEqual(EXAMPLE[1]);
    expect(Object.keys(names[5].labels as object)).toEqual(['advisory']);
  });

  it('answers 100 addresses, a repeated address counting towards the 100', async () => {
    const entries = await entriesOf(api, Array(100).fill(TREASURY));

    expect(entries).toHaveLength(100);
    expect(entries.every((entry) => entry.address === TREASURY && entry.domain === 'northpeak.example')).toBe(true);
  });

  it('serves the name and the labels of an address that is no account on the network, and no domain', async () => {
    for (const address of [HARBOR, WATCHED]) {
      const [{ n }] = await h.ch.query<{ n: string }>(
        `SELECT count() AS n FROM ${Table.AccountsCreated} WHERE account = {address:String}`,
        { address },
      );
      expect(Number(n)).toBe(0);
    }
    const [harbor, watched] = await entriesOf(api, [HARBOR, WATCHED]);
    expect(harbor).toMatchObject({ account_name: 'Harborline Exchange', labels: { advisory: expect.anything() } });
    expect(watched).toMatchObject({ labels: { scam: expect.anything() } });
    expect(harbor).not.toHaveProperty('domain');
    expect(watched).not.toHaveProperty('domain');
  });

  it('ignores a parameter it does not know', async () => {
    const res = await api.get(`${pathOf([TREASURY, NOBODY])}&limit=1&format=csv&marker=x&foo=bar`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: 'success', count: 2, account_names: [EXAMPLE[0], EXAMPLE[3]] });
  });

  it('reads the first of a repeated parameter and of addresses[]', async () => {
    const repeated = await api.get(`/v2/account_names?addresses=${TREASURY}&addresses=${HARBOR},${NOBODY}`);
    expect(repeated.status).toBe(200);
    expect(repeated.body.account_names).toEqual([EXAMPLE[0]]);

    const array = await api.get(`/v2/account_names?addresses[]=${HARBOR},${LOWTIDE}&addresses[]=${NOBODY}`);
    expect(array.status).toBe(200);
    expect(array.body.account_names).toEqual([EXAMPLE[1], EXAMPLE[2]]);
  });

  it('distinguishes the case of an address: base58 is case-sensitive', async () => {
    const res = await api.get(pathOf([TREASURY.toLowerCase()]));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ result: 'error', message: 'invalid ripple address' });
  });

  describe('answers 400, in the order of the checks, with Cache-Control no-store', () => {
    const MANY = Array.from({ length: 101 }, (_, i) => accountAt(0x100 + i)).join(',');
    const X_ADDRESS = classicAddressToXAddress(TREASURY, false, false);
    const BAD_CHECKSUM = `${TREASURY.slice(0, -1)}${TREASURY.endsWith('x') ? 'y' : 'x'}`;

    it.each([
      ['no addresses', '/v2/account_names', 'addresses is required'],
      ['an empty addresses', '/v2/account_names?addresses=', 'addresses is required'],
      ['101 addresses', `/v2/account_names?addresses=${MANY}`, 'too many addresses - at most 100'],
      [
        '101 elements none of which is an address',
        `/v2/account_names?addresses=${','.repeat(100)}`,
        'too many addresses - at most 100',
      ],
      ['an X-address', `/v2/account_names?addresses=${X_ADDRESS}`, 'invalid ripple address'],
      [
        'an X-address among valid addresses',
        `/v2/account_names?addresses=${TREASURY},${X_ADDRESS}`,
        'invalid ripple address',
      ],
      ['a bad checksum', `/v2/account_names?addresses=${BAD_CHECKSUM}`, 'invalid ripple address'],
      ['an empty element', `/v2/account_names?addresses=${TREASURY},,${HARBOR}`, 'invalid ripple address'],
      ['a space', `/v2/account_names?addresses=${TREASURY},%20${HARBOR}`, 'invalid ripple address'],
    ])('%s', async (_name, path, message) => {
      const res = await api.get(path);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ result: 'error', message });
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  it('answers 401 without an API key, with Cache-Control no-store', async () => {
    const res = await h.http().get(pathOf([TREASURY]));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ result: 'error', message: 'Missing or invalid API key.' });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// account_domains: the newest row of an account, by key
// ---------------------------------------------------------------------------------------------------------------------

describe('the account domain of an address, read from account_domains', () => {
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ env: FAST_RELOAD, controllers: CACHE_ROUTE });
    api = await h.api();
    await keepRows(h);
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  /** The `domain` of each address asked, `undefined` for none. */
  async function domainsOf(...addresses: string[]): Promise<(unknown | undefined)[]> {
    await clearCaches(api);
    return (await entriesOf(api, addresses)).map((entry) => entry.domain);
  }

  it('takes the newest row of an account by version, not the one inserted last, with the merges stopped', async () => {
    const MOVED = accountAt(0x201);
    const LATE = accountAt(0x202);
    // the newer row is inserted first and the older after it, each in a part of its own
    await holds(h, MOVED, 'new-home.example', 5000);
    await holds(h, MOVED, 'old-home.example', 4000);
    // a row of a later ledger of the same account
    await holds(h, LATE, 'first.example', 100);
    await holds(h, LATE, 'second.example', 200);
    await holds(h, LATE, 'third.example', 300);
    const [{ parts }] = await h.ch.query<{ parts: string }>(
      `SELECT uniqExact(_part) AS parts FROM ${Table.AccountDomains} WHERE account IN ({a:String}, {b:String})`,
      { a: MOVED, b: LATE },
    );
    expect(Number(parts)).toBe(5);

    expect(await domainsOf(MOVED, LATE)).toEqual(['new-home.example', 'third.example']);
  });

  it('has no domain for an account whose newest row is deleted, whose Domain was cleared, or whose Domain is no domain', async () => {
    const DELETED = accountAt(0x211);
    const CLEARED = accountAt(0x212);
    const JUNK = accountAt(0x213);
    const NEVER = accountAt(0x214);
    await holds(h, DELETED, 'closed.example', 100);
    await setAccountDomain(h, DELETED, 200, hexOf('closed.example'), 1);
    await holds(h, CLEARED, 'dropped.example', 100);
    await setAccountDomain(h, CLEARED, 200, '');
    await setAccountDomain(h, JUNK, 100, hexOf('not a domain'));

    expect(await domainsOf(DELETED, CLEARED, JUNK, NEVER)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('has the domain of an account that was deleted and made again with a Domain of its own', async () => {
    const REBORN = accountAt(0x221);
    await holds(h, REBORN, 'before.example', 100);
    await setAccountDomain(h, REBORN, 200, hexOf('before.example'), 1);
    await holds(h, REBORN, 'after.example', 300);

    expect(await domainsOf(REBORN)).toEqual(['after.example']);
  });

  it('gives the domain in lower case, which is how the toml store holds it', async () => {
    const MIXED = accountAt(0x231);
    await setAccountDomain(h, MIXED, 100, hexOf('Harbor-Line.Example'));
    await putToml(h, XRPL, 'harbor-line.example', tomlOf({ address: MIXED, desc: 'Harbor Line' }));

    await clearCaches(api);
    const [entry] = await eventually(api, [MIXED], (entries) => kinds(entries)[0] === 'verified');
    expect(entry).toEqual({
      address: MIXED,
      display_name: { text: 'Harbor Line', kind: 'verified' },
      domain: 'harbor-line.example',
    });
  });

  it('keeps an answer for 60 s per address: a row inserted after it shows when the caches are emptied', async () => {
    const LATER = accountAt(0x241);
    expect(await domainsOf(LATER)).toEqual([undefined]);

    await holds(h, LATER, 'later.example', 100);
    expect((await entriesOf(api, [LATER]))[0]).toEqual({ address: LATER });
    expect(await domainsOf(LATER)).toEqual(['later.example']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// domain_tomls: what the toml of an account's domain says of it
// ---------------------------------------------------------------------------------------------------------------------

describe('what the toml of the account domain says, read from domain_tomls', () => {
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ env: FAST_RELOAD, controllers: CACHE_ROUTE });
    api = await h.api();
    await keepRows(h);
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it('counts the entries of the network (none, main, mainnet) and not those of another (testnet, xahau, 21337)', async () => {
    const NETWORKS: [number, string | number | undefined, boolean][] = [
      [1, undefined, true],
      [2, 'main', true],
      [3, 'Mainnet', true],
      [4, 'testnet', false],
      [5, 'xahau', false],
      [6, 21337, false],
      [7, 'devnet', false],
    ];
    const accounts = NETWORKS.map(([n]) => accountAt(0x300 + n));
    for (const address of accounts) await holds(h, address, 'multinet.example');
    await putToml(
      h,
      XRPL,
      'multinet.example',
      tomlOf(...NETWORKS.map(([n, network]) => ({ address: accountAt(0x300 + n), network, desc: `Account ${n}` }))),
    );

    await clearCaches(api);
    const entries = await eventually(api, accounts, (list) => kinds(list).includes('verified'));

    expect(kinds(entries)).toEqual(NETWORKS.map(([, , counts]) => (counts ? 'verified' : 'domain')));
    expect(entries.map((entry) => entry.domain)).toEqual(NETWORKS.map(() => 'multinet.example'));
  });

  it('follows the newest row of a domain: a later check that lists nobody ends the verification, a later one that lists the account brings it back', async () => {
    const ACCOUNT = accountAt(0x321);
    await holds(h, ACCOUNT, 'tidal.example');
    await putToml(h, XRPL, 'tidal.example', tomlOf({ address: ACCOUNT, desc: 'Tidal Treasury' }));

    const verified = {
      address: ACCOUNT,
      display_name: { text: 'Tidal Treasury', kind: 'verified' },
      domain: 'tidal.example',
    };
    const unverified = {
      address: ACCOUNT,
      display_name: { text: 'tidal.example', kind: 'domain' },
      domain: 'tidal.example',
    };
    await clearCaches(api);
    expect(await eventually(api, [ACCOUNT], (entries) => kinds(entries)[0] === 'verified')).toEqual([verified]);

    // the older row still lists the account (merges are stopped); the newer one, a definite failure, lists nobody
    await failToml(h, 'tidal.example');
    // within the 60 s it keeps what it read
    expect(await entriesOf(api, [ACCOUNT])).toEqual([verified]);
    await clearCaches(api);
    expect(await entriesOf(api, [ACCOUNT])).toEqual([unverified]);

    await putToml(h, XRPL, 'tidal.example', tomlOf({ address: ACCOUNT, desc: 'Tidal Treasury Ltd' }));
    await clearCaches(api);
    expect(await entriesOf(api, [ACCOUNT])).toEqual([
      { ...verified, display_name: { text: 'Tidal Treasury Ltd', kind: 'verified' } },
    ]);
  });

  it('lists an account under the domain of its Domain field only: a toml of another domain does not vouch for it', async () => {
    const ACCOUNT = accountAt(0x331);
    const LOUD = accountAt(0x332);
    await holds(h, ACCOUNT, 'quiet.example');
    await holds(h, LOUD, 'loud.example');
    // loud.example lists both; quiet.example lists nobody
    await putToml(
      h,
      XRPL,
      'loud.example',
      tomlOf({ address: ACCOUNT, desc: 'Loud Treasury' }, { address: LOUD, desc: 'Loud Desk' }),
    );
    await putToml(h, XRPL, 'quiet.example', tomlOf());

    await clearCaches(api);
    // asked in one batch, so the one read holds the row of loud.example that lists ACCOUNT
    expect(await entriesOf(api, [ACCOUNT, LOUD])).toEqual([
      { address: ACCOUNT, display_name: { text: 'quiet.example', kind: 'domain' }, domain: 'quiet.example' },
      { address: LOUD, display_name: { text: 'Loud Desk', kind: 'verified' }, domain: 'loud.example' },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Xahau
// ---------------------------------------------------------------------------------------------------------------------

describe('GET /v2/account_names on Xahau and XRPL, sharing the names', () => {
  let xrpl: Harness;
  let xahau: Harness;
  let xrplApi: ApiClient;
  let xahauApi: ApiClient;

  /** Lists A under `network = 21337` and B under `network = "testnet"`. */
  const A = accountAt(0x401);
  const B = accountAt(0x402);
  const TOML = tomlOf(
    { address: A, network: 21337, desc: 'Tidewater Xahau' },
    { address: B, network: 'testnet', desc: 'Tidewater Testnet' },
  );

  beforeAll(async () => {
    xrpl = await startHarness({ network: 'xrpl', env: FAST_RELOAD, controllers: CACHE_ROUTE });
    xahau = await startHarness({
      network: 'xahau',
      sharedDatabase: xrpl.sharedDatabase,
      env: FAST_RELOAD,
      controllers: CACHE_ROUTE,
    });
    xrplApi = await xrpl.api();
    xahauApi = await xahau.api();
    // the same accounts, domain and toml text on both networks, each network with its own database
    for (const [h, profile] of [
      [xrpl, XRPL],
      [xahau, XAHAU],
    ] as const) {
      await holds(h, A, 'tidewater.example');
      await holds(h, B, 'tidewater.example');
      await putToml(h, profile, 'tidewater.example', TOML);
    }
    await nameAddress(xrpl, A, 'Tidewater');
    await nameOnNetwork(xahau, A, 'Tidewater on Xahau');
    await labelAddress(xrpl, A, 'advisory', 'Under review');
    await clearCaches(xrplApi);
    await clearCaches(xahauApi);
  }, 180_000);
  afterAll(async () => {
    await xahau?.close();
    await xrpl?.close();
  });

  it('verifies a Xahau account whose entry says network = 21337, and not an XRPL account whose entry says testnet', async () => {
    const onXahau = await eventually(xahauApi, [A, B], (entries) => kinds(entries)[0] === 'verified');
    expect(onXahau[0]).toMatchObject({
      address: A,
      display_name: { text: 'Tidewater Xahau', kind: 'verified' },
      domain: 'tidewater.example',
    });

    // the toml of the XRPL api is the same text: its entry for A (21337) and for B (testnet) count on neither
    const onXrpl = await eventually(xrplApi, [A, B], (entries) => entries[0].account_name === 'Tidewater');
    expect(kinds(onXrpl)).not.toContain('verified');
    expect(onXrpl[1]).toEqual({
      address: B,
      display_name: { text: 'tidewater.example', kind: 'domain' },
      domain: 'tidewater.example',
    });
    // and B (testnet) does not count on Xahau either
    expect(onXahau[1]).toEqual(onXrpl[1]);
  });

  it('serves the account names and the labels on both networks and the network names of each network only', async () => {
    const [onXrpl] = await eventually(xrplApi, [A], (entries) => entries[0].labels !== undefined);
    const [onXahau] = await eventually(
      xahauApi,
      [A],
      (entries) => entries[0].labels !== undefined && entries[0].account_network_name !== undefined,
    );

    // the name of the shared database and the label are on both; the verified name wins on Xahau, the account name on XRPL
    expect(onXrpl).toEqual({
      address: A,
      display_name: { text: 'Tidewater', kind: 'account' },
      domain: 'tidewater.example',
      account_name: 'Tidewater',
      labels: { advisory: { description: 'Under review' } },
    });
    expect(onXahau).toEqual({
      address: A,
      display_name: { text: 'Tidewater Xahau', kind: 'verified' },
      domain: 'tidewater.example',
      account_name: 'Tidewater',
      account_network_name: 'Tidewater on Xahau',
      labels: { advisory: { description: 'Under review' } },
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Failures of the store
// ---------------------------------------------------------------------------------------------------------------------

describe('when the tables the names are read from cannot be read', () => {
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    // the ClickHouse client logs every failed statement to the console; these are the failures the tests make on purpose
    const log = console.error.bind(console);
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!args.some((arg) => /Unknown table expression identifier/.test(String(arg)))) log(...args);
    });
    h = await startHarness({ env: FAST_RELOAD, controllers: CACHE_ROUTE });
    api = await h.api();
  }, 120_000);
  afterAll(async () => {
    await h?.close();
    jest.restoreAllMocks();
  });

  const rename = (from: Table | string, to: string): Promise<void> =>
    h.ch.command(`RENAME TABLE ${h.database}.${from} TO ${h.database}.${to}`);

  it('answers 200 with the names, the labels and the domains but no verified or domain kind when domain_tomls cannot be read, and keeps nothing of the failure', async () => {
    const LISTED = accountAt(0xf101);
    const UNLISTED = accountAt(0xf102);
    const NAMED = accountAt(0xf103);
    await holds(h, LISTED, 'northpeak.example');
    await holds(h, UNLISTED, 'northpeak.example');
    await holds(h, NAMED, 'northpeak.example');
    await putToml(h, XRPL, 'northpeak.example', tomlOf({ address: LISTED, desc: 'Northpeak Treasury' }));
    await nameAddress(h, NAMED, 'Northpeak Desk');
    await labelAddress(h, UNLISTED, 'advisory', 'Under review');
    // the names and labels are in memory once a reload has loaded them
    await clearCaches(api);
    const before = await eventually(
      api,
      [LISTED, UNLISTED, NAMED],
      (entries) => entries[1].labels !== undefined && entries[2].account_name === 'Northpeak Desk',
    );
    expect(kinds(before)).toEqual(['verified', 'domain', 'account']);
    // what was read for an address asked is kept 60 s and would be answered from there
    await clearCaches(api);

    await rename(Table.DomainTomls, 'domain_tomls_away');
    try {
      const res = await api.get(pathOf([LISTED, UNLISTED, NAMED]));

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('private, max-age=60');
      expect(res.body.account_names).toEqual([
        { address: LISTED, domain: 'northpeak.example' },
        { address: UNLISTED, domain: 'northpeak.example', labels: { advisory: { description: 'Under review' } } },
        {
          address: NAMED,
          display_name: { text: 'Northpeak Desk', kind: 'account' },
          domain: 'northpeak.example',
          account_name: 'Northpeak Desk',
        },
      ]);
    } finally {
      await rename('domain_tomls_away', Table.DomainTomls);
    }

    // nothing was kept of the failure: the next call reads the toml and vouches
    expect(kinds(await entriesOf(api, [LISTED, UNLISTED, NAMED]))).toEqual(['verified', 'domain', 'account']);
  });

  it('answers 500 when account_domains cannot be read', async () => {
    // addresses never asked before: the account domain of an address asked is kept 60 s and would be answered from there
    const UNASKED = [accountAt(0xf001), accountAt(0xf002)];

    await rename(Table.AccountDomains, 'account_domains_away');
    try {
      const res = await api.get(pathOf(UNASKED));

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ result: 'error', message: 'unable to retrieve account names' });
      expect(res.headers['cache-control']).toBe('no-store');
    } finally {
      await rename('account_domains_away', Table.AccountDomains);
    }

    // nothing was kept of the failure
    const again = await api.get(pathOf(UNASKED));
    expect(again.status).toBe(200);
    expect(again.body).toEqual({
      result: 'success',
      count: 2,
      account_names: UNASKED.map((address) => ({ address })),
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The bound of the read
// ---------------------------------------------------------------------------------------------------------------------

describe('a batch of 100 accounts reads account_domains by key', () => {
  /** The rows ClickHouse reads for a granule of the primary index of account_domains (`index_granularity = 1024`). */
  const GRANULE = 1024;
  const ASKED = 100;
  const BOUND = ASKED * BULK_BASES.length * GRANULE;

  /** An address spread over the key space: the AccountID is a hash. */
  const spread = (i: number): string =>
    encodeAccountID(createHash('sha256').update(`asked-${i}`).digest().subarray(0, 20));
  const addresses = Array.from({ length: ASKED }, (_, i) => spread(i));

  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ env: FAST_RELOAD, controllers: CACHE_ROUTE });
    api = await h.api();
    // four parts of 200,000 accounts each, merges stopped: 800,000 rows, twice the bound. The first 100 accounts of every part
    // are the ones asked, with the domain of the part (the newest part has the newest version); the others are accounts made of
    // a hash, spread over the key space like the addresses asked. The template is a row of constants: the table starts empty.
    await insertBulk(
      h,
      Table.AccountDomains,
      `SELECT '' AS account, toUInt32(0) AS ledger_index, toUInt32(0) AS tx_index, toUInt16(0) AS node_index,
              toUInt64(0) AS version, '' AS domain_hex, toUInt8(0) AS deleted`,
      { asked: addresses },
      (base) =>
        `if(n.number < ${ASKED}, arrayElement({asked:Array(String)}, toUInt32(n.number) + 1),
            concat('r', base58Encode(reinterpretAsString(cityHash64(n.number, ${base}))))) AS account,
         toUInt32(${base} + intDiv(n.number, 4)) AS ledger_index,
         toUInt32(n.number % 4) AS tx_index,
         bitOr(bitShiftLeft(toUInt64(${base} + intDiv(n.number, 4)), 32), bitShiftLeft(toUInt64(n.number % 4), 16)) AS version,
         hex(concat('part', toString(intDiv(${base}, 1000000)), '.example')) AS domain_hex`,
    );
  }, 600_000);
  afterAll(async () => {
    await h?.close();
  });

  it('holds more rows than the bound, in four parts', async () => {
    const [{ rows, parts }] = await h.ch.query<{ rows: string; parts: string }>(
      `SELECT count() AS rows, uniqExact(_part) AS parts FROM ${Table.AccountDomains}`,
    );
    expect(Number(rows)).toBe(BULK_ROWS);
    expect(Number(parts)).toBe(BULK_BASES.length);
    expect(BULK_ROWS).toBe(BULK_BASES.length * BULK_PER_PART);
    // a scan of the table would break the bound: the test can fail
    expect(BULK_ROWS).toBeGreaterThan(BOUND);
  });

  it('reads at most one granule per address per part, in one statement, and answers the newest part', async () => {
    await clearCaches(api);
    let body: { count: number; account_names: Entry[] } | undefined;
    const reads = await readsOf(h, Table.AccountDomains, async () => {
      body = (await api.ok<{ count: number; account_names: Entry[] }>(pathOf(addresses), 'account_names')).body;
    });

    expect(reads).toHaveLength(1);
    expect(reads[0].query).toContain(`FROM ${Table.AccountDomains}`);
    const read = reads.reduce((sum, r) => sum + r.read_rows, 0);
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThanOrEqual(BOUND);

    // the account domain of each is the one of the newest part, whichever order the parts were written in
    expect(body?.count).toBe(ASKED);
    expect(body?.account_names.map((entry) => entry.address)).toEqual(addresses);
    expect(new Set(body?.account_names.map((entry) => entry.domain))).toEqual(new Set(['part24.example']));
  });

  it('shows the primary key condition on account in the plan of the read', async () => {
    const plan = await explain(h, 'indexes = 1', ACCOUNT_DOMAINS_SQL, { addresses });

    expect(plan).toContain('PrimaryKey');
    expect(plan).toMatch(/Keys:\s*\n?\s*account/);
    expect(plan).toMatch(/Condition: .*account in/);
    // the key narrows the read to a part of the granules of every part
    const granules = /Granules: (\d+)\/(\d+)/.exec(plan.slice(plan.indexOf('PrimaryKey')));
    expect(granules).not.toBeNull();
    expect(Number(granules?.[1])).toBeLessThan(Number(granules?.[2]));
  });
});

describe('a batch reads domain_tomls by key, for the domains of its accounts only', () => {
  /** The rows ClickHouse reads for a granule of the primary index of domain_tomls (`index_granularity` is the default). */
  const GRANULE = 8192;
  /**
   * Three whole granules a part: a read of a part, or of two granules of it, is more than the bound allows. Whole, because
   * ClickHouse folds a tail of less than half a granule into the granule before it (a key in it would read more than one).
   */
  const PER_PART = 3 * GRANULE;
  const PARTS = BULK_BASES.length;
  /** The two domains of the batch, in every part: at most one granule of each per part. */
  const DOMAINS = ['bulk-east.example', 'bulk-west.example'];
  const BOUND = DOMAINS.length * GRANULE * PARTS;
  const ROWS = PARTS * PER_PART;
  /** The instant of the check stored in each part: the newest is not the part inserted last. */
  const CHECKED_S = [1_792_800_020, 1_792_800_040, 1_792_800_030, 1_792_800_010];
  const NEWEST_S = Math.max(...CHECKED_S);

  /** Three accounts of each domain; the toml of each domain lists all six, so only the account's own domain may vouch. */
  const ACCOUNTS = Array.from({ length: 6 }, (_, i) => accountAt(0x9100 + i));
  const domainOf = (i: number): string => DOMAINS[i % 2];

  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ env: FAST_RELOAD, controllers: CACHE_ROUTE });
    api = await h.api();
    for (const [i, account] of ACCOUNTS.entries()) await holds(h, account, domainOf(i));
    // four parts of 24,576 domains each, merges stopped: 98,304 rows. Every part holds a check of both domains of the batch
    await insertTomlsBulk(h, { domains: DOMAINS, checkedS: CHECKED_S, perPart: PER_PART, listed: ACCOUNTS });
  }, 600_000);
  afterAll(async () => {
    await h?.close();
  });

  it('reads no toml at the boot, nor in two reload intervals after it: nothing of the store is read but on request', async () => {
    await sleep(3 * Number(FAST_RELOAD.GH_NAMES_AND_LABELS_RELOAD_MS));
    await h.ch.command('SYSTEM FLUSH LOGS');
    const [{ n }] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM system.query_log
        WHERE current_database = {db:String} AND query_kind = 'Select' AND has(tables, {table:String})`,
      { db: h.database, table: `${h.database}.${Table.DomainTomls}` },
    );
    expect(Number(n)).toBe(0);
  });

  it('holds more rows than the bound, in four parts of more than two granules each, so a scan would break it', async () => {
    const parts = await h.ch.query<{ rows: string }>(
      `SELECT count() AS rows FROM ${Table.DomainTomls} GROUP BY _part ORDER BY _part`,
    );
    expect(parts.map((part) => Number(part.rows))).toEqual(Array(PARTS).fill(PER_PART));
    expect(ROWS).toBeGreaterThan(BOUND);
  });

  it('reads at most one granule per domain per part, in one statement, and answers from the newest check of each domain', async () => {
    await clearCaches(api);
    let entries: Entry[] = [];
    const reads = await readsOf(h, Table.DomainTomls, async () => {
      entries = await entriesOf(api, ACCOUNTS);
    });

    expect(reads).toHaveLength(1);
    expect(reads[0].query).toContain(`FROM ${Table.DomainTomls}`);
    expect(reads[0].query).toContain('domain IN');
    expect(reads[0].read_rows).toBeGreaterThan(0);
    expect(reads[0].read_rows).toBeLessThanOrEqual(BOUND);

    expect(entries).toEqual(
      ACCOUNTS.map((address, i) => ({
        address,
        display_name: { text: `Checked ${NEWEST_S}`, kind: 'verified' },
        domain: domainOf(i),
      })),
    );
  });

  it('shows the primary key condition on domain in the plan of the read', async () => {
    const plan = await explain(h, 'indexes = 1', TOML_LISTINGS_SQL, { domains: DOMAINS, addresses: ACCOUNTS });

    expect(plan).toContain('PrimaryKey');
    expect(plan).toMatch(/Keys:\s*\n?\s*domain/);
    expect(plan).toMatch(/Condition: .*domain in/);
    // the key narrows the read to a part of the granules of every part
    const granules = /Granules: (\d+)\/(\d+)/.exec(plan.slice(plan.indexOf('PrimaryKey')));
    expect(granules).not.toBeNull();
    expect(Number(granules?.[1])).toBeLessThan(Number(granules?.[2]));
  });
});
