import { encodeAccountID } from 'ripple-address-codec';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { DomainTomlsRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { getNetworkProfile } from '../src/network';
import { EMPTY_TOML_CONTENT, TomlInvalidError } from '../src/tomls/toml-read';
import { okTomlRow, readStoredTomls, recordToml, tomlUrlOf } from '../src/tomls/toml-store';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

/**
 * The rows of the toml store on a real ClickHouse: `recordToml` writes the ok row of a file in hand, `readStoredTomls` gives
 * back the newest row of each domain by key. Every domain, address and name is hand-written test data.
 */

const XAHAU = getNetworkProfile('xahau');
const RECHECK_MS = 86_400_000;
/** 2025-10-24T10:00:00.123Z: the milliseconds travel as the fraction of a DateTime64(3). */
const FETCHED_AT = 1_761_300_000.123;

const address = (n: number): string => {
  const id = Buffer.alloc(20);
  id.writeUInt32BE(n, 16);
  return encodeAccountID(id);
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
network = 21337
symbol = "NPK"
display_decimals = 4
attested = true

[[VALIDATORS]]
public_key = "nHBNorthPeakValidator"
network = "Xahau"
unl = true

[[PRINCIPALS]]
name = "Ada North"
`;

describe('the toml store (e2e)', () => {
  let container: StartedClickHouse;
  let ch: ClickHouseService;
  let dbCounter = 0;

  beforeAll(async () => {
    container = await startClickHouse();
  });

  afterAll(async () => {
    await container?.container.stop();
  });

  /** A migrated database of its own, with the merges of `domain_tomls` stopped: the rows a reader must choose between stay. */
  beforeEach(async () => {
    const database = `toml_store_${++dbCounter}`;
    const config = { ...container.config, database };
    await runMigrations({ config, log: () => undefined });
    ch = new ClickHouseService(config);
    await ch.command(`SYSTEM STOP MERGES ${database}.${Table.DomainTomls}`);
  });

  afterEach(async () => {
    await ch?.close();
  });

  const count = async (): Promise<number> =>
    Number((await ch.queryOne<{ n: string }>(`SELECT count() AS n FROM ${Table.DomainTomls}`))?.n);

  const record = (domain: string, text = TEXT, fetchedAt = FETCHED_AT) =>
    recordToml(ch, {
      domain,
      tomlUrl: tomlUrlOf(domain.toLowerCase(), XAHAU),
      text,
      fetchedAt,
      recheckMs: RECHECK_MS,
      profile: XAHAU,
    });

  /** A failed row of `domain` checked at `checkedAt`, as the worker would write it after a definite failure. */
  const failedRow = (domain: string, checkedAt: number): DomainTomlsRow => ({
    domain,
    toml_url: tomlUrlOf(domain, XAHAU),
    status: 'failed',
    reason: 'http_status',
    status_code: 404,
    checked_at: checkedAt,
    fetched_at: null,
    next_check_at: Math.ceil(checkedAt + 86_400),
    failures: 1,
    ...EMPTY_TOML_CONTENT,
  });

  it('gives back the row recordToml wrote, equal, with the domain stored in lower case', async () => {
    const written = await record('NorthPeak.Example');

    expect(written.domain).toBe('northpeak.example');
    // the entry's other keys travel as JSON text, a bare integer network as its decimal text
    expect(written.currencies).toHaveLength(1);
    expect(written.currencies[0]).toMatchObject({ code: 'NPK', issuer: address(2), network: '21337' });
    expect(JSON.parse(written.currencies[0].fields)).toEqual({ symbol: 'NPK', display_decimals: 4, attested: true });
    expect(await count()).toBe(1);

    const stored = await readStoredTomls(ch, ['northpeak.example']);
    expect([...stored.keys()]).toEqual(['northpeak.example']);
    expect(stored.get('northpeak.example')).toEqual(written);
    // the milliseconds survive the DateTime64 and the next check is a whole second
    expect(stored.get('northpeak.example')).toMatchObject({
      checked_at: FETCHED_AT,
      fetched_at: FETCHED_AT,
      next_check_at: Math.ceil(FETCHED_AT + 86_400),
      modified: Date.parse('2025-10-01T00:00:00Z') / 1000,
      expires: Date.parse('2026-12-31T00:00:00Z') / 1000,
    });
  });

  it('gives back a row with no dates, no fetch and no content, equal', async () => {
    const failed = failedRow('empty.example', 1_761_300_000.5);
    await ch.insert(Table.DomainTomls, [failed]);
    expect((await readStoredTomls(ch, ['empty.example'])).get('empty.example')).toEqual(failed);
  });

  it('rejects a text that is not TOML with TomlInvalidError and writes nothing', async () => {
    await expect(record('northpeak.example', 'this = is = not toml\n[[')).rejects.toBeInstanceOf(TomlInvalidError);
    expect(await count()).toBe(0);
    expect((await readStoredTomls(ch, ['northpeak.example'])).size).toBe(0);
  });

  it('gives the newer of two rows of a domain, whichever was written last', async () => {
    const older = okTomlRow({
      domain: 'northpeak.example',
      tomlUrl: tomlUrlOf('northpeak.example', XAHAU),
      content: EMPTY_TOML_CONTENT,
      now: 1_761_300_000.001,
      recheckMs: RECHECK_MS,
    });
    const newer = failedRow('northpeak.example', 1_761_300_000.002);
    // the newer row first: the choice is by checked_at, not by the order of the inserts
    await ch.insert(Table.DomainTomls, [newer]);
    await ch.insert(Table.DomainTomls, [older]);
    expect(await count()).toBe(2);

    expect((await readStoredTomls(ch, ['northpeak.example'])).get('northpeak.example')).toEqual(newer);
  });

  it('gives the newest row of each of several domains, and leaves out a domain without rows', async () => {
    await ch.insert(Table.DomainTomls, [
      failedRow('a.example', 1_761_300_000.5),
      failedRow('a.example', 1_761_300_100.5),
      failedRow('b.example', 1_761_300_050.25),
      failedRow('c.example', 1_761_300_000.5),
    ]);

    const found = await readStoredTomls(ch, ['a.example', 'b.example', 'never.example']);
    expect([...found.keys()].sort()).toEqual(['a.example', 'b.example']);
    expect(found.get('a.example')?.checked_at).toBe(1_761_300_100.5);
    expect(found.get('b.example')?.checked_at).toBe(1_761_300_050.25);
    expect(found.has('never.example')).toBe(false);
  });

  it('binds the domains: a quote in one reads nothing and breaks nothing', async () => {
    await ch.insert(Table.DomainTomls, [failedRow('a.example', 1_761_300_000.5)]);
    const found = await readStoredTomls(ch, ["a.example' OR 1 = 1 --", 'a.example']);
    expect([...found.keys()]).toEqual(['a.example']);
  });

  it('makes no query for no domains', async () => {
    const query = jest.spyOn(ch, 'query');
    expect(await readStoredTomls(ch, [])).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });
});
