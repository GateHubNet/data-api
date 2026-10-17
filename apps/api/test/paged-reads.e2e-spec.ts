import { Table } from '@gatehub/data-api-shared';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { fixtureTransactions } from './support/fixtures';
import { expectBoundedInOrderRead, explain, innerRead } from './support/plans';
import {
  BULK_BASES,
  BULK_LEDGERS,
  BULK_PER_PART,
  BULK_ROWS,
  BULK_TX_INDEX,
  bulkLedger,
  insertBulk,
  LoggedRead,
  markerOf,
  readsOf,
} from './support/read-rows';

/**
 * What a page of every paged list reads (Ruling R106, final review C1): about the granules the page needs, never the
 * range. `ORDER BY <key> LIMIT 1 BY <key> LIMIT n` in one SELECT read and buffered most of a range that spans more than
 * one part (ClickHouse 26.8 does not push the limit through the LIMIT BY into the read), so a page of 5 over the bulk
 * below read most of its 800,000 rows; the lists now read the page with a plain inner LIMIT and dedupe outside it.
 *
 * Every table a list pages through gets a bulk of copies of one of its ripple-mock rows (see `support/read-rows.ts`:
 * four parts of 200,000 rows in four ledger ranges between the mock ledgers 20005122 and 29136413), and each list is
 * asked for a page of 5 that starts inside the bulk (a marker in the middle of the second part), ascending and
 * descending. `system.query_log` then says what every SELECT of the request on that table read.
 *
 * A page touches one or two parts and ClickHouse reads whole granules (8192 rows; 1024 for `transactions`), a few of
 * each part it opens: `PAGE_READ_BOUND` is far below the 200,000 rows of one part, and far below what the old reads
 * took (most of the 800,000).
 */
const PAGE_READ_BOUND = 40_000;

/** The middle of the second part of the bulk: a marker there makes the page start inside the bulk. */
const MID = BULK_BASES[1] + BULK_LEDGERS / 2;

/** The close time of a bulk ledger, as SQL: one second a ledger from `{t0}` on, so close times grow with the index. */
const closeTimeOf = (ledger: string): string => `toDateTime({t0:UInt32} + (${ledger} - ${BULK_BASES[0]}), 'UTC')`;

interface Pair {
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  node_index: number;
}

const side = (currency: string, issuer: string): string => (issuer ? `${currency}+${issuer}` : currency);

