import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import {
  AnalyticsWorld,
  COUNTERPARTY,
  ISSUER,
  PaymentSpec,
  seedAccountPayments,
  seedAccountTrades,
  seedAnalyticsWorld,
  STRANGER,
  TradeSpec,
  TYPICAL,
} from './support/analytics-world';
import { MARKETS_ISSUER, MARKETS_NOW, seedLiveRate, seedMarketsWorld } from './support/markets-world';

/**
 * The JSON examples of the routes of sub-project D2 in `docs/api-reference.md` are what the API serves, key order included.
 *
 * Every example is preceded by a line `<!-- d2-example GET <path?query> -->` and followed by a fenced `json` block. This suite
 * seeds the two worlds the examples are made from, GETs each path, and expects `JSON.stringify` of the answer to equal that of
 * the block: the contract the explorer's fixtures are generated from cannot drift from the code. The examples pass an explicit
 * `end`, so that none of them depends on today (`network/markets` has no `end`: its set is the one written at `MARKETS_NOW`).
 *
 * The worlds:
 *  - the analytics world (`support/analytics-world.ts`: read its header), with the payments and the trades below written for
 *    the typical account, at times that world has a ledger for;
 *  - the markets world (`support/markets-world.ts`: read its header), whose sets are those of 2020-07-02T10:42:17Z, and the
 *    trades a display currency's live rate is made of.
 * They are in two databases: the ledgers of the two worlds do not share one time axis, and the markets world's trades would
 * change the rates of the analytics world's last days.
 */

const REFERENCE = join(__dirname, '..', '..', '..', 'docs', 'api-reference.md');

interface Example {
  /** The line of the marker in the reference, for the message of a block that is none. */
  line: number;
  /** `/v2/...?query`. */
  path: string;
  /** The text of the `json` block. */
  json: string;
}

/**
 * The examples of a Markdown text: each `<!-- d2-example GET <path> -->` line and the fenced `json` block after it (blank
 * lines may come between). A marker that is not followed by such a block is an error, so an example cannot lose its answer.
 */
function examplesOf(markdown: string): Example[] {
  const lines = markdown.split('\n');
  const found: Example[] = [];
  for (let i = 0; i < lines.length; i++) {
    const marker = /^<!-- d2-example GET (\S+) -->$/.exec(lines[i]);
    if (!marker) continue;
    let at = i + 1;
    while (at < lines.length && lines[at].trim() === '') at++;
    if (lines[at]?.trim() !== '```json') {
      throw new Error(`The d2-example marker at line ${i + 1} of the reference is not followed by a json block`);
    }
    const body: string[] = [];
    for (at++; at < lines.length && lines[at].trim() !== '```'; at++) body.push(lines[at]);
    if (at >= lines.length) throw new Error(`The json block of the d2-example at line ${i + 1} is never closed`);
    found.push({ line: i + 1, path: marker[1], json: body.join('\n') });
  }
  return found;
}

const EXAMPLES = examplesOf(readFileSync(REFERENCE, 'utf8'));

/** What the reference has to show: a path that matches, and for some the keys that its answer must have. */
const REQUIRED: { name: string; path: RegExp; json?: RegExp[] }[] = [
  { name: 'stats/transactions with a week interval', path: /\/stats\/transactions\?(?=.*\binterval=week\b)/ },
  { name: 'stats/value with a month interval', path: /\/stats\/value\?(?=.*\binterval=month\b)/ },
  { name: 'reports with a month interval', path: /\/reports\?(?=.*\binterval=month\b)/ },
  { name: 'analytics/balances with a month interval', path: /\/analytics\/balances\?(?=.*\binterval=month\b)/ },
  { name: 'analytics/balance_changes without an interval', path: /\/analytics\/balance_changes\?(?!.*\binterval=)/ },
  { name: 'analytics/balance_changes with an interval', path: /\/analytics\/balance_changes\?(?=.*\binterval=)/ },
  { name: 'analytics/counterparties with a limit of 6', path: /\/analytics\/counterparties\?(?=.*\blimit=6\b)/ },
  {
    name: 'analytics/exchanges, with the counter of both sides',
    path: /\/analytics\/exchanges\?/,
    json: [/"bought_counter"/, /"sold_counter"/],
  },
  { name: 'network/markets of the day', path: /\/network\/markets\?(?=.*\bperiod=day\b)/ },
];

// -- the analytics world: the payments and the trades of the typical account (A) -------------------------------------------
//
// B is the counterparty, S the stranger and I the issuer of the world; `USD` is the issuer's. At the rates of the world (2 USD
// per XRP on 2020-02-10 to 02-24, 4 on 04-20 to 05-04, none on 03-01) these are the values the routes serve.

