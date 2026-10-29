import {
  DomainTomlsRow,
  EMPTY_TOML_CONTENT,
  getNetworkProfile,
  recordToml,
  STORED_TOMLS_SQL,
  Table,
  tomlUrlOf,
} from '@gatehub/data-api-shared';
import { encodeNodePublic } from 'ripple-address-codec';
import { TOML_ACCOUNT_KEYS, TOML_CURRENCY_KEYS, TOML_KEYS, TOML_VALIDATOR_KEYS } from '../src/names/toml-object';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { accountAt } from './support/amm';
import { putToml } from './support/names-seed';
import { explain } from './support/plans';
import { BULK_BASES, insertBulk, readsOf } from './support/read-rows';

/**
 * `GET /v2/toml/{domain}` (D4, spec 6): what the store says of one domain. The suite is also the real ClickHouse test of what
 * the api reads for it: the newest row of the domain by key from `domain_tomls` (the largest `checked_at`, never `FINAL`), as
 * the tomls worker stores it.
 *
 * The rows are written the way their writer does: an `ok` row through `recordToml` (the text is read, as the worker reads it),
 * a failed one as the row spec 4.4 makes of a failed check (the api cannot import the syncer's `nextTomlRow`): within the
 * grace of a blip it carries the content and `fetched_at` of the row before it, after a definite failure, or after the grace,
 * it has none (`fetched_at` null). The merges of `domain_tomls` are stopped, so the older rows of a domain stay in their parts
 * and the reader has to choose.
 *
 * The api keeps the row of each domain asked, a domain with none too, for 60 s: a step that writes after the domain was asked
 * empties the caches first (the test route of `cache-controllers.ts`).
 *
 * Every domain is a `*.example` name, every name fictional.
 */

const CACHE_ROUTE = async () => (await import('./cache-controllers')).CACHE_CONTROLLERS;

const XRPL = getNetworkProfile('xrpl');

type Body = { result: string; toml: Record<string, unknown> };

/** Empties the caches of the app (the shared one and the one of the names): the next call reads `domain_tomls` again. */
const clearCaches = (api: ApiClient): Promise<unknown> => api.ok('/v2/test-cache/clear', 'result');

/** Stops the merges of `domain_tomls`: the rows a reader must choose between stay in their parts. */
const keepRows = (h: Harness): Promise<void> => h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.DomainTomls}`);

/** The unix second (with the milliseconds as a fraction) of an instant. */
const secondsOf = (iso: string): number => Date.parse(iso) / 1000;

/** `entry` has the keys of `order` it has, and in that order: none out of place, none made up. */
function expectKeysInOrder(entry: object, order: readonly string[]): void {
  const keys = Object.keys(entry);
  expect(keys).toEqual(order.filter((k) => keys.includes(k)));
}

/** The rows `domain_tomls` holds of `domain`, the merges being stopped: every check that was stored. */
async function storedRows(h: Harness, domain: string): Promise<number> {
  const [{ n }] = await h.ch.query<{ n: string }>(
    `SELECT count() AS n FROM ${Table.DomainTomls} WHERE domain = {domain:String}`,
    { domain },
  );
  return Number(n);
}

// ---------------------------------------------------------------------------------------------------------------------
// The tomls the suite stores
// ---------------------------------------------------------------------------------------------------------------------

const TREASURY = accountAt(0x7f01);
const PAYROLL = accountAt(0x7f02);
const TESTNET_RESERVE = accountAt(0x7f03); // listed for the test network only
const RESERVE = accountAt(0x7f04);
const VALIDATOR_KEY = encodeNodePublic(Buffer.from(`ED${'ab'.repeat(32)}`, 'hex'));
const OTHER_VALIDATOR_KEY = encodeNodePublic(Buffer.from(`ED${'cd'.repeat(32)}`, 'hex'));

/** Spec 6's example: what northpeak.example says. The entries for the test network are stored and are not served. */
const NORTHPEAK_TOML = `
[METADATA]
modified = 2026-10-02T00:00:00Z

