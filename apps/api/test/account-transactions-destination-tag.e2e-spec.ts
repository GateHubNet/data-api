import {
  buildLedgerRows,
  DESTINATION_TAG_PARSER_VERSION,
  getNetworkProfile,
  parseContextFor,
  Table,
} from '@gatehub/data-api-shared';
import type { AccountTransactionsController } from '../src/accounts/account-transactions.controller';
import { DESTINATION_TAG_BODY_KEYS } from '../src/accounts/account-transactions.controller';
import { COVERAGE_KEYS } from '../src/common/feature-coverage.service';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { csvDisposition } from './support/csv';
import { fixtureSource, fixtureTransactions, SeedName } from './support/fixtures';
import { isPageRead } from './support/plans';
import { ledgerRow } from './support/validators-seed';

/**
 * `GET /v2/accounts/:address/transactions?destination_tag=T` (spec §6 of the destination-tag design) on a real ClickHouse: the
 * transactions whose own `Destination` is the account and whose own `DestinationTag` is T, paged through
 * `account_tx_by_destination_tag` and served as the list without the tag serves them, with `coverage` after `result`.
 *
 * The world is the 54 mock ledgers (`ripple-mock`). `ACCOUNT` received 21 transactions, every one a payment with a tag; 9 of them
 * carry `TAG` (`TAGGED`, oldest first). Ledgers 11616411 and 11616412 both closed at 2015-02-09T18:15:20Z, 11616413 at 18:15:30.
 * `SENT_WITH_TAG` sent 11616411:0 with `TAG` and received nothing with a tag. The other suites are the coverage, failed and Batch
 * inner transactions on recorded XRPL ledgers (`xrpl-account-state`), a `Remit` on Xahau (`xahau-uritoken`) and a database
 * without migration 018.
 */

const ACCOUNT = 'rBeToNo4AwHaNbRX2n4BNCYKtpTyFLQwkj';
const TAG = 225881;
const TAGGED = [
  '11616401:0',
  '11616411:0',
  '11616411:1',
  '11616412:0',
  '11616412:1',
  '11616412:2',
  '11616413:2',
  '11616413:3',
  '11616413:5',
];
const SENT_WITH_TAG = 'r42nKAR9UfZJu6gLLtrVyPvTMLZfpCDdhR';
/** The lowest ledger of the mock ledgers: where the stored history, all of parser version 11, starts. */
const LOWEST = Math.min(
  ...fixtureSource('ripple-mock')
    .list()
    .map((ledger) => ledger.header.ledger_index),
);

const CACHE_ROUTE = async () => (await import('./cache-controllers')).CACHE_CONTROLLERS;

interface Item {
  hash: string;
  ledger_index: number;
  date: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta: any;
}
interface ListBody {
  result: string;
  coverage?: { from_ledger_index?: number; complete: boolean };
  count: number;
  marker?: string;
  transactions: Item[];
}
type Statement = [string, Record<string, unknown>];

/** `ledger_index:tx_index` of every transaction of a fixture set, by hash: an item of a list carries no `tx_index`. */
function keysByHash(seed: SeedName): Map<string, string> {
  return new Map(fixtureTransactions(seed).map((t) => [t.tx.hash, `${t.row.ledger_index}:${t.row.tx_index}`]));
}
const KEY_OF = keysByHash('ripple-mock');
const HASH_OF = new Map([...KEY_OF].map(([hash, key]) => [key, hash]));
const keysIn = (body: ListBody, keys = KEY_OF): (string | undefined)[] =>
  body.transactions.map((t) => keys.get(t.hash));

const listPath = (account: string): string => `/v2/accounts/${account}/transactions`;
const tagged = (tag: string | number, account = ACCOUNT): string => `${listPath(account)}?destination_tag=${tag}`;
/** The values of a marker: the base64url of a JSON array. */
const valuesOf = (marker: string | undefined): unknown =>
  marker === undefined ? undefined : JSON.parse(Buffer.from(marker, 'base64url').toString('utf8'));
const markerOf = (values: unknown[]): string => Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
const keyValues = (key: string): number[] => key.split(':').map(Number);
const statementsOf = (spy: jest.SpyInstance): Statement[] =>
  spy.mock.calls.map(([sql, params]) => [String(sql), (params ?? {}) as Record<string, unknown>]);