const A = TYPICAL;
const B = COUNTERPARTY;
const S = STRANGER;
const I = ISSUER;
const USD = `USD+${I}`;
const EUR = `EUR+${I}`;

const PAYMENTS_A: PaymentSpec[] = [
  ['2020-01-16T09:00:00Z', 1, 'sent', B, '10', 'XRP'],
  ['2020-01-17T09:00:00Z', 1, 'sent', B, '5', 'XRP'],
  ['2020-01-17T09:00:00Z', 2, 'sent', S, '2', 'XRP'],
  ['2020-01-17T09:00:00Z', 3, 'received', I, '7', 'XRP'],
  ['2020-02-10T11:00:00Z', 1, 'received', B, '20', USD],
  ['2020-02-12T09:00:00Z', 1, 'received', B, '10', USD],
  ['2020-02-12T09:00:00Z', 2, 'sent', S, '4', 'XRP'],
  ['2020-02-14T09:00:00Z', 1, 'sent', S, '8', USD],
  ['2020-03-01T09:00:00Z', 1, 'received', S, '6', USD], // no rate that day: worth 0
  ['2020-04-20T12:00:00Z', 1, 'sent', S, '40', USD],
  ['2020-06-15T09:00:00Z', 1, 'received', B, '9', 'XRP'],
];

const TRADES_A: TradeSpec[] = [
  ['2020-02-10T12:30:00Z', 1, USD, 'XRP', '10', '5', A, B],
  ['2020-03-05T10:00:00Z', 1, USD, 'XRP', '4.5', '3', A, B],
  ['2020-03-10T10:00:00Z', 1, USD, 'XRP', '1', '0.25', A, A], // with itself: bought and sold
  ['2020-04-20T12:30:00Z', 1, USD, 'XRP', '20', '5', B, A],
  ['2020-02-12T09:00:00Z', 5, EUR, USD, '30', '60', A, B], // no native side: through the rate of USD
  ['2020-02-20T10:00:00Z', 1, EUR, USD, '5', '10', B, A],
  ['2020-03-01T09:00:00Z', 1, EUR, USD, '100', '7', A, B], // USD has no rate that day
  ['2020-04-20T12:00:00Z', 2, EUR, USD, '4', '8', B, A],
  ['2020-01-15T10:00:00Z', 1, 'XRP', `ZAR+${I}`, '5', '100', A, B], // a native base
];

describe('the examples of the D2 routes in docs/api-reference.md', () => {
  let analytics: Harness;
  let markets: Harness;
  let analyticsApi: ApiClient;
  let marketsApi: ApiClient;
  let world: AnalyticsWorld;

  beforeAll(async () => {
    analytics = await startHarness({ seed: 'none', env: NO_RATE_LIMIT });
    analyticsApi = await analytics.api();
    world = await seedAnalyticsWorld(analytics);
    await seedAccountPayments(analytics, world, A, PAYMENTS_A);
    await seedAccountTrades(analytics, world, A, TRADES_A);

    markets = await startHarness({ seed: 'none', env: NO_RATE_LIMIT });
    marketsApi = await markets.api();
    await seedMarketsWorld(markets, MARKETS_NOW);
    // one native coin is worth 2 USD of the issuer of the world, at the live rate (the example of a display currency)
    await seedLiveRate(markets, 'XRP', { currency: 'USD', issuer: MARKETS_ISSUER }, { native: '1', display: '2' });
  });
  afterAll(async () => {
    await analytics?.close();
    await markets?.close();
  });

  it('has the examples the contract promises', () => {
    const missing = REQUIRED.filter(
      (r) => !EXAMPLES.some((e) => r.path.test(e.path) && (r.json ?? []).every((key) => key.test(e.json))),
    ).map((r) => r.name);
    expect(missing).toEqual([]);
  });

  it('passes an explicit end in every example that has one to pass, and none is a path of another host', () => {
    for (const e of EXAMPLES) {
      expect(e.path).toMatch(/^\/v2\//);
      if (!e.path.startsWith('/v2/network/markets')) expect(e.path).toMatch(/[?&]end=/);
    }
  });

  it('lists every example once', () => {
    expect(new Set(EXAMPLES.map((e) => e.path)).size).toBe(EXAMPLES.length);
  });

  // (no example: the test above is what fails, and `it.each` refuses an empty table)
  if (EXAMPLES.length > 0) {
    it.each(EXAMPLES.map((e) => [e.path, e] as const))(
      'GET %s answers its example, key order included',
      async (_, e) => {
        const api = e.path.startsWith('/v2/network/') ? marketsApi : analyticsApi;
        const res = await api.ok(e.path);
        const example = JSON.parse(e.json);
        // the readable difference first, then the exact one: the same values in the same key order
        expect(res.body).toEqual(example);
        expect(JSON.stringify(res.body)).toBe(JSON.stringify(example));
      },
    );
  }
});