[[ACCOUNTS]]
address = "${TREASURY}"
desc = "Northpeak Treasury"

[[ACCOUNTS]]
address = "${PAYROLL}"
desc = "Northpeak Payroll"

[[ACCOUNTS]]
address = "${TESTNET_RESERVE}"
network = "testnet"
desc = "Northpeak Test Treasury"

[[CURRENCIES]]
code = "NPUSD"
issuer = "${TREASURY}"
display_decimals = 2
name = "Northpeak Dollar"
is_asset_backed = true

[[CURRENCIES]]
code = "NPTST"
issuer = "${TESTNET_RESERVE}"
network = "testnet"
display_decimals = 6
name = "Northpeak Test Dollar"

[[PRINCIPALS]]
name = "Mara Lindqvist"

[[PRINCIPALS]]
name = "Tomas Okafor"

[[VALIDATORS]]
public_key = "${VALIDATOR_KEY}"
owner_country = "NO"
server_country = "DE"
unl = "https://vl.ripple.com"

[[VALIDATORS]]
public_key = "${OTHER_VALIDATOR_KEY}"
network = "testnet"
owner_country = "NO"
`;

const NORTHPEAK_CHECKED = '2026-10-24T07:12:09.410Z';

/** The answer of spec 6's example. */
const EXAMPLE: Body = {
  result: 'success',
  toml: {
    domain: 'northpeak.example',
    toml_url: 'https://northpeak.example/.well-known/xrp-ledger.toml',
    status: 'ok',
    checked: NORTHPEAK_CHECKED,
    fetched: NORTHPEAK_CHECKED,
    modified: '2026-10-02T00:00:00Z',
    accounts: [
      { address: TREASURY, desc: 'Northpeak Treasury' },
      { address: PAYROLL, desc: 'Northpeak Payroll' },
    ],
    currencies: [{ code: 'NPUSD', issuer: TREASURY, display_decimals: 2, name: 'Northpeak Dollar' }],
    principals: ['Mara Lindqvist', 'Tomas Okafor'],
    validators: [
      { public_key: VALIDATOR_KEY, owner_country: 'NO', server_country: 'DE', unl: 'https://vl.ripple.com' },
    ],
  },
};

/**
 * A toml with the personal data a file may hold: a principal with an email and the handles of the networks, a principal
 * named by an email, an organization, servers, and keys of the entries that are not the ones served.
 */
const QUILLFEATHER_TOML = `
[[ACCOUNTS]]
address = "${RESERVE}"
desc = "Quillfeather Reserve"

[[PRINCIPALS]]
name = "Ingrid Vasquez"
email = "ingrid@quillfeather.example"
twitter = "@ingridv"
github = "ingridv"
linkedin = "https://linkedin.example/in/ingridv"

[[PRINCIPALS]]
name = "support@quillfeather.example"
twitter = "@quillfeather"

[[PRINCIPALS]]
name = "Omar Haddad"

[[CURRENCIES]]
code = "QFD"
name = "Quill Dollar"
contact_email = "dollar@quillfeather.example"

[[VALIDATORS]]
public_key = "${VALIDATOR_KEY}"
owner_country = "US"
contact = "validator@quillfeather.example"
twitter = "@qfvalidator"

[[SERVERS]]
url = "wss://ws.quillfeather.example"