describe('a page reads the granules it needs, not the range (read_rows over a bulk of four parts)', () => {
  let h: Harness;
  let api: ApiClient;
  /** The close time of the first bulk ledger, unix seconds: a day after the mock ledger 20005122. */
  let t0: number;
  let pair: Pair;
  let pairPath: string;
  const accounts: Record<string, string> = {};

  /** The account with the most rows in a table of the mock ledgers. */
  async function busiest(table: Table): Promise<string> {
    const [row] = await h.ch.query<{ account: string }>(
      `SELECT account FROM ${table} GROUP BY account ORDER BY count() DESC, account LIMIT 1`,
    );
    return row.account;
  }

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    const times = await h.ch.query<{ ledger_index: number; t: number }>(
      `SELECT ledger_index, toUnixTimestamp(close_time) AS t FROM ${Table.Ledgers}
        WHERE ledger_index IN (20005122, 29136413) ORDER BY ledger_index`,
    );
    t0 = Number(times[0].t) + 86_400;
    // the bulk closes between the two mock ledgers around it
    expect(t0 + (BULK_BASES[3] + BULK_PER_PART - BULK_BASES[0])).toBeLessThan(Number(times[1].t));
    const timed = { t0 };

    // a ledger row for each index of the four ranges and more: the bulk lies in the ranges the dates resolve to, and
    // `ledgers` (the list of fees) has a bulk of its own
    await insertBulk(
      h,
      Table.Ledgers,
      `SELECT * FROM ${Table.Ledgers} WHERE ledger_index = 20005122 LIMIT 1`,
      timed,
      (base) => {
        const ledger = `toUInt32(${base} + n.number)`;
        return `${ledger} AS ledger_index, ${closeTimeOf(ledger)} AS close_time`;
      },
    );

    const keyed = (base: number, timedRow = true): string =>
      `${bulkLedger(base)} AS ledger_index, ${BULK_TX_INDEX} AS tx_index` +
      (timedRow ? `, ${closeTimeOf(bulkLedger(base))} AS close_time` : '');

    await insertBulk(
      h,
      Table.Transactions,
      `SELECT * FROM ${Table.Transactions} ORDER BY length(tx_json) + length(meta_json), ledger_index LIMIT 1`,
      timed,
      (base) => keyed(base),
    );
    await insertBulk(
      h,
      Table.TxByType,
      `SELECT * FROM ${Table.TxByType} WHERE tx_type = 'Payment' LIMIT 1`,
      {},
      (base) => keyed(base, false),
    );
    await insertBulk(
      h,
      Table.Payments,
      `SELECT * FROM ${Table.Payments} ORDER BY ledger_index, tx_index LIMIT 1`,
      timed,
      (base) => keyed(base),
    );
    const [currency] = await h.ch.query<{ currency: string; issuer: string }>(
      `SELECT currency, issuer FROM ${Table.PaymentsByCurrency} WHERE issuer != ''
        GROUP BY currency, issuer ORDER BY count() DESC, currency, issuer LIMIT 1`,
    );
    accounts.currency = side(currency.currency, currency.issuer);
    await insertBulk(
      h,
      Table.PaymentsByCurrency,
      `SELECT * FROM ${Table.PaymentsByCurrency} WHERE currency = {currency:String} AND issuer = {issuer:String} LIMIT 1`,
      currency,
      (base) => keyed(base, false),
    );

    [pair] = await h.ch.query<Pair>(
      `SELECT base_currency, base_issuer, counter_currency, counter_issuer, any(node_index) AS node_index
         FROM ${Table.Exchanges}
        GROUP BY base_currency, base_issuer, counter_currency, counter_issuer
        ORDER BY count() DESC, base_currency, counter_currency LIMIT 1`,
    );
    pairPath = `${side(pair.base_currency, pair.base_issuer)}/${side(pair.counter_currency, pair.counter_issuer)}`;
    await insertBulk(
      h,
      Table.Exchanges,
      `SELECT * FROM ${Table.Exchanges}
        WHERE base_currency = {base_currency:String} AND base_issuer = {base_issuer:String}
          AND counter_currency = {counter_currency:String} AND counter_issuer = {counter_issuer:String}
          AND node_index = {node_index:UInt16}
        ORDER BY ledger_index, tx_index LIMIT 1`,
      { ...pair, t0 },
      (base) => keyed(base),
    );

    await insertBulk(
      h,
      Table.AccountsCreated,
      `SELECT * FROM ${Table.AccountsCreated} ORDER BY ledger_index, tx_index, account LIMIT 1`,
      {},
      (base) => keyed(base, false),
    );

    accounts.transactions = await busiest(Table.AccountTransactions);
    await insertBulk(
      h,
      Table.AccountTransactions,
      `SELECT * FROM ${Table.AccountTransactions} WHERE account = {account:String} ORDER BY ledger_index, tx_index LIMIT 1`,
      { account: accounts.transactions, t0 },
      (base) => keyed(base),
    );
    accounts.sequence = await busiest(Table.AccountTxBySequence);
    await insertBulk(
      h,
      Table.AccountTxBySequence,
      `SELECT * FROM ${Table.AccountTxBySequence} WHERE account = {account:String} ORDER BY sequence LIMIT 1`,
      { account: accounts.sequence },
      // a sequence a ledger, above every sequence of the mock ledgers
      (base) => `${keyed(base, false)}, toUInt32(3000000000 + (${bulkLedger(base)} - ${BULK_BASES[0]})) AS sequence`,
    );
    accounts.payments = await busiest(Table.AccountPayments);
    await insertBulk(
      h,
      Table.AccountPayments,
      `SELECT * FROM ${Table.AccountPayments} WHERE account = {account:String} ORDER BY ledger_index, tx_index LIMIT 1`,
      { account: accounts.payments, t0 },
      (base) => keyed(base),
    );
    accounts.exchanges = await busiest(Table.AccountExchanges);
    await insertBulk(
      h,
      Table.AccountExchanges,
      `SELECT * FROM ${Table.AccountExchanges} WHERE account = {account:String} ORDER BY ledger_index, tx_index LIMIT 1`,
      { account: accounts.exchanges, t0 },
      (base) => keyed(base),
    );
    accounts.balances = await busiest(Table.BalanceChanges);
    await insertBulk(
      h,
      Table.BalanceChanges,
      `SELECT * FROM ${Table.BalanceChanges} WHERE account = {account:String} AND change_type != 'transaction_cost'
        ORDER BY ledger_index, tx_index LIMIT 1`,
      { account: accounts.balances, t0 },
      (base) => keyed(base),
    );

    // fee_stats: snapshots of the node, a second apart, a part in each of four months (the table is partitioned by month)
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.FeeStats}`);
    for (const month of [1, 2, 3, 4]) {
      await h.ch.command(
        `INSERT INTO ${Table.FeeStats} (ts, current_ledger_size, expected_ledger_size, current_queue_size,
                                        pct_max_queue_size, median_fee, minimum_fee, open_ledger_fee)
         SELECT toDateTime64({from:String}, 3, 'UTC') + toIntervalSecond(number), 10, 20, 0, 0, 5000, 10, 10
           FROM numbers(200000)`,
        { from: `2020-0${month}-01 00:00:00` },
      );
    }
  }, 600_000);

  afterAll(async () => {
    await h?.close();
  });

  /** Asserts that every SELECT on `table` while the request ran read at most `bound` rows, and that the request is 200. */
  async function expectBounded(
    table: Table,
    path: string,
    key: string,
    bound = PAGE_READ_BOUND,
  ): Promise<{ reads: LoggedRead[]; body: Record<string, unknown> }> {
    let body: Record<string, unknown> = {};
    const reads = await readsOf(h, table, async () => {
      body = (await api.ok(path, key)).body as Record<string, unknown>;
    });
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      // the path and the rows read when it fails, rather than a bare number
      expect([path, read.read_rows <= bound ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
    }
    return { reads, body };
  }

  it('the bulk is there: four parts of each table, 800,000 rows', async () => {
    for (const table of [Table.Transactions, Table.Exchanges, Table.AccountTransactions, Table.BalanceChanges]) {
      const [row] = await h.ch.query<{ n: string; parts: string }>(
        `SELECT count() AS n, uniqExact(_part) AS parts FROM ${table} WHERE ledger_index >= ${BULK_BASES[0]} AND ledger_index < 29000000`,
      );
      expect([table, Number(row.n), Number(row.parts)]).toEqual([table, BULK_ROWS, 4]);
    }
  });

  describe.each([false, true])('descending=%s', (descending) => {
    const page = (path: string, marker: (string | number)[]): string =>
      `${path}${path.includes('?') ? '&' : '?'}limit=5&descending=${descending}&marker=${markerOf(marker)}`;

    it('/v2/transactions (transactions)', async () => {
      const { body } = await expectBounded(Table.Transactions, page('/v2/transactions', [MID, 1]), 'transactions');
      expect((body.transactions as unknown[]).length).toBe(5);
    });

    it('/v2/transactions?type=Payment (tx_by_type)', async () => {
      const { body } = await expectBounded(
        Table.TxByType,
        page('/v2/transactions?type=Payment', [MID, 1]),
        'transactions',
      );
      expect((body.transactions as unknown[]).length).toBe(5);
    });

    it('/v2/payments (payments)', async () => {
      const { body } = await expectBounded(Table.Payments, page('/v2/payments', [MID, 1]), 'payments');
      expect((body.payments as unknown[]).length).toBe(5);
    });

    it('/v2/payments/:currency (payments_by_currency)', async () => {
      const { body } = await expectBounded(
        Table.PaymentsByCurrency,
        page(`/v2/payments/${accounts.currency}`, [MID, 1]),
        'payments',
      );
      expect((body.payments as unknown[]).length).toBe(5);
    });

    it('/v2/exchanges/:base/:counter (exchanges)', async () => {
      const { body } = await expectBounded(
        Table.Exchanges,
        page(`/v2/exchanges/${pairPath}`, [MID, 1, pair.node_index]),
        'exchanges',
      );
      expect((body.exchanges as unknown[]).length).toBe(5);
    });

    it('/v2/exchanges (every pair)', async () => {
      const { body } = await expectBounded(
        Table.Exchanges,
        page('/v2/exchanges', [MID, 1, pair.node_index]),
        'exchanges',
      );
      expect((body.exchanges as unknown[]).length).toBe(5);
    });

    it('/v2/accounts (accounts_created)', async () => {
      const [row] = await h.ch.query<{ account: string }>(
        `SELECT account FROM ${Table.AccountsCreated} WHERE ledger_index = ${MID} LIMIT 1`,
      );
      const { body } = await expectBounded(
        Table.AccountsCreated,
        page('/v2/accounts', [MID, 1, row.account]),
        'accounts',
      );
      expect((body.accounts as unknown[]).length).toBe(5);
    });

    it('/v2/accounts/:address/transactions (account_transactions)', async () => {
      const { body } = await expectBounded(
        Table.AccountTransactions,
        page(`/v2/accounts/${accounts.transactions}/transactions`, [MID, 1]),
        'transactions',
      );
      expect((body.transactions as unknown[]).length).toBe(5);
    });

    it('/v2/accounts/:address/transactions?min_sequence (account_tx_by_sequence)', async () => {
      const sequence = 3_000_000_000 + (MID - BULK_BASES[0]);
      await expectBounded(
        Table.AccountTxBySequence,
        page(`/v2/accounts/${accounts.sequence}/transactions?min_sequence=0`, [sequence, MID, 1]),
        'transactions',
      );
    });

    it('/v2/accounts/:address/payments (account_payments)', async () => {
      const { body } = await expectBounded(
        Table.AccountPayments,
        page(`/v2/accounts/${accounts.payments}/payments`, [MID, 1]),
        'payments',
      );
      expect((body.payments as unknown[]).length).toBe(5);
    });

    it('/v2/accounts/:address/exchanges (account_exchanges)', async () => {
      const [row] = await h.ch.query<{ node_index: number }>(
        `SELECT node_index FROM ${Table.AccountExchanges} WHERE account = {account:String} AND ledger_index = ${MID} LIMIT 1`,
        { account: accounts.exchanges },
      );
      const { body } = await expectBounded(
        Table.AccountExchanges,
        page(`/v2/accounts/${accounts.exchanges}/exchanges`, [MID, 1, row.node_index]),
        'exchanges',
      );
      expect((body.exchanges as unknown[]).length).toBe(5);
    });

    it('/v2/accounts/:address/balance_changes (balance_changes)', async () => {
      const [row] = await h.ch.query<{ node_index: number }>(
        `SELECT node_index FROM ${Table.BalanceChanges} WHERE account = {account:String} AND ledger_index = ${MID} LIMIT 1`,
        { account: accounts.balances },
      );
      const { body } = await expectBounded(
        Table.BalanceChanges,
        page(`/v2/accounts/${accounts.balances}/balance_changes`, [MID, 1, row.node_index]),
        'balance_changes',
      );
      expect((body.balance_changes as unknown[]).length).toBe(5);
    });

    it('/v2/network/fees (ledgers)', async () => {
      const { body } = await expectBounded(Table.Ledgers, page('/v2/network/fees', [MID]), 'rows');
      expect((body.rows as unknown[]).length).toBe(5);
    });

    it('/v2/network/fee_stats (fee_stats)', async () => {
      const ms = Date.parse('2020-02-01T12:00:00Z');
      const { body } = await expectBounded(
        Table.FeeStats,
        page('/v2/network/fee_stats?start=2020-01-01', [ms]),
        'rows',
      );
      expect((body.rows as unknown[]).length).toBe(5);
    });

    it('/v2/exchanges/:base/:counter?interval (exchanges, the candles of a page)', async () => {
      // a minute is 60 bulk ledgers, 240 exchanges: a page of 5 candles and the edge of the next is 1,440 of them
      const at = new Date((t0 + (MID - BULK_BASES[0])) * 1000).toISOString();
      const window = descending ? `end=${at}` : `start=${at}`;
      const { body } = await expectBounded(
        Table.Exchanges,
        `/v2/exchanges/${pairPath}?interval=1minute&limit=5&descending=${descending}&${window}`,
        'exchanges',
      );
      expect((body.exchanges as unknown[]).length).toBe(5);
    });
  });

  it('/v2/exchange_rates/:base/:counter (exchanges, the last 50 trades)', async () => {
    // the 14 days before the date reach back into the third and the fourth part of the bulk
    const date = new Date((t0 + (BULK_BASES[3] + BULK_LEDGERS - BULK_BASES[0]) + 2 * 86_400) * 1000).toISOString();
    const { reads } = await expectBounded(
      Table.Exchanges,
      `/v2/exchange_rates/${pairPath}?date=${date}&live=true&strict=false`,
      'rate',
    );
    expect(reads.some((r) => /LIMIT/.test(r.query))).toBe(true);
  });
});

describe('a page whose duplicates fill the room of the first read (a ledger written ten times)', () => {
  // ledger 11616399 holds 4 transactions; ten copies of each come one after the other in the order of the key, so the
  // first read of a page of 2 (room for 19 rows) holds two transactions only and is read again with more room
  const LEDGER = 11616399;
  const COPIES = 10;
  const WINDOW = 'start=2015-02-09T18:14:30&end=2015-02-09T18:14:30';
  const inWindow = fixtureTransactions('ripple-mock')
    .filter((t) => t.ledger.header.close_time === Date.parse('2015-02-09T18:14:30Z') / 1000)
    .sort((a, b) => a.row.ledger_index - b.row.ledger_index || a.row.tx_index - b.row.tx_index);
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    for (const table of [Table.Transactions, Table.TxByType, Table.AccountTransactions]) {
      await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${table}`);
      const [{ n: before }] = await h.ch.query<{ n: string }>(
        `SELECT count() AS n FROM ${table} WHERE ledger_index = {ledger:UInt32}`,
        { ledger: LEDGER },
      );
      for (let copy = 1; copy < COPIES; copy++) {
        await h.ch.command(
          `INSERT INTO ${table} SELECT * FROM ${table} WHERE ledger_index = {ledger:UInt32} LIMIT {n:UInt32}`,
          { ledger: LEDGER, n: Number(before) },
          { settings: { insert_deduplicate: 0 } },
        );
      }
      const [{ n }] = await h.ch.query<{ n: string }>(
        `SELECT count() AS n FROM ${table} WHERE ledger_index = {ledger:UInt32}`,
        { ledger: LEDGER },
      );
      expect([table, Number(n)]).toEqual([table, Number(before) * COPIES]);
    }
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  const hashes = (pages: { transactions: { hash: string }[] }[]): string[] =>
    pages.flatMap((p) => p.transactions.map((t) => t.hash));

  it('the transactions of the window, each once, page by page, and the first page read twice', async () => {
    expect(inWindow.filter((t) => t.row.ledger_index === LEDGER)).toHaveLength(4);
    for (const [extra, expected] of [
      ['', inWindow],
      ['&type=OfferCreate', inWindow.filter((t) => t.row.tx_type === 'OfferCreate')],
    ] as const) {
      const query = jest.spyOn(h.ch, 'query');
      const first = await api.ok(`/v2/transactions?${WINDOW}${extra}&limit=2`, 'transactions');
      const caps = query.mock.calls
        .filter(([sql]) => String(sql).includes('distinct_page_cap'))
        .map(([, params]) => (params as Record<string, unknown>).distinct_page_cap);
      query.mockRestore();
      expect([extra, first.body.transactions.map((t: { hash: string }) => t.hash)]).toEqual([
        extra,
        expected.slice(0, 2).map((t) => t.tx.hash),
      ]);
      if (expected.filter((t) => t.row.ledger_index === LEDGER).length >= 2) {
        // the room grew: the duplicates of the first read left fewer than the page and one more
        expect([extra, caps.length]).toEqual([extra, 2]);
        expect(caps[1]).toBeGreaterThan(caps[0] as number);
      }
      const walked = await api.pages<{ transactions: { hash: string }[]; marker?: string }>(
        `/v2/transactions?${WINDOW}${extra}`,
        2,
        'transactions',
      );
      expect([extra, hashes(walked)]).toEqual([extra, expected.map((t) => t.tx.hash)]);
    }
  });

  it('the transactions of an account, each once, page by page', async () => {
    const [{ account }] = await h.ch.query<{ account: string }>(
      `SELECT account FROM ${Table.AccountTransactions} WHERE ledger_index = {ledger:UInt32}
        GROUP BY account ORDER BY count() DESC, account LIMIT 1`,
      { ledger: LEDGER },
    );
    const rows = await h.ch.query<{ ledger_index: number; tx_index: number }>(
      `SELECT DISTINCT ledger_index, tx_index FROM ${Table.AccountTransactions}
        WHERE account = {account:String} ORDER BY ledger_index, tx_index`,
      { account },
    );
    const walked = await api.pages<{
      transactions: { ledger_index: number; tx: { Sequence: number } }[];
      marker?: string;
    }>(`/v2/accounts/${account}/transactions`, 1, 'transactions');
    expect(walked.flatMap((p) => p.transactions.map((t) => t.ledger_index))).toEqual(rows.map((r) => r.ledger_index));
  });
});

