import { encodeAccountID } from 'ripple-address-codec';
import type { DomainTomlsRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { getNetworkProfile } from '../network';
import { TomlContent, TomlInvalidError } from './toml-read';
import { okTomlRow, readStoredTomls, recordToml, STORED_TOMLS_SQL, tomlUrlOf } from './toml-store';

// Every domain, address and name below is hand-written test data.

const XRPL = getNetworkProfile('xrpl');
const XAHAU = getNetworkProfile('xahau');

/** 2025-10-24T10:00:00.500Z */
const NOW = 1_761_300_000.5;
const RECHECK_MS = 86_400_000;
const DOMAIN = 'northpeak.example';
const URL = `https://${DOMAIN}/.well-known/xahau.toml`;

const address = (n: number): string => {
  const id = Buffer.alloc(20);
  id.writeUInt32BE(n, 16);
  return encodeAccountID(id);
};

const CONTENT: TomlContent = {
  modified: 1_760_000_000,
  expires: 1_790_000_000,
  accounts: [{ address: address(1), network: 'main', desc: 'Treasury' }],
  currencies: [{ code: 'NPK', issuer: address(2), network: '', fields: '{"symbol":"NPK"}' }],
  validators: [{ public_key: 'nHBNorthPeakValidator', network: 'xahau', fields: '{}' }],
  principals: ['Ada North'],
};

const TEXT = `
[METADATA]
modified = 2025-10-01T00:00:00Z
expires = 2026-12-31T00:00:00Z

[[ACCOUNTS]]
address = "${address(1)}"
network = "Main"
desc = "Treasury"

[[CURRENCIES]]
code = "NPK"
issuer = "${address(2)}"
symbol = "NPK"

[[PRINCIPALS]]
name = "Ada North"
`;

describe('tomlUrlOf', () => {
  it('is the file of the network on the domain', () => {
    expect(tomlUrlOf('northpeak.example', XAHAU)).toBe('https://northpeak.example/.well-known/xahau.toml');
    expect(tomlUrlOf('northpeak.example', XRPL)).toBe('https://northpeak.example/.well-known/xrp-ledger.toml');
  });
});

describe('okTomlRow', () => {
  it('is an ok row: the content, checked and fetched now, no failures, the next check after the recheck time', () => {
    expect(okTomlRow({ domain: DOMAIN, tomlUrl: URL, content: CONTENT, now: NOW, recheckMs: RECHECK_MS })).toEqual({
      domain: DOMAIN,
      toml_url: URL,
      status: 'ok',
      reason: '',
      status_code: 0,
      checked_at: NOW,
      fetched_at: NOW,
      // 1_761_300_000.5 + 86_400 = 1_761_386_400.5, a whole second up
      next_check_at: 1_761_386_401,
      failures: 0,
      modified: CONTENT.modified,
      expires: CONTENT.expires,
      accounts: CONTENT.accounts,
      currencies: CONTENT.currencies,
      validators: CONTENT.validators,
      principals: CONTENT.principals,
    });
  });

  it('stores the domain in lower case and the url as it is given', () => {
    const row = okTomlRow({ domain: 'NorthPeak.Example', tomlUrl: URL, content: CONTENT, now: NOW, recheckMs: 1_000 });
    expect(row.domain).toBe(DOMAIN);
    expect(row.toml_url).toBe(URL);
  });

  it('waits the recheck time from now, to a whole second', () => {
    const next = (now: number, recheckMs: number) =>
      okTomlRow({ domain: DOMAIN, tomlUrl: URL, content: CONTENT, now, recheckMs }).next_check_at;
    expect(next(1_000, 1_500)).toBe(1_002);
    expect(next(1_000.25, 1_750)).toBe(1_002);
    expect(next(1_000, 1)).toBe(1_001);
    expect(next(1_000, 86_400_000)).toBe(87_400);
  });

  it('keeps null dates and empty lists', () => {
    const empty: TomlContent = {
      modified: null,
      expires: null,
      accounts: [],
      currencies: [],
      validators: [],
      principals: [],
    };
    expect(okTomlRow({ domain: DOMAIN, tomlUrl: URL, content: empty, now: NOW, recheckMs: RECHECK_MS })).toMatchObject(
      empty,
    );
  });

  it('takes the six fields of the content and nothing else', () => {
    const content = { ...CONTENT, secret: 'never stored' } as TomlContent;
    const row = okTomlRow({ domain: DOMAIN, tomlUrl: URL, content, now: NOW, recheckMs: RECHECK_MS });
    expect(row).not.toHaveProperty('secret');
  });
});

describe('recordToml', () => {
  const store = () => ({ insert: jest.fn().mockResolvedValue(undefined) });
  const call = (ch: ReturnType<typeof store>, text: string, fetchedAt = NOW) =>
    recordToml(ch, { domain: DOMAIN, tomlUrl: URL, text, fetchedAt, recheckMs: RECHECK_MS, profile: XAHAU });

  it('reads the text and inserts its ok row, which it returns', async () => {
    const ch = store();
    const row = await call(ch, TEXT);
    expect(row).toMatchObject({
      domain: DOMAIN,
      toml_url: URL,
      status: 'ok',
      reason: '',
      status_code: 0,
      checked_at: NOW,
      fetched_at: NOW,
      failures: 0,
      modified: Date.parse('2025-10-01T00:00:00Z') / 1000,
      expires: Date.parse('2026-12-31T00:00:00Z') / 1000,
      accounts: [{ address: address(1), network: 'main', desc: 'Treasury' }],
      currencies: [{ code: 'NPK', issuer: address(2), network: '', fields: '{"symbol":"NPK"}' }],
      validators: [],
      principals: ['Ada North'],
    });
    expect(ch.insert).toHaveBeenCalledTimes(1);
    expect(ch.insert).toHaveBeenCalledWith(Table.DomainTomls, [row]);
  });

  it('reads the dates against the time of the fetch', async () => {
    // a modified two days after the fetch is no date of the file
    const text = `[METADATA]\nmodified = ${new Date((NOW + 2 * 86_400) * 1000).toISOString()}\n`;
    expect((await call(store(), text)).modified).toBeNull();
    expect((await call(store(), text, NOW + 2 * 86_400)).modified).toBe(Math.floor(NOW + 2 * 86_400));
  });

  it('throws TomlInvalidError and writes nothing for a text that is not TOML', async () => {
    const ch = store();
    await expect(call(ch, 'this = is = not toml\n[[')).rejects.toBeInstanceOf(TomlInvalidError);
    expect(ch.insert).not.toHaveBeenCalled();
  });

  it('does not catch the failure of the insert', async () => {
    const ch = { insert: jest.fn().mockRejectedValue(new Error('clickhouse is down')) };
    await expect(call(ch, TEXT)).rejects.toThrow('clickhouse is down');
  });
});

describe('STORED_TOMLS_SQL', () => {
  it('reads the newest row of each domain by key, with the domains bound', () => {
    expect(STORED_TOMLS_SQL.replace(/\s+/g, ' ')).toBe(
      'SELECT domain, toml_url, status, reason, status_code, ' +
        'toUnixTimestamp64Milli(checked_at) AS checked_ms, toUnixTimestamp64Milli(fetched_at) AS fetched_ms, ' +
        'toUnixTimestamp(next_check_at) AS next_check, failures, ' +
        'toUnixTimestamp(modified) AS modified_s, toUnixTimestamp(expires) AS expires_s, ' +
        'accounts, currencies, validators, principals ' +
        'FROM domain_tomls WHERE domain IN {domains:Array(String)} ORDER BY domain, checked_at DESC LIMIT 1 BY domain',
    );
    expect(STORED_TOMLS_SQL).toContain(Table.DomainTomls);
    expect(STORED_TOMLS_SQL).not.toMatch(/\bFINAL\b/i);
  });
});

describe('readStoredTomls', () => {
  /** A row as ClickHouse gives it: the milliseconds of an Int64 quoted, a NULL as null. */
  const raw = (over: Record<string, unknown> = {}) => ({
    domain: DOMAIN,
    toml_url: URL,
    status: 'ok',
    reason: '',
    status_code: 0,
    checked_ms: '1761300000500',
    fetched_ms: '1761300000500',
    next_check: 1_761_386_401,
    failures: 0,
    modified_s: 1_760_000_000,
    expires_s: 1_790_000_000,
    accounts: CONTENT.accounts,
    currencies: CONTENT.currencies,
    validators: CONTENT.validators,
    principals: CONTENT.principals,
    ...over,
  });

  it('makes no query for no domains', async () => {
    const ch = { query: jest.fn() };
    expect(await readStoredTomls(ch, [])).toEqual(new Map());
    expect(ch.query).not.toHaveBeenCalled();
  });

  it('binds the domains and gives the rows by key, with the numbers read back', async () => {
    const other = raw({
      domain: 'other.example',
      status: 'failed',
      reason: 'http_status',
      status_code: '503',
      checked_ms: '1761213600250',
      fetched_ms: null,
      next_check: '1761217200',
      failures: '3',
      modified_s: null,
      expires_s: null,
      accounts: [],
      currencies: [],
      validators: [],
      principals: [],
    });
    const ch = { query: jest.fn().mockResolvedValue([raw(), other]) };
    const found = await readStoredTomls(ch, [DOMAIN, 'other.example', 'absent.example']);

    expect(ch.query).toHaveBeenCalledWith(STORED_TOMLS_SQL, { domains: [DOMAIN, 'other.example', 'absent.example'] });
    expect([...found.keys()]).toEqual([DOMAIN, 'other.example']);
    expect(found.get(DOMAIN)).toEqual({
      domain: DOMAIN,
      toml_url: URL,
      status: 'ok',
      reason: '',
      status_code: 0,
      checked_at: 1_761_300_000.5,
      fetched_at: 1_761_300_000.5,
      next_check_at: 1_761_386_401,
      failures: 0,
      ...CONTENT,
    } satisfies DomainTomlsRow);
    expect(found.get('other.example')).toEqual({
      domain: 'other.example',
      toml_url: URL,
      status: 'failed',
      reason: 'http_status',
      status_code: 503,
      checked_at: 1_761_213_600.25,
      fetched_at: null,
      next_check_at: 1_761_217_200,
      failures: 3,
      modified: null,
      expires: null,
      accounts: [],
      currencies: [],
      validators: [],
      principals: [],
    } satisfies DomainTomlsRow);
  });
});