[ORGANIZATION]
name = "Quillfeather Holdings"
email = "info@quillfeather.example"
twitter = "@quillfeather"
`;

describe('GET /v2/toml/{domain}', () => {
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
    await keepRows(h);
    await putToml(h, XRPL, 'northpeak.example', NORTHPEAK_TOML, secondsOf(NORTHPEAK_CHECKED));
    await putToml(h, XRPL, 'quillfeather.example', QUILLFEATHER_TOML);
    await clearCaches(api);
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it('answers the example of the specification exactly: the entries of the network, the fields it serves, each key in its place', async () => {
    const res = await api.get('/v2/toml/northpeak.example');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(EXAMPLE);
    expect(Object.keys(res.body)).toEqual(['result', 'toml']);
    const toml = res.body.toml as Record<string, unknown[]>;
    expect(Object.keys(toml)).toEqual([...TOML_KEYS].filter((k) => !['reason', 'status_code', 'expires'].includes(k)));
    for (const account of toml.accounts) expectKeysInOrder(account as object, TOML_ACCOUNT_KEYS);
    for (const currency of toml.currencies) expectKeysInOrder(currency as object, TOML_CURRENCY_KEYS);
    for (const validator of toml.validators) expectKeysInOrder(validator as object, TOML_VALIDATOR_KEYS);
    expect(res.text).not.toContain('null');
  });

  it('serves the entries that count on the network and not the ones of the test network the store holds', async () => {
    const [stored] = await h.ch.query<Record<'accounts' | 'currencies' | 'validators', string>>(
      `SELECT length(accounts) AS accounts, length(currencies) AS currencies, length(validators) AS validators
         FROM ${Table.DomainTomls} WHERE domain = 'northpeak.example'`,
    );
    expect([stored.accounts, stored.currencies, stored.validators].map(Number)).toEqual([3, 2, 2]);

    const res = await api.get('/v2/toml/northpeak.example');
    const toml = res.body.toml as { accounts: unknown[]; currencies: unknown[]; validators: unknown[] };
    expect([toml.accounts.length, toml.currencies.length, toml.validators.length]).toEqual([2, 1, 1]);
    expect(res.text).not.toContain(TESTNET_RESERVE);
    expect(res.text).not.toContain('NPTST');
    expect(res.text).not.toContain(OTHER_VALIDATOR_KEY);
  });

  it('answers the same for a domain in capitals, with the domain in lower case', async () => {
    for (const asked of ['NorthPeak.Example', 'NORTHPEAK.EXAMPLE']) {
      const res = await api.get(`/v2/toml/${asked}`);

      expect([asked, res.status]).toEqual([asked, 200]);
      expect(res.body).toEqual(EXAMPLE);
    }
  });

  it('answers with the default Cache-Control', async () => {
    const res = await api.get('/v2/toml/northpeak.example');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, max-age=60');
  });

  it('serves no email or handle', async () => {
    const res = await api.get('/v2/toml/quillfeather.example');

    expect(res.status).toBe(200);
    expect(res.body.toml).toEqual({
      domain: 'quillfeather.example',
      toml_url: 'https://quillfeather.example/.well-known/xrp-ledger.toml',
      status: 'ok',
      checked: expect.any(String),
      fetched: expect.any(String),
      accounts: [{ address: RESERVE, desc: 'Quillfeather Reserve' }],
      currencies: [{ code: 'QFD', name: 'Quill Dollar' }],
      // the principal named by an email is no name
      principals: ['Ingrid Vasquez', 'Omar Haddad'],
      validators: [{ public_key: VALIDATOR_KEY, owner_country: 'US' }],
    });
    expect(res.text).not.toContain('@');
    for (const word of [
      'email',
      'twitter',
      'github',
      'linkedin',
      'contact',
      'ingridv',
      'wss://',
      'Holdings',
      'ORGANIZATION',
    ]) {
      expect([word, res.text.includes(word)]).toEqual([word, false]);
    }
  });

  describe('answers 400 invalid domain, with Cache-Control no-store, unless the domain in lower case is properly formed', () => {
    it.each([
      ['a URL, encoded', 'https%3A%2F%2Fx.com'],
      ['a single letter', 'x'],
      ['a single label', 'localhost'],
      ['a single label in capitals', 'NORTHPEAK'],
      ['an IP address', '127.0.0.1'],
      ['a domain with a port', 'northpeak.example%3A443'],
      ['a domain with a path', 'northpeak.example%2Fpath'],
      ['a domain with a space', 'north%20peak.example'],
      ['a domain with an underscore', 'north_peak.example'],
      ['a label that starts with a hyphen', '-northpeak.example'],
      ['a label that ends with a hyphen', 'northpeak-.example'],
      ['a domain that ends with a dot', 'northpeak.example.'],
      ['a top-level domain of digits', 'northpeak.123'],
      ['a domain that is not ASCII', 'n%C3%B6rthpeak.example'],
      ['a domain of 129 characters', `${'a'.repeat(63)}.${'b'.repeat(61)}.com`],
      ['an empty label', 'north..example'],
    ])('%s', async (_name, asked) => {
      const res = await api.get(`/v2/toml/${asked}`);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ result: 'error', message: 'invalid domain' });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('accepts a domain of 128 characters, which no toml belongs to', async () => {
      const longest = `${'a'.repeat(63)}.${'b'.repeat(60)}.com`;
      expect(longest).toHaveLength(128);

      const res = await api.get(`/v2/toml/${longest}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ result: 'error', message: 'toml not found' });
    });
  });

  it('answers 404 toml not found, with Cache-Control no-store, for a domain the store has no row of', async () => {
    const res = await api.get('/v2/toml/unknown.example');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ result: 'error', message: 'toml not found' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers 401 without an API key, with Cache-Control no-store', async () => {
    const res = await h.http().get('/v2/toml/northpeak.example');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ result: 'error', message: 'Missing or invalid API key.' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('keeps the row of a domain for 60 s, one that has none too: a row stored after it was asked shows when the caches are emptied', async () => {
    expect((await api.get('/v2/toml/latecomer.example')).status).toBe(404);

    await putToml(h, XRPL, 'latecomer.example', `[[ACCOUNTS]]\naddress = "${RESERVE}"\ndesc = "Latecomer Reserve"\n`);
    expect((await api.get('/v2/toml/latecomer.example')).status).toBe(404);

    await clearCaches(api);
    const res = await api.get('/v2/toml/latecomer.example');
    expect(res.status).toBe(200);
    expect(res.body.toml).toMatchObject({ domain: 'latecomer.example', accounts: [{ address: RESERVE }] });
  });

  it('follows the newest row of a domain: a later check that failed for good ends the content, a later one that read the file brings it back', async () => {
    const says = (desc: string) => `[[ACCOUNTS]]\naddress = "${RESERVE}"\ndesc = "${desc}"\n`;
    const READ = secondsOf('2026-10-22T09:00:00.000Z');
    const FAILED = secondsOf('2026-10-22T10:00:00.000Z');
    const READ_AGAIN = secondsOf('2026-10-22T11:00:00.000Z');

    await putToml(h, XRPL, 'tidal.example', says('Tidal Treasury'), READ);
    await clearCaches(api);
    expect((await api.get('/v2/toml/tidal.example')).body.toml).toMatchObject({
      status: 'ok',
      checked: '2026-10-22T09:00:00.000Z',
      accounts: [{ address: RESERVE, desc: 'Tidal Treasury' }],
    });

    // the older row stays in its part (the merges are stopped); the newer one is a definite failure
    await h.ch.insert(Table.DomainTomls, [
      {
        domain: 'tidal.example',
        toml_url: tomlUrlOf('tidal.example', XRPL),
        status: 'failed',
        reason: 'toml_invalid',
        status_code: 0,
        checked_at: FAILED,
        fetched_at: null,
        next_check_at: FAILED + 86_400,
        failures: 1,
        ...EMPTY_TOML_CONTENT,
      },
    ]);
    expect(await storedRows(h, 'tidal.example')).toBe(2);
    await clearCaches(api);
    expect((await api.get('/v2/toml/tidal.example')).body.toml).toEqual({
      domain: 'tidal.example',
      toml_url: 'https://tidal.example/.well-known/xrp-ledger.toml',
      status: 'failed',
      reason: 'toml_invalid',
      checked: '2026-10-22T10:00:00.000Z',
    });

    await putToml(h, XRPL, 'tidal.example', says('Tidal Treasury Ltd'), READ_AGAIN);
    expect(await storedRows(h, 'tidal.example')).toBe(3);
    await clearCaches(api);
    expect((await api.get('/v2/toml/tidal.example')).body.toml).toMatchObject({
      status: 'ok',
      checked: '2026-10-22T11:00:00.000Z',
      accounts: [{ address: RESERVE, desc: 'Tidal Treasury Ltd' }],
    });
  });

  describe('a toml whose last check failed (the rows of spec 4.4)', () => {
    const T0 = '2026-10-20T10:00:00.250Z';
    const T0_S = secondsOf(T0);
    const SAYS = `[METADATA]\nmodified = 2026-10-01T00:00:00Z\n\n[[ACCOUNTS]]\naddress = "${TREASURY}"\ndesc = "Tidewater Treasury"\n\n[[PRINCIPALS]]\nname = "Ines Brandt"\n`;

    /** The domain read at `T0` and the row of a check `later` seconds after it, which `failure` makes of the row read before it. */
    async function readThenFailed(
      domain: string,
      later: number,
      failure: (read: DomainTomlsRow, at: number) => DomainTomlsRow,
    ): Promise<void> {
      const read = await recordToml(h.ch, {
        domain,
        tomlUrl: tomlUrlOf(domain, XRPL),
        text: SAYS,
        fetchedAt: T0_S,
        recheckMs: 86_400_000,
        profile: XRPL,
      });
      await h.ch.insert(Table.DomainTomls, [failure(read, T0_S + later)]);
      expect(await storedRows(h, domain)).toBe(2);
    }

    beforeAll(async () => {
      // a blip: a transient failure an hour after the read carries the content and the instant it was read at
      await readThenFailed('blip.example', 3_600, (read, at) => ({
        ...read,
        status: 'failed',
        reason: 'http_status',
        status_code: 503,
        checked_at: at,
        next_check_at: Math.ceil(at) + 3_600,
        failures: read.failures + 1,
      }));
      // a transient failure after the 24 hours of the grace has no content, and was never fetched
      await readThenFailed('lapsed.example', 25 * 3_600, (read, at) => ({
        domain: read.domain,
        toml_url: read.toml_url,
        status: 'failed',
        reason: 'timeout',
        status_code: 0,
        checked_at: at,
        fetched_at: null,
        next_check_at: Math.ceil(at) + 3_600,
        failures: read.failures + 1,
        ...EMPTY_TOML_CONTENT,
      }));
      // a definite failure has none at once
      await readThenFailed('gone.example', 3_600, (read, at) => ({
        domain: read.domain,
        toml_url: read.toml_url,
        status: 'failed',
        reason: 'http_status',
        status_code: 404,
        checked_at: at,
        fetched_at: null,
        next_check_at: Math.ceil(at) + 86_400,
        failures: read.failures + 1,
        ...EMPTY_TOML_CONTENT,
      }));
      await clearCaches(api);
    }, 60_000);

    it('carries the content still in effect within its grace: the reason and the status code, the instant of the check and the one the content was read at', async () => {
      const res = await api.get('/v2/toml/blip.example');

      expect(res.status).toBe(200);
      expect(res.body.toml).toEqual({
        domain: 'blip.example',
        toml_url: 'https://blip.example/.well-known/xrp-ledger.toml',
        status: 'failed',
        reason: 'http_status',
        status_code: 503,
        checked: '2026-10-20T11:00:00.250Z',
        fetched: '2026-10-20T10:00:00.250Z',
        modified: '2026-10-01T00:00:00Z',
        accounts: [{ address: TREASURY, desc: 'Tidewater Treasury' }],
        principals: ['Ines Brandt'],
      });
      expectKeysInOrder(res.body.toml, TOML_KEYS);
    });

    it('carries none after the grace, and was not fetched', async () => {
      const res = await api.get('/v2/toml/lapsed.example');

      expect(res.status).toBe(200);
      expect(res.body.toml).toEqual({
        domain: 'lapsed.example',
        toml_url: 'https://lapsed.example/.well-known/xrp-ledger.toml',
        status: 'failed',
        reason: 'timeout',
        checked: '2026-10-21T11:00:00.250Z',
      });
    });

    it('carries none after a definite failure, with the reason and the status code', async () => {
      const res = await api.get('/v2/toml/gone.example');

      expect(res.status).toBe(200);
      expect(res.body.toml).toEqual({
        domain: 'gone.example',
        toml_url: 'https://gone.example/.well-known/xrp-ledger.toml',
        status: 'failed',
        reason: 'http_status',
        status_code: 404,
        checked: '2026-10-20T11:00:00.250Z',
      });
      expect(res.text).not.toContain('null');
    });
  });

  it('answers 500 unable to retrieve toml, with Cache-Control no-store, when domain_tomls cannot be read, and keeps nothing of the failure', async () => {
    // the ClickHouse client logs every failed statement to the console; this is the failure the test makes on purpose
    const log = console.error.bind(console);
    const spy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!args.some((arg) => /Unknown table expression identifier/.test(String(arg)))) log(...args);
    });
    // a domain never asked before: the row of a domain asked is kept 60 s and would be answered from there
    const unasked = '/v2/toml/never-asked.example';
    try {
      await h.ch.command(`RENAME TABLE ${h.database}.${Table.DomainTomls} TO ${h.database}.domain_tomls_away`);
      try {
        const res = await api.get(unasked);

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ result: 'error', message: 'unable to retrieve toml' });
        expect(res.headers['cache-control']).toBe('no-store');
      } finally {
        await h.ch.command(`RENAME TABLE ${h.database}.domain_tomls_away TO ${h.database}.${Table.DomainTomls}`);
      }
    } finally {
      spy.mockRestore();
    }

    // nothing was kept of the failure
    const again = await api.get(unasked);
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ result: 'error', message: 'toml not found' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The bound of the read
// ---------------------------------------------------------------------------------------------------------------------