describe('amm=only reads the granules that hold swaps, not the range (read_rows over 100,000 order-book rows and 10 swaps)', () => {
  // Ruling R-A1: `exchanges` and `account_exchanges` carry `INDEX amm_account_set amm_account TYPE set(1024)
  // GRANULARITY 1`, and the condition of the filter is inside the read that is capped. `amm_account` is not in the key,
  // so only the index can tell a granule without swaps from one with them: a read of `amm=only` is bounded by
  // (the granules that hold swaps + 2) x index_granularity, however many order-book rows the range holds.
  //
  // The range is 100,000 order-book rows of one pair in four parts of 25,000 (one account's in `account_exchanges`),
  // and 10 swaps in a part of their own, in the same range of the key.
  const BOOK_PER_PART = 25_000;
  const SWAPS = 10;
  const SWAP_BASE = 25_000_000;
  const POOL = 'rBulkPooLxxxxxxxxxxxxxxxxxxxxxxxxx';
  const SEEDED_BOOK = BULK_BASES.length * BOOK_PER_PART;
  type Bulky = Table.Exchanges | Table.AccountExchanges;

  let h: Harness;
  let api: ApiClient;
  let t0: number;
  let pair: Pair;
  let pairPath: string;
  let account: string;
  let granule: Record<Bulky, number>;
  let holding: Record<Bulky, number>;

  const closeTimeOf = (ledger: string): string => `toDateTime({t0:UInt32} + (${ledger} - ${BULK_BASES[0]}), 'UTC')`;

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    const [first] = await h.ch.query<{ t: number }>(
      `SELECT toUnixTimestamp(close_time) AS t FROM ${Table.Ledgers} WHERE ledger_index = 20005122`,
    );
    t0 = Number(first.t) + 86_400;
    const keyed = (base: number): string =>
      `${bulkLedger(base)} AS ledger_index, ${BULK_TX_INDEX} AS tx_index, ${closeTimeOf(bulkLedger(base))} AS close_time`;

    [pair] = await h.ch.query<Pair>(
      `SELECT base_currency, base_issuer, counter_currency, counter_issuer, any(node_index) AS node_index
         FROM ${Table.Exchanges}
        GROUP BY base_currency, base_issuer, counter_currency, counter_issuer
        ORDER BY count() DESC, base_currency, counter_currency LIMIT 1`,
    );
    pairPath = `${side(pair.base_currency, pair.base_issuer)}/${side(pair.counter_currency, pair.counter_issuer)}`;
    const pairRow = `SELECT * FROM ${Table.Exchanges}
        WHERE base_currency = {base_currency:String} AND base_issuer = {base_issuer:String}
          AND counter_currency = {counter_currency:String} AND counter_issuer = {counter_issuer:String}
          AND node_index = {node_index:UInt16}
        ORDER BY ledger_index, tx_index LIMIT 1`;
    [{ account }] = await h.ch.query<{ account: string }>(
      `SELECT account FROM ${Table.AccountExchanges} GROUP BY account ORDER BY count() DESC, account LIMIT 1`,
    );
    const accountRow = `SELECT * FROM ${Table.AccountExchanges} WHERE account = {account:String}
        ORDER BY ledger_index, tx_index LIMIT 1`;

    // the order-book rows: four parts, merges stopped
    await insertBulk(h, Table.Exchanges, pairRow, { ...pair, t0 }, (base) => keyed(base), BOOK_PER_PART);
    await insertBulk(h, Table.AccountExchanges, accountRow, { account, t0 }, (base) => keyed(base), BOOK_PER_PART);
    // the swaps: one part, ten ledgers of their own in the range of the key, the pool as provider and amm_account
    const swap = `${closeTimeOf(`toUInt32(${SWAP_BASE} + n.number)`)} AS close_time,
                  toUInt32(${SWAP_BASE} + n.number) AS ledger_index, toUInt32(0) AS tx_index,
                  {pool:String} AS amm_account, {pool:String} AS provider, toUInt32(0) AS offer_sequence`;
    for (const [table, template, params] of [
      [Table.Exchanges, pairRow, { ...pair, t0, pool: POOL }],
      [Table.AccountExchanges, accountRow, { account, t0, pool: POOL }],
    ] as const) {
      await h.ch.command(
        `INSERT INTO ${table} SELECT tpl.* REPLACE (${swap}) FROM (${template}) AS tpl CROSS JOIN numbers(${SWAPS}) AS n`,
        params,
        { settings: { insert_deduplicate: 0 } },
      );
    }

    granule = { [Table.Exchanges]: 0, [Table.AccountExchanges]: 0 };
    holding = { [Table.Exchanges]: 0, [Table.AccountExchanges]: 0 };
    for (const table of [Table.Exchanges, Table.AccountExchanges] as Bulky[]) {
      // `index_granularity` of the table: its setting, or 8192
      const [{ ddl }] = await h.ch.query<{ ddl: string }>(
        `SELECT create_table_query AS ddl FROM system.tables WHERE database = {db:String} AND name = {table:String}`,
        { db: h.database, table },
      );
      granule[table] = Number(/index_granularity\s*=\s*(\d+)/.exec(ddl)?.[1] ?? 8192);
      // the granules (of a part) that hold a swap
      const [row] = await h.ch.query<{ granules: string }>(
        `SELECT uniqExact(_part, intDiv(_part_offset, {granule:UInt32})) AS granules FROM ${table} WHERE amm_account != ''`,
        { granule: granule[table] },
      );
      holding[table] = Number(row.granules);
    }
  }, 600_000);

  afterAll(async () => {
    await h?.close();
  });

  /** What the plan of a read says about the skip index of `amm_account`: the granules it selects and those it has. */
  async function skipIndexOf(
    sql: string,
    params: Record<string, unknown>,
  ): Promise<{ selected: number; total: number }> {
    const plan = await explain(h, 'indexes = 1', sql, params);
    const found = /Name: amm_account_set[\s\S]*?Granules: (\d+)\/(\d+)/.exec(plan);
    if (!found) throw new Error(`the plan does not use amm_account_set:\n${plan}`);
    return { selected: Number(found[1]), total: Number(found[2]) };
  }

  /** The reads of `table` while `path` was served (the SQL and its params), and what each of them read. */
  async function served(
    table: Table,
    path: string,
  ): Promise<{ reads: LoggedRead[]; statements: [string, Record<string, unknown>][]; body: Record<string, unknown> }> {
    const spy = jest.spyOn(h.ch, 'query');
    let body: Record<string, unknown> = {};
    const reads = await readsOf(h, table, async () => {
      body = (await api.ok(path, 'exchanges')).body as Record<string, unknown>;
    });
    const statements = spy.mock.calls
      .filter(([sql]) => new RegExp(`FROM ${table}\\b`).test(String(sql)))
      .map(
        ([sql, params]) =>
          [String(sql), (params ?? {}) as Record<string, unknown>] as [string, Record<string, unknown>],
      );
    spy.mockRestore();
    return { reads, statements, body };
  }

  /** `read_rows` <= (the granules that hold swaps + 2) x index_granularity, for every SELECT of the request on the table. */
  const boundOf = (table: Bulky): number => (holding[table] + 2) * granule[table];

  it('the seed is as assumed: 100,000 order-book rows in four parts, 10 swaps in at most two granules', async () => {
    for (const table of [Table.Exchanges, Table.AccountExchanges] as const) {
      const [row] = await h.ch.query<{ book: string; swaps: string; parts: string }>(
        `SELECT countIf(amm_account = '' AND ledger_index >= ${BULK_BASES[0]} AND ledger_index < ${SWAP_BASE}) AS book,
                countIf(amm_account != '') AS swaps,
                uniqExactIf(_part, amm_account = '' AND ledger_index >= ${BULK_BASES[0]}) AS parts
           FROM ${table}`,
      );
      expect([table, Number(row.book), Number(row.swaps), Number(row.parts)]).toEqual([
        table,
        SEEDED_BOOK,
        SWAPS,
        BULK_BASES.length,
      ]);
      expect(holding[table]).toBeLessThanOrEqual(2);
      expect(holding[table]).toBeGreaterThanOrEqual(1);
      expect(granule[table]).toBeGreaterThan(1000);
      // the swaps are in a part of their own: not one granule holds both kinds
      const [mixed] = await h.ch.query<{ n: string }>(
        `SELECT count() AS n FROM (SELECT _part FROM ${table} GROUP BY _part HAVING countIf(amm_account != '') > 0 AND countIf(amm_account = '') > 0)`,
      );
      expect(Number(mixed.n)).toBe(0);
    }
    // the bound is far below the range: 100,000 rows
    expect(boundOf(Table.Exchanges)).toBeLessThan(SEEDED_BOOK);
    expect(boundOf(Table.AccountExchanges)).toBeLessThan(SEEDED_BOOK);
  });

  describe.each([false, true])('descending=%s', (descending) => {
    const direction = `descending=${descending}`;

    it('/v2/exchanges/:base/:counter?amm=only: the swaps, in at most (granules + 2) x index_granularity rows', async () => {
      for (const limit of [200, 5]) {
        const path = `/v2/exchanges/${pairPath}?amm=only&limit=${limit}&${direction}`;
        const { reads, body } = await served(Table.Exchanges, path);
        expect(reads.length).toBeGreaterThan(0);
        for (const read of reads)
          expect([path, read.read_rows <= boundOf(Table.Exchanges) ? 'bounded' : read.read_rows]).toEqual([
            path,
            'bounded',
          ]);
        const exchanges = body.exchanges as { amm_account: string }[];
        expect([path, exchanges.length, exchanges.every((e) => e.amm_account === POOL)]).toEqual([
          path,
          Math.min(limit, SWAPS),
          true,
        ]);
      }
    });

    it('/v2/exchanges/:base/:counter?amm=only: the plan uses the skip index, and its page is read in order and capped', async () => {
      const path = `/v2/exchanges/${pairPath}?amm=only&limit=5&${direction}`;
      const { statements } = await served(Table.Exchanges, path);
      expect(statements).toHaveLength(1);
      const [sql, params] = statements[0];
      const index = await skipIndexOf(innerRead(sql), params);
      // the granules of the swaps out of those of all the parts of the pair
      expect(index.selected).toBeLessThanOrEqual(holding[Table.Exchanges]);
      expect(index.total).toBeGreaterThan(SEEDED_BOOK / granule[Table.Exchanges]);
      await expectBoundedInOrderRead(h, sql, params, descending, path);
    });

    it('/v2/exchanges/:base/:counter?interval and ?reduce with amm=only: every read of the aggregation is bounded too', async () => {
      const at = new Date((t0 + (SWAP_BASE - BULK_BASES[0])) * 1000).toISOString();
      for (const query of [
        `interval=1minute&limit=200&${direction}`,
        `interval=1hour&limit=2&${direction}`,
        'reduce=true',
      ]) {
        const path = `/v2/exchanges/${pairPath}?amm=only&${query}`;
        const { reads, statements, body } = await served(Table.Exchanges, path);
        expect(reads.length).toBeGreaterThan(0);
        for (const read of reads)
          expect([path, read.read_rows <= boundOf(Table.Exchanges) ? 'bounded' : read.read_rows]).toEqual([
            path,
            'bounded',
          ]);
        // and each of them uses the index
        for (const [sql, params] of statements) {
          const index = await skipIndexOf(sql, params);
          expect([path, index.selected <= holding[Table.Exchanges]]).toEqual([path, true]);
        }
        // the candles and the reduced row are those of the 10 swaps
        const rows = body.exchanges as { count: number }[];
        expect([path, rows.reduce((n, r) => n + r.count, 0)]).toEqual([path, SWAPS]);
      }
      expect(at).toBeTruthy();
    });

    it('/v2/exchanges?amm=only: one read of the range, bounded', async () => {
      const path = `/v2/exchanges?amm=only&limit=200&${direction}`;
      const { reads, body } = await served(Table.Exchanges, path);
      expect(reads).toHaveLength(1);
      expect(reads[0].read_rows).toBeLessThanOrEqual(boundOf(Table.Exchanges));
      const exchanges = body.exchanges as { amm_account: string }[];
      expect([exchanges.length, exchanges.every((e) => e.amm_account === POOL)]).toEqual([SWAPS, true]);
    });

    it('/v2/accounts/:address/exchanges?amm=only: the swaps, bounded, with and without a pair filter', async () => {
      for (const filter of ['', `/${pair.base_currency}`]) {
        const path = `/v2/accounts/${account}/exchanges${filter}?amm=only&limit=200&${direction}`;
        const { reads, statements, body } = await served(Table.AccountExchanges, path);
        expect(reads.length).toBeGreaterThan(0);
        for (const read of reads)
          expect([path, read.read_rows <= boundOf(Table.AccountExchanges) ? 'bounded' : read.read_rows]).toEqual([
            path,
            'bounded',
          ]);
        const exchanges = body.exchanges as { amm_account: string }[];
        expect([path, exchanges.length]).toEqual([path, SWAPS]);
        const [sql, params] = statements[0];
        expect((await skipIndexOf(innerRead(sql), params)).selected).toBeLessThanOrEqual(
          holding[Table.AccountExchanges],
        );
        await expectBoundedInOrderRead(h, sql, params, descending, path);
      }
    });

    it('amm=exclude reads a page of the order-book rows: about the granules the page needs, no more than without the filter', async () => {
      for (const [table, base] of [
        [Table.Exchanges, `/v2/exchanges/${pairPath}`],
        [Table.AccountExchanges, `/v2/accounts/${account}/exchanges`],
      ] as const) {
        const page = (query: string): string => `${base}?limit=5&${direction}${query}`;
        const total = (reads: LoggedRead[]): number => reads.reduce((n, r) => n + r.read_rows, 0);
        const { reads: unfiltered } = await served(table, page(''));
        const { reads: excluded } = await served(table, page('&amm=exclude'));
        expect(excluded.length).toBeGreaterThan(0);
        for (const read of excluded) {
          expect([page('&amm=exclude'), read.read_rows <= PAGE_READ_BOUND ? 'bounded' : read.read_rows]).toEqual([
            page('&amm=exclude'),
            'bounded',
          ]);
        }
        // the filter skips the granule of the swaps; it never makes the page read more
        expect([table, total(excluded) <= total(unfiltered)]).toEqual([table, true]);
      }
    });
  });

  it('without the skip index the same read costs the range: the bound is the index at work (control)', async () => {
    const path = `/v2/exchanges/${pairPath}?amm=only&limit=200`;
    const { statements } = await served(Table.Exchanges, path);
    const [sql, params] = statements[0];
    const reads = await readsOf(h, Table.Exchanges, async () => {
      const rows = await h.ch.query(sql, params, { use_skip_indexes: 0 });
      expect(rows).toHaveLength(SWAPS);
    });
    expect(reads).toHaveLength(1);
    expect(reads[0].read_rows).toBeGreaterThanOrEqual(SEEDED_BOOK);
    expect(reads[0].read_rows).toBeGreaterThan(boundOf(Table.Exchanges));
    // and with it, the read of the request
    const [{ read_rows }] = await readsOf(h, Table.Exchanges, async () => {
      await h.ch.query(sql, params);
    });
    expect(read_rows).toBeLessThanOrEqual(boundOf(Table.Exchanges));
  });
});
