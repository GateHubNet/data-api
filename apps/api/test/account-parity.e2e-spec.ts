import { computeRatesDailySet, RatesService, Table } from '@gatehub/data-api-shared';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';

/**
 * The answers of `stats/{family}` and `reports` for every account of the 54 ripple-mock ledgers, taken BEFORE D2 changed
 * anything (the commit that adds this file changes no route), as snapshots. D2 moves the rates of both routes from
 * `dailyNativeRates` to `DailyRates` and adds `interval`; without `interval` the answers must stay what they were, to the
 * byte. The snapshots are the oracle: they were written by the code of the commit before D2.
 *
 *  - `stats/transactions` and `stats/value`, with a window (`?start=2013-01-01&end=2018-01-01&limit=1000`) and with no
 *    parameter;
 *  - `reports/<day>?accounts=true&payments=true` for every UTC day that holds a mock ledger;
 *  - `reports?start=2015-01-01&end=2015-03-01&accounts=true`.
 *
 * Then `native_rates_daily` is filled with `computeRatesDailySet` for every one of those days, so that a route that values
 * through the table reads it instead of the trades; every answer must be equal to its first pass.
 */

const WINDOW = '?start=2013-01-01&end=2018-01-01&limit=1000';
const REPORTS_WINDOW = '?start=2015-01-01&end=2015-03-01&accounts=true';
/** Requests in flight at once: the walk is some thousands of them. */
const CONCURRENCY = 8;

describe('the answers of stats and reports before D2, as snapshots', () => {
  let h: Harness;
  let api: ApiClient;
  let days: string[];
  /** label -> request path, in the order of the walk. */
  const requests = new Map<string, string>();
  /** label -> the body of the first pass. */
  const first = new Map<string, unknown>();

  /** The bodies of the paths, `CONCURRENCY` at a time, in the order of the labels. */
  async function walk(paths: Map<string, string>): Promise<Map<string, unknown>> {
    const entries = [...paths.entries()];
    const out = new Map<string, unknown>();
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const chunk = await Promise.all(
        entries.slice(i, i + CONCURRENCY).map(async ([label, path]) => [label, (await api.ok(path)).body] as const),
      );
      for (const [label, body] of chunk) out.set(label, body);
    }
    return out;
  }

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();

    days = (
      await h.ch.query<{ day: string }>(
        `SELECT DISTINCT toString(toDate(close_time, 'UTC')) AS day FROM ${Table.Ledgers} ORDER BY day`,
      )
    ).map((r) => r.day);
    const accounts = (
      await h.ch.query<{ account: string }>(
        `SELECT DISTINCT account FROM (
           SELECT account FROM ${Table.AccountTransactions}
           UNION ALL SELECT account FROM ${Table.BalanceChanges}
           UNION ALL SELECT account FROM ${Table.AccountPayments}
           UNION ALL SELECT account FROM ${Table.AccountExchanges})
         ORDER BY account`,
      )
    ).map((r) => r.account);

    for (const account of accounts) {
      const base = `/v2/accounts/${account}`;
      for (const family of ['transactions', 'value']) {
        requests.set(`${account} stats/${family}${WINDOW}`, `${base}/stats/${family}${WINDOW}`);
        requests.set(`${account} stats/${family}`, `${base}/stats/${family}`);
      }
      for (const day of days) {
        requests.set(
          `${account} reports/${day}?accounts=true&payments=true`,
          `${base}/reports/${day}?accounts=true&payments=true`,
        );
      }
      requests.set(`${account} reports${REPORTS_WINDOW}`, `${base}/reports${REPORTS_WINDOW}`);
    }
  });
  afterAll(async () => {
    await h?.close();
  });

  it('the mock ledgers are seven UTC days of some hundreds of accounts', () => {
    expect(days).toHaveLength(7);
    expect([days[0], days[days.length - 1]]).toEqual(['2013-06-11', '2017-05-12']);
    expect(days).toEqual(expect.arrayContaining(['2015-01-14', '2015-02-09']));
    expect(requests.size).toBeGreaterThan(280 * (4 + days.length + 1));
  });

  it('first pass: every answer is its snapshot', async () => {
    for (const [label, body] of await walk(requests)) {
      first.set(label, body);
      expect(body).toMatchSnapshot(label);
    }
    expect(first.size).toBe(requests.size);
  });

  it('with native_rates_daily filled for the days of the ledgers, every answer equals its first pass', async () => {
    const rates = new RatesService(h.ch, 'XRP');
    for (const day of days) await computeRatesDailySet(h.ch, rates, new Date(`${day}T00:00:00Z`));
    const [{ n }] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.NativeRatesDaily} WHERE currency = '' AND issuer = ''`,
    );
    expect(Number(n)).toBe(days.length);

    for (const [label, body] of await walk(requests)) expect([label, body]).toEqual([label, first.get(label)]);
  });
});