describe('a request for a domain reads domain_tomls by key', () => {
  /** The rows ClickHouse reads for a granule of the primary index of domain_tomls (`index_granularity` is the default). */
  const GRANULE = 8192;
  /**
   * Three whole granules a part, which is more than two: a read of a part, or of two granules of it, is more than the bound
   * allows. Whole, because ClickHouse folds a tail of less than half a granule into the granule before it: a part of 20,000
   * rows has granules of 8,192 and 11,808 rows, and a key in the second reads 11,808.
   */
  const PER_PART = 3 * GRANULE;
  const PARTS = BULK_BASES.length;
  const BOUND = GRANULE * PARTS;
  const ROWS = PARTS * PER_PART;

  const DOMAIN = 'northpeak.example';
  /** The instant of the check stored in each part: the newest is not the part inserted last. */
  const CHECKED_S = [1_792_800_020, 1_792_800_040, 1_792_800_030, 1_792_800_010];
  const NEWEST_S = Math.max(...CHECKED_S);

  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    // the directory is read again every hour only: a reload of the whole table must not fall into the reads counted below
    h = await startHarness({
      env: { ...NO_RATE_LIMIT, GH_NAMES_AND_LABELS_RELOAD_MS: '3600000' },
      controllers: CACHE_ROUTE,
    });
    api = await h.api();
    // four parts of 24,576 domains each, merges stopped: 98,304 rows. Every part has a check of the domain asked, the others
    // are domains made of a hash, spread over the key space like the one asked. The template is a row of constants: the table
    // starts empty.
    await insertBulk(
      h,
      Table.DomainTomls,
      `SELECT '' AS domain, '' AS toml_url, 'ok' AS status, '' AS reason, toUInt16(0) AS status_code,
              toDateTime64(0, 3, 'UTC') AS checked_at, CAST(NULL AS Nullable(DateTime64(3, 'UTC'))) AS fetched_at,
              toDateTime(0, 'UTC') AS next_check_at, toUInt16(0) AS failures,
              CAST(NULL AS Nullable(DateTime('UTC'))) AS modified, CAST(NULL AS Nullable(DateTime('UTC'))) AS expires,
              CAST([], 'Array(Tuple(address String, network String, desc String))') AS accounts,
              CAST([], 'Array(Tuple(code String, issuer String, network String, fields String))') AS currencies,
              CAST([], 'Array(Tuple(public_key String, network String, fields String))') AS validators,
              CAST([], 'Array(String)') AS principals`,
      {},
      (base) =>
        `if(n.number = 0, '${DOMAIN}', concat(lower(base58Encode(reinterpretAsString(cityHash64(n.number, ${base})))), '.example')) AS domain,
         '${tomlUrlOf(DOMAIN, XRPL)}' AS toml_url,
         toDateTime64(${CHECKED_S[BULK_BASES.indexOf(base)]}, 3, 'UTC') AS checked_at,
         toDateTime64(${CHECKED_S[BULK_BASES.indexOf(base)]}, 3, 'UTC') AS fetched_at,
         toDateTime(${CHECKED_S[BULK_BASES.indexOf(base)]} + 86400, 'UTC') AS next_check_at`,
      PER_PART,
    );
  }, 600_000);
  afterAll(async () => {
    await h?.close();
  });

  it('holds more rows than the bound, in four parts of more than two granules each, so a scan of a part would break it', async () => {
    const parts = await h.ch.query<{ rows: string }>(
      `SELECT count() AS rows FROM ${Table.DomainTomls} GROUP BY _part ORDER BY _part`,
    );
    expect(parts.map((part) => Number(part.rows))).toEqual(Array(PARTS).fill(PER_PART));
    for (const part of parts) expect(Number(part.rows)).toBeGreaterThan(2 * GRANULE);
    expect(ROWS).toBeGreaterThan(BOUND);
    // and a read of one part, of any size the key allows, can not be mistaken for a read by key
    expect(PER_PART).toBeGreaterThan(GRANULE);
  });

  it('reads at most one granule per part, in one statement, and answers the check with the largest checked_at, whichever part it is in', async () => {
    await clearCaches(api);
    let body: Body | undefined;
    const reads = await readsOf(h, Table.DomainTomls, async () => {
      body = (await api.ok<Body>(`/v2/toml/${DOMAIN}`, 'toml')).body;
    });

    expect(reads).toHaveLength(1);
    expect(reads[0].query).toContain(`FROM ${Table.DomainTomls}`);
    expect(reads[0].read_rows).toBeGreaterThan(0);
    expect(reads[0].read_rows).toBeLessThanOrEqual(BOUND);

    expect(body?.toml).toEqual({
      domain: DOMAIN,
      toml_url: 'https://northpeak.example/.well-known/xrp-ledger.toml',
      status: 'ok',
      checked: new Date(NEWEST_S * 1000).toISOString(),
      fetched: new Date(NEWEST_S * 1000).toISOString(),
    });
  });

  it('shows the primary key condition on domain in the plan of the read', async () => {
    const plan = await explain(h, 'indexes = 1', STORED_TOMLS_SQL, { domains: [DOMAIN] });

    expect(plan).toContain('PrimaryKey');
    expect(plan).toMatch(/Keys:\s*\n?\s*domain/);
    expect(plan).toMatch(/Condition: .*domain in/);
    // the key narrows the read to a part of the granules of every part
    const granules = /Granules: (\d+)\/(\d+)/.exec(plan.slice(plan.indexOf('PrimaryKey')));
    expect(granules).not.toBeNull();
    expect(Number(granules?.[1])).toBeLessThan(Number(granules?.[2]));
  });
});