describe('account transactions by destination tag', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  let controller: () => AccountTransactionsController;

  beforeAll(async () => {
    let controllerClass: typeof AccountTransactionsController | undefined;
    h = await startHarness({
      seed: 'ripple-mock',
      env: NO_RATE_LIMIT,
      controllers: async () => {
        // the class of the app's own module registry, for `h.app.get`
        ({ AccountTransactionsController: controllerClass } =
          await import('../src/accounts/account-transactions.controller'));
        return CACHE_ROUTE();
      },
    });
    api = await h.api();
    get = api.get;
    controller = () => h.app.get(controllerClass as typeof AccountTransactionsController);
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the seed is as assumed: the account received 21 transactions with a tag, 9 of them with the tag', () => {
    const ctx = parseContextFor(getNetworkProfile('xrpl'));
    const rows = fixtureSource('ripple-mock')
      .list()
      .flatMap((ledger) => buildLedgerRows(ledger, ctx).accountTxByDestinationTag);
    const ofAccount = rows.filter((row) => row.account === ACCOUNT);
    expect(ofAccount).toHaveLength(21);
    expect(ofAccount.every((row) => row.tx_type === 'Payment' && row.result === 'tesSUCCESS')).toBe(true);
    expect(
      ofAccount.filter((row) => row.destination_tag === TAG).map((r) => `${r.ledger_index}:${r.tx_index}`),
    ).toEqual(TAGGED);
    expect(rows.filter((row) => row.account === SENT_WITH_TAG)).toEqual([]);
    expect(LOWEST).toBe(1021029);
  });

  it('lists the 9 transactions sent to the account under the tag, oldest first, each the object of the list without the tag', async () => {
    const all = await api.ok<ListBody>(`${listPath(ACCOUNT)}?limit=1000`, 'transactions');
    expect(all.body.count).toBe(21);
    const untagged = new Map(all.body.transactions.map((item: Item) => [item.hash, item]));

    const { body } = await api.ok<ListBody>(tagged(TAG), 'transactions');
    expect(keysIn(body)).toEqual(TAGGED);
    expect(body.count).toBe(9);
    for (const item of body.transactions) expect(item).toEqual(untagged.get(item.hash));
    expect(Object.keys(body)).toEqual(DESTINATION_TAG_BODY_KEYS.filter((key) => key !== 'marker'));
    expect(body.coverage).toEqual({ from_ledger_index: LOWEST, complete: false });
    expect(Object.keys(body.coverage as object)).toEqual([...COVERAGE_KEYS]);
  });

  it("pages in both directions, and takes only a marker of the time list's form", async () => {
    for (const descending of [false, true]) {
      const path = `${tagged(TAG)}${descending ? '&descending=true' : ''}`;
      const expected = descending ? [...TAGGED].reverse() : TAGGED;
      expect([descending, keysIn((await api.ok<ListBody>(path, 'transactions')).body)]).toEqual([descending, expected]);

      const walked: ListBody[] = [];
      let marker: string | undefined;
      do {
        const res = await api.ok<ListBody>(`${path}&limit=2${marker ? `&marker=${marker}` : ''}`, 'transactions');
        const page = res.body;
        marker = page.marker;
        walked.push(page);
        if (marker !== undefined) {
          // the marker of a page is the key of its last row, and the Link header carries it
          expect(valuesOf(marker)).toEqual(keyValues(keysIn(page)[page.count - 1] as string));
          expect(Object.keys(page)).toEqual([...DESTINATION_TAG_BODY_KEYS]);
          const origin = new URL(res.request.url).origin;
          expect(res.headers.link).toBe(`<${origin}${path}&limit=2&marker=${marker}>; rel="next"`);
        } else {
          expect(res.headers.link).toBeUndefined();
        }
      } while (marker !== undefined && walked.length < 10);
      expect([descending, walked.map((page) => page.count)]).toEqual([descending, [2, 2, 2, 2, 1]]);
      expect([descending, walked.flatMap((page) => keysIn(page))]).toEqual([descending, expected]);
    }

    // a marker is the time list's (ledger_index, tx_index): one of the list without the tag continues strictly after its key
    const untaggedPage = await api.ok<ListBody>(`${listPath(ACCOUNT)}?limit=8`, 'transactions');
    expect(valuesOf(untaggedPage.body.marker)).toEqual([11616401, 0]);
    const after = await api.ok<ListBody>(`${tagged(TAG)}&marker=${untaggedPage.body.marker}`, 'transactions');
    expect(keysIn(after.body)).toEqual(TAGGED.slice(1));
    const before = await api.ok<ListBody>(
      `${tagged(TAG)}&descending=true&marker=${untaggedPage.body.marker}`,
      'transactions',
    );
    expect(before.body.count).toBe(0);
    // and the other way round
    const taggedPage = await api.ok<ListBody>(`${tagged(TAG)}&limit=3`, 'transactions');
    expect(valuesOf(taggedPage.body.marker)).toEqual([11616411, 1]);
    const rest = await api.ok<ListBody>(
      `${listPath(ACCOUNT)}?limit=1000&marker=${taggedPage.body.marker}`,
      'transactions',
    );
    expect(keysIn(rest.body)).toEqual([
      '11616412:0',
      '11616412:1',
      '11616412:2',
      '11616413:2',
      '11616413:3',
      '11616413:5',
      '11618225:1',
      '11618225:2',
      '11618225:3',
    ]);

    // a marker of the sequence list (sequence, ledger_index, tx_index) is none of the tagged list's, nor is the tagged one the
    // sequence list's
    const sequenceMarker = markerOf([12203, 11616411, 0]);
    const sequenceList = await api.ok<ListBody>(
      `${listPath(SENT_WITH_TAG)}?min_sequence=0&marker=${sequenceMarker}`,
      'transactions',
    );
    expect(sequenceList.body.count).toBe(0);
    for (const path of [
      `${tagged(TAG)}&marker=${sequenceMarker}`,
      `${listPath(ACCOUNT)}?min_sequence=0&marker=${taggedPage.body.marker}`,
    ]) {
      const res = await get(path);
      expect([path, res.status, res.body]).toEqual([path, 400, { result: 'error', message: 'invalid marker' }]);
    }
  });

  it('filters by start and end, type and result', async () => {
    const cases: [string, string[]][] = [
      ['start=2015-02-09T18:15:20&end=2015-02-09T18:15:20', TAGGED.slice(1, 6)],
      ['start=2015-02-09T18:15:21', TAGGED.slice(6)],
      ['type=Payment', TAGGED],
      ['type=OfferCreate', []],
      ['result=tesSUCCESS', TAGGED],
      ['result=tecPATH_DRY', []],
      ['start=2030-01-01', []],
    ];
    for (const [query, expected] of cases) {
      const { body } = await api.ok<ListBody>(`${tagged(TAG)}&${query}`, 'transactions');
      expect([query, keysIn(body), body.count]).toEqual([query, expected, expected.length]);
      expect([query, body.coverage]).toEqual([query, { from_ledger_index: LOWEST, complete: false }]);
    }
  });

  it('serves binary=true and format=csv as the list without the tag serves those rows', async () => {
    const untaggedBinary = await api.ok<ListBody>(`${listPath(ACCOUNT)}?binary=true&limit=1000`, 'transactions');
    const binaryOf = new Map(untaggedBinary.body.transactions.map((item: Item) => [item.hash, item]));
    const binary = await api.ok<ListBody>(`${tagged(TAG)}&binary=true`, 'transactions');
    expect(keysIn(binary.body)).toEqual(TAGGED);
    for (const item of binary.body.transactions) {
      expect(item).toEqual(binaryOf.get(item.hash));
      expect(item.tx).toMatch(/^[0-9A-F]+$/);
    }

    const untaggedCsv = await get(`${listPath(ACCOUNT)}?format=csv&limit=1000`);
    const [untaggedHeader, ...untaggedLines] = untaggedCsv.text.split('\n');
    const lineOf = new Map(untaggedLines.map((line: string) => [JSON.parse(line.split(',')[0]) as string, line]));
    const csv = await get(`${tagged(TAG)}&format=csv`);
    expect([csv.status, csv.headers['content-type']]).toEqual([200, expect.stringMatching(/^text\/csv/)]);
    expect(csv.headers['content-disposition']).toBe(csvDisposition(`${ACCOUNT} - transactions`));
    const [header, ...lines] = csv.text.split('\n');
    expect(header).toBe(untaggedHeader);
    expect(lines).toEqual(TAGGED.map((key) => lineOf.get(HASH_OF.get(key) as string)));
    expect(csv.text).not.toContain('coverage');
  });

  it('tag 0 is a tag: nothing to list for this account; and an account that sent with the tag received none', async () => {
    const zero = await api.ok<ListBody>(tagged(0), 'transactions');
    expect(zero.body).toEqual({
      result: 'success',
      coverage: { from_ledger_index: LOWEST, complete: false },
      count: 0,
      transactions: [],
    });
    const sender = await api.ok<ListBody>(tagged(TAG, SENT_WITH_TAG), 'transactions');
    expect([sender.body.count, sender.body.coverage]).toEqual([0, { from_ledger_index: LOWEST, complete: false }]);
    const history = await api.ok<ListBody>(listPath(SENT_WITH_TAG), 'transactions');
    expect(keysIn(history.body)).toEqual(['11616411:0']);
  });

  it('refuses every destination_tag that is not 0 to 4294967295 in digits, before any read', async () => {
    const values = ['+1', '-1', '1.0', '1e3', '0x10', ' 1', '1 ', '', 'abc', '4294967296', '99999999999999999999'];
    const paths = [
      ...values.map((value) => tagged(encodeURIComponent(value))),
      // as a URL writes them: a raw `+` is a space, and a parameter without `=` is empty
      tagged('+1'),
      `${listPath(ACCOUNT)}?destination_tag`,
      `${listPath(ACCOUNT)}?destination_tag=x&destination_tag=1`,
      // brackets make the parameter an object (`{ a: '5' }`, `[{ a: '5' }]`): present, so never the list without the tag, in
      // JSON or in CSV
      ...['destination_tag[a]=5', 'destination_tag[0][a]=5'].flatMap((param) => [
        `${listPath(ACCOUNT)}?${param}`,
        `${listPath(ACCOUNT)}?${param}&format=csv`,
      ]),
    ];
    const query = jest.spyOn(h.ch, 'query');
    for (const path of paths) {
      const res = await get(path);
      expect([path, res.status, res.body]).toEqual([
        path,
        400,
        { result: 'error', message: 'invalid destination_tag' },
      ]);
    }
    expect(query).not.toHaveBeenCalled();
    jest.restoreAllMocks();

    // leading zeros are digits: 007 is tag 7, and the tag of the account with zeros in front lists its 9
    const spied = jest.spyOn(h.ch, 'query');
    const sevens = await api.ok<ListBody>(tagged('007'), 'transactions');
    const read = statementsOf(spied).find(([sql]) => isPageRead(sql));
    expect(read?.[1]).toMatchObject({ destination_tag: 7 });
    jest.restoreAllMocks();
    expect(sevens.body).toEqual((await api.ok<ListBody>(tagged(7), 'transactions')).body);
    expect(keysIn((await api.ok<ListBody>(tagged(`00${TAG}`), 'transactions')).body)).toEqual(TAGGED);
    // a repeated parameter takes its first value, as every parameter of the route does
    expect(keysIn((await api.ok<ListBody>(`${tagged(TAG)}&destination_tag=x`, 'transactions')).body)).toEqual(TAGGED);
    // the highest tag is a tag, with nothing to list
    const highest = await api.ok<ListBody>(tagged(4294967295), 'transactions');
    expect([highest.status, highest.body.count]).toEqual([200, 0]);
  });

  it('refuses destination_tag with min_sequence or max_sequence, in the order of the checks', async () => {
    const combined = 'destination_tag cannot be combined with min_sequence or max_sequence';
    const cases: [string, string][] = [
      ['destination_tag=1&min_sequence=1', combined],
      ['destination_tag=1&max_sequence=1', combined],
      ['destination_tag=x&min_sequence=y', 'invalid min_sequence'],
      ['destination_tag=x&max_sequence=y', 'invalid max_sequence'],
      ['destination_tag=x&min_sequence=1', 'invalid destination_tag'],
      ['destination_tag=x&start=bad', 'invalid destination_tag'],
      ['destination_tag=1&start=bad', 'invalid start date format'],
      ['destination_tag=1&end=bad', 'invalid end date format'],
      ['destination_tag=1&type=Nope', 'invalid transaction type'],
      ['destination_tag=1&result=Nope', 'invalid transaction result'],
      ['destination_tag=1&marker=%25%25', 'invalid marker'],
    ];
    const query = jest.spyOn(h.ch, 'query');
    for (const [params, message] of cases) {
      const res = await get(`${listPath(ACCOUNT)}?${params}`);
      expect([params, res.status, res.body]).toEqual([params, 400, { result: 'error', message }]);
    }
    expect(query).not.toHaveBeenCalled();
    jest.restoreAllMocks();

    // an empty sequence is none: the list is the tagged one
    const empty = await api.ok<ListBody>(`${tagged(TAG)}&min_sequence=&max_sequence=`, 'transactions');
    expect([empty.status, keysIn(empty.body)]).toEqual([200, TAGGED]);
  });

  it('reads one page of account_tx_by_destination_tag and the transactions by key', async () => {
    // the window holds the same 5 keys with and without the tag, so the reads of `transactions` can be compared
    const window = 'start=2015-02-09T18:15:20&end=2015-02-09T18:15:20';
    const timeSpy = jest.spyOn(h.ch, 'query');
    const time = await api.ok<ListBody>(`${listPath(ACCOUNT)}?${window}`, 'transactions');
    const timeReads = statementsOf(timeSpy).filter(([sql]) => new RegExp(`FROM ${Table.Transactions}\\b`).test(sql));
    jest.restoreAllMocks();

    const spy = jest.spyOn(h.ch, 'query');
    const { body } = await api.ok<ListBody>(`${tagged(TAG)}&${window}`, 'transactions');
    const statements = statementsOf(spy);
    expect(keysIn(body)).toEqual(TAGGED.slice(1, 6));
    expect(keysIn(body)).toEqual(keysIn(time.body));

    const pages = statements.filter(([sql]) => isPageRead(sql));
    expect(pages).toHaveLength(1);
    const [[sql, params]] = pages;
    expect(sql).toMatch(new RegExp(`FROM ${Table.AccountTxByDestinationTag}\\b`));
    expect(sql).toMatch(/account = \{account:String\}/);
    expect(sql).toMatch(/destination_tag = \{destination_tag:UInt32\}/);
    expect(sql).toMatch(/ledger_index BETWEEN \{min:UInt32\} AND \{max:UInt32\}/);
    // the whole key of the table, read with a plain LIMIT, and each row once outside it
    expect(sql).toMatch(
      /ORDER BY account ASC, destination_tag ASC, ledger_index ASC, tx_index ASC\s+LIMIT \{distinct_page_cap:UInt32\}/,
    );
    expect(sql).toMatch(/LIMIT 1 BY ledger_index, tx_index\s+LIMIT \{distinct_page_limit:UInt32\}/);
    expect(params).toMatchObject({ account: ACCOUNT, destination_tag: TAG, distinct_page_limit: 21 });
    expect(sql).not.toContain(ACCOUNT);
    expect(sql).not.toContain(String(TAG));
    expect(sql).not.toMatch(/FINAL/);
    // not the account's own history
    expect(statements.some(([q]) => new RegExp(`\\b${Table.AccountTransactions}\\b`).test(q))).toBe(false);

    // then the transactions of the page, by key, as the time list reads them
    const reads = statements.filter(([q]) => new RegExp(`FROM ${Table.Transactions}\\b`).test(q));
    expect(reads).toHaveLength(1);
    expect(reads).toEqual(timeReads);
    expect(statements.indexOf(pages[0])).toBeLessThan(statements.indexOf(reads[0]));
  });

  it('without the tag reads and answers as before', async () => {
    // a coverage read kept from a tagged request would hide one
    await api.ok('/v2/test-cache/clear', 'result');
    const cases: [string, boolean][] = [
      [`${listPath(ACCOUNT)}?limit=5`, false],
      [`${listPath(ACCOUNT)}?limit=1000`, false],
      [`${listPath(SENT_WITH_TAG)}?min_sequence=0`, false],
      [`${listPath(ACCOUNT)}?min_sequence=0&limit=1`, false],
      [`${listPath(ACCOUNT)}?format=csv&limit=5`, true],
    ];
    for (const [path, csv] of cases) {
      const spy = jest.spyOn(h.ch, 'query');
      const res = await get(path);
      const statements = statementsOf(spy);
      jest.restoreAllMocks();
      expect([path, res.status]).toEqual([path, 200]);
      expect(statements.length).toBeGreaterThan(0);
      for (const [sql] of statements) {
        expect([path, sql]).toEqual([path, expect.not.stringContaining(Table.AccountTxByDestinationTag)]);
        expect([path, sql]).toEqual([path, expect.not.stringContaining('parser_version')]);
      }
      if (csv) {
        expect(res.text).not.toContain('coverage');
      } else {
        const keys = Object.keys(res.body);
        expect([path, keys]).toEqual([
          path,
          ['result', 'count', 'marker', 'transactions'].filter((key) => key !== 'marker' || keys.includes('marker')),
        ]);
      }
    }
  });

  it('serves a row written twice once', async () => {
    // the table is a ReplacingMergeTree and no list uses FINAL: until a merge a ledger written twice has its rows twice
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.AccountTxByDestinationTag}`);
    const ofTag = `FROM ${Table.AccountTxByDestinationTag} WHERE account = {account:String} AND destination_tag = {tag:UInt32}`;
    await h.ch.command(
      `INSERT INTO ${Table.AccountTxByDestinationTag} SELECT * ${ofTag}`,
      { account: ACCOUNT, tag: TAG },
      { settings: { insert_deduplicate: 0 } },
    );
    const [{ n }] = await h.ch.query<{ n: string }>(`SELECT count() AS n ${ofTag}`, { account: ACCOUNT, tag: TAG });
    expect(Number(n)).toBe(18);

    for (const descending of [false, true]) {
      const path = `${tagged(TAG)}${descending ? '&descending=true' : ''}`;
      const expected = descending ? [...TAGGED].reverse() : TAGGED;
      const { body } = await api.ok<ListBody>(path, 'transactions');
      expect([descending, keysIn(body), body.count]).toEqual([descending, expected, 9]);
      for (const limit of [1, 2]) {
        const walked = await api.pages<ListBody>(path, limit, 'transactions');
        expect([descending, limit, walked.flatMap((page) => keysIn(page))]).toEqual([descending, limit, expected]);
      }
    }
  });

  it('counts an export of a tagged list as the list serves it', async () => {
    const c = controller();
    expect(await c.exportRows(ACCOUNT, { destination_tag: String(TAG) })).toBe(9);
    expect(await c.exportRows(ACCOUNT, {})).toBe(21);
    // with the window, type and result of the list
    expect(
      await c.exportRows(ACCOUNT, {
        destination_tag: String(TAG),
        start: '2015-02-09T18:15:20',
        end: '2015-02-09T18:15:20',
      }),
    ).toBe(5);
    expect(await c.exportRows(ACCOUNT, { destination_tag: String(TAG), type: 'OfferCreate' })).toBe(0);
    expect(await c.exportRows(ACCOUNT, { destination_tag: '0' })).toBe(0);
    const refused = await c.exportRows(ACCOUNT, { destination_tag: 'x' }).then(
      () => undefined,
      (err: { getStatus(): number; getResponse(): unknown }) => [err.getStatus(), err.getResponse()],
    );
    expect(refused).toEqual([400, { result: 'error', message: 'invalid destination_tag' }]);
  });
});

describe('account transactions by destination tag: coverage', () => {
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('says complete once the first ledger of the network is of parser version 11, and not once a ledger above it is older', async () => {
    const coverageOf = async (): Promise<unknown> => {
      await api.ok('/v2/test-cache/clear', 'result');
      return (await api.ok<ListBody>(tagged(TAG), 'coverage')).body.coverage;
    };
    // the stored history starts at the lowest mock ledger, above the first ledger of the XRP Ledger (32,570)
    expect(await coverageOf()).toEqual({ from_ledger_index: LOWEST, complete: false });
    await h.ch.insert(Table.Ledgers, [
      { ...ledgerRow(32_570, 1_390_000_000), parser_version: DESTINATION_TAG_PARSER_VERSION },
    ]);
    expect(await coverageOf()).toEqual({ from_ledger_index: 32_570, complete: true });
    // a ledger of the parser before it moves the start above that ledger
    await h.ch.insert(Table.Ledgers, [
      { ...ledgerRow(90_000_000, 1_750_000_000), parser_version: DESTINATION_TAG_PARSER_VERSION - 1 },
    ]);
    expect(await coverageOf()).toEqual({ from_ledger_index: 90_000_001, complete: false });
  });
});

describe('account transactions by destination tag on recorded XRPL ledgers', () => {
  const KEYS = keysByHash('xrpl-account-state');
  /** It received payments with tag 104 in ledger 93663334, four of them tecPATH_DRY. */
  const RECIPIENT = 'rBUZp2fS6WCjURm5WVJGzevmXafJ23pk19';
  /** It received a Batch inner payment (Flags 0x40030000) with tag 0. */
  const BATCH_RECIPIENT = 'r9ruWAaX3E4EDrMWgs7A7QbcvooMnHkaUd';
  /** `tfInnerBatchTxn`. */
  const INNER_BATCH = 0x40000000;
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: 'xrpl-account-state', env: NO_RATE_LIMIT });
    api = await h.api();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists failed transactions and Batch inner transactions', async () => {
    const list = async (path: string): Promise<ListBody> => (await api.ok<ListBody>(path, 'transactions')).body;
    const failed = ['93663334:113', '93663334:114', '93663334:115', '93663334:116'];
    expect(keysIn(await list(tagged(104, RECIPIENT)), KEYS)).toEqual(['93663334:18', ...failed, '93663334:117']);
    expect(keysIn(await list(`${tagged(104, RECIPIENT)}&result=tecPATH_DRY`), KEYS)).toEqual(failed);
    expect(keysIn(await list(`${tagged(104, RECIPIENT)}&result=tesSUCCESS`), KEYS)).toEqual([
      '93663334:18',
      '93663334:117',
    ]);

    const batch = await list(tagged(0, BATCH_RECIPIENT));
    expect(keysIn(batch, KEYS)).toContain('107872956:240');
    const inner = batch.transactions.find((item) => KEYS.get(item.hash) === '107872956:240') as Item;
    expect((inner.tx.Flags & INNER_BATCH) !== 0).toBe(true);
    expect([inner.tx.Destination, inner.tx.DestinationTag]).toEqual([BATCH_RECIPIENT, 0]);
  });
});

describe('account transactions by destination tag on Xahau', () => {
  const KEYS = keysByHash('xahau-uritoken');
  /** It received a Remit with tag 0. */
  const REMITTED = 'r9gvUQxtV98nRAM26aknj4h6RXKyXCLMVS';
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: 'xahau-uritoken', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists a Remit with tag 0 on Xahau, filters it by type, and states its coverage', async () => {
    const { body } = await api.ok<ListBody>(tagged(0, REMITTED), 'transactions');
    expect(keysIn(body, KEYS)).toEqual(['26689211:0']);
    expect(body.transactions[0].tx.TransactionType).toBe('Remit');
    expect((await api.ok<ListBody>(`${tagged(0, REMITTED)}&type=Remit`, 'transactions')).body.count).toBe(1);
    expect((await api.ok<ListBody>(`${tagged(0, REMITTED)}&type=Payment`, 'transactions')).body.count).toBe(0);

    const lowest = Math.min(
      ...fixtureSource('xahau-uritoken')
        .list()
        .map((ledger) => ledger.header.ledger_index),
    );
    expect(body.coverage).toEqual({ from_ledger_index: lowest, complete: false });
    // the first ledger of Xahau is 1
    await h.ch.insert(Table.Ledgers, [
      { ...ledgerRow(1, 1_698_624_000), parser_version: DESTINATION_TAG_PARSER_VERSION },
    ]);
    await api.ok('/v2/test-cache/clear', 'result');
    const after = await api.ok<ListBody>(tagged(0, REMITTED), 'coverage');
    expect(after.body.coverage).toEqual({ from_ledger_index: 1, complete: true });
  });
});

describe('account transactions by destination tag on a database without migration 018', () => {
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    // the api deployed before the migration was applied (the rollout run out of order)
    await h.ch.command(`DROP TABLE ${Table.AccountTxByDestinationTag}`);
  });
  afterAll(async () => {
    await h?.close();
  });

  afterEach(() => jest.restoreAllMocks());

  it('answers without the tag on a database without 018, and 500 with it', async () => {
    // the ClickHouse client logs every failed statement to the console; these are the failures the test makes on purpose
    const log = console.error.bind(console);
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!args.some((arg) => /Unknown table expression identifier/.test(String(arg)))) log(...args);
    });
    const all = await api.ok<ListBody>(`${listPath(ACCOUNT)}?limit=1000`, 'transactions');
    expect(all.body.count).toBe(21);
    expect((await api.get(`${listPath(ACCOUNT)}?format=csv&limit=1000`)).status).toBe(200);
    expect((await api.ok<ListBody>(`${listPath(SENT_WITH_TAG)}?min_sequence=0`, 'transactions')).body.count).toBe(1);

    for (const path of [tagged(TAG), `${tagged(TAG)}&format=csv`]) {
      const res = await api.get(path);
      expect([path, res.status, res.body]).toEqual([
        path,
        500,
        { result: 'error', message: 'unable to retrieve transactions' },
      ]);
    }
  });
});
