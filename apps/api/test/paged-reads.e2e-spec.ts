import { Table } from '@gatehub/data-api-shared';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { fixtureTransactions } from './support/fixtures';
import { expectBoundedInOrderRead, isPageRead, tableReads } from './support/plans';
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
import { fleet, insertManifests, insertSeen, insertValidatorValidations } from './support/validators-seed';

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
 * `/v2/network/validators/{key}/validations` pages a validator that is several keys: its master key and the signing keys its
 * manifests name, each read in the order of its own key and combined (the bulk of `validator_validations` has the three keys
 * of one validator, a fourth key of another that has none, and the same ledger and hash under every key of the first).
 *
 * A page touches one or two parts and ClickHouse reads whole granules (8192 rows; 1024 for `transactions`), a few of
 * each part it opens: `PAGE_READ_BOUND` is far below the 200,000 rows of one part, and far below what the old reads
 * took (most of the 800,000).
 */
const PAGE_READ_BOUND = 40_000;
const DAY_SECONDS = 86_400;

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
  /** The validators of the `validator_validations` bulk: a master with two signing keys, and one with none. */
  const validators = { master: '', signing: [] as string[], lone: '' };

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

    // validator_validations: the rows of a validator and of its two signing keys (a ledger of each, with one hash for all of
    // them: they are one validation of the master), and of a validator with no signing key; the sightings are of an hour ago
    const keys = fleet('xrpl', 5);
    validators.master = keys[0].key;
    validators.signing = [keys[1].ephemeral, keys[2].ephemeral];
    validators.lone = keys[3].key;
    const hourAgo = Math.floor(Date.now() / 1000) - 3600;
    await insertManifests(h.ch, [
      { ephemeral_key: validators.signing[0], master_key: validators.master, seq: 1 },
      { ephemeral_key: validators.signing[1], master_key: validators.master, seq: 2 },
    ]);
    await insertSeen(h.ch, [
      { key: validators.master, first: hourAgo - DAY_SECONDS, last: hourAgo },
      { key: validators.lone, first: hourAgo - DAY_SECONDS, last: hourAgo },
    ]);
    await insertValidatorValidations(h.ch, [
      { validation_public_key: validators.master, ledger_index: 20_999_999, first_datetime: hourAgo },
    ]);
    await insertBulk(
      h,
      Table.ValidatorValidations,
      `SELECT * FROM ${Table.ValidatorValidations} ORDER BY validation_public_key, ledger_index LIMIT 1`,
      {
        master: validators.master,
        signing0: validators.signing[0],
        signing1: validators.signing[1],
        lone: validators.lone,
      },
      (base) =>
        `toUInt32(${base} + intDiv(n.number, 4)) AS ledger_index, ` +
        `transform(n.number % 4, [0, 1, 2, 3], [{master:String}, {signing0:String}, {signing1:String}, {lone:String}], {master:String}) AS validation_public_key`,
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

    describe('/v2/network/validators/:key/validations (validator_validations)', () => {
      /** A page of 200 validations, the default, that starts inside the bulk: the statement reads 201 rows. */
      const validationsPage = async (key: string): Promise<string> => {
        const [{ ledger_hash }] = await h.ch.query<{ ledger_hash: string }>(
          `SELECT ledger_hash FROM ${Table.ValidatorValidations} WHERE ledger_index = {ledger:UInt32} LIMIT 1`,
          { ledger: MID },
        );
        return `/v2/network/validators/${key}/validations?limit=200&descending=${descending}&marker=${markerOf([MID, ledger_hash])}`;
      };

      /** The statement of the page that a request sent to ClickHouse, with its bound values. */
      const statementOf = async (path: string): Promise<{ sql: string; params: Record<string, unknown> }> => {
        const spy = jest.spyOn(h.ch, 'query');
        let calls: [string, Record<string, unknown>][] = [];
        try {
          await api.ok(path, 'validations');
          calls = spy.mock.calls
            .filter(([sql]) => isPageRead(String(sql)))
            .map(([sql, params]) => [String(sql), params as Record<string, unknown>]);
        } finally {
          spy.mockRestore();
        }
        expect(calls).toHaveLength(1);
        return { sql: calls[0][0], params: calls[0][1] };
      };

      it('reads about a granule of each part for each of the three keys of a master, and every validation is whole', async () => {
        const path = await validationsPage(validators.master);
        let body: { validations: { count: number }[]; marker?: string } = { validations: [] };
        const reads = await readsOf(h, Table.ValidatorValidations, async () => {
          body = (await api.ok(path, 'validations')).body;
        });
        // 200 validations, each the sightings under the master key and its two signing keys
        expect(body.validations).toHaveLength(200);
        expect(body.validations.map((row) => row.count)).toEqual(Array(200).fill(3));
        expect(body.marker).toEqual(expect.any(String));
        // the page is the read that groups by validation (the directory built for the request reads the table too, boundedly)
        const pageReads = reads.filter((read) => /GROUP BY ledger_index, ledger_hash/.test(read.query));
        expect(pageReads).toHaveLength(1);
        // an inner read for each of the three keys, each within what a page of any other list reads
        const bound = (1 + validators.signing.length) * PAGE_READ_BOUND;
        expect([path, pageReads[0].read_rows <= bound ? 'bounded' : pageReads[0].read_rows]).toEqual([path, 'bounded']);
      });

      it('reads the table in the order of its key, with a limit: the one inner read of a validator with no signing key', async () => {
        const { sql, params } = await statementOf(await validationsPage(validators.lone));
        await expectBoundedInOrderRead(h, sql, params, descending, 'the validations of a validator with one key');
      });

      it('reads each of the three keys of a master in the order of the key, each with a limit', async () => {
        const { sql, params } = await statementOf(await validationsPage(validators.master));
        expect(await tableReads(h, sql, params)).toEqual(
          Array(3).fill({
            readType: descending ? 'InReverseOrder' : 'InOrder',
            prefixSorted: true,
            limit: params.distinct_page_cap,
          }),
        );
      });
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
