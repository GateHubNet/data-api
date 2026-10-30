import { Table } from '@gatehub/data-api-shared';
import { SAMPLE_ROWS } from '../../../packages/shared/test/sample-rows';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { accountAt, primaryKeys, served } from './support/amm';
import { fixtureTransactions } from './support/fixtures';
import { insertNftEvents, nftEventRow } from './support/nfts';
import { COUNTERPARTY, insertObjects, jsonOf, objectRow, OWNER } from './support/objects';
import { expectBoundedInOrderRead, explain, innerRead, isPageRead, tableReads } from './support/plans';
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

    describe('/v2/tokens/:token/transfers (payments_by_currency)', () => {
      const transfers = (): string => page(`/v2/tokens/${accounts.currency}/transfers`, [MID, 1]);

      it('a page of 5 transfers that starts inside the bulk reads about a granule of each part, and is whole', async () => {
        const { body } = await expectBounded(Table.PaymentsByCurrency, transfers(), 'transfers');
        // the five keys after the marker in the direction of the list, and the marker of the page after them
        expect((body.transfers as { ledger_index: number }[]).map((t) => t.ledger_index)).toEqual(
          descending ? [MID, MID - 1, MID - 1, MID - 1, MID - 1] : [MID, MID, MID + 1, MID + 1, MID + 1],
        );
        expect(body.count).toBe(5);
        expect(body.marker).toBe(markerOf(descending ? [MID - 1, 0] : [MID + 1, 2]));
        // and the rows of the page, read from payments by their keys, are a few granules too
        await expectBounded(Table.Payments, transfers(), 'transfers');
      });

      it('the page read is read in the order of the key and stops after its rows', async () => {
        const path = transfers();
        const { statements } = await served(h, api, Table.PaymentsByCurrency, path, 'transfers');
        const reads = statements.filter(([sql]) => isPageRead(sql));
        expect(reads).toHaveLength(1);
        const [sql, params] = reads[0];
        await expectBoundedInOrderRead(h, sql, params, descending, path);
        // the token is a condition of the inner read, bound and not written into the statement
        expect(innerRead(sql)).toContain('currency = {currency:String}');
        expect(innerRead(sql)).toContain('issuer = {issuer:String}');
        expect(sql).not.toContain(accounts.currency.split('+')[1]);
        expect(sql).not.toMatch(/\bFINAL\b/i);
      });
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

    it('/v2/exchanges?amm=only: the plan of that read uses the skip index (the granules of the swaps of the range)', async () => {
      const path = `/v2/exchanges?amm=only&limit=200&${direction}`;
      const { statements } = await served(Table.Exchanges, path);
      expect(statements).toHaveLength(1);
      const [sql, params] = statements[0];
      const index = await skipIndexOf(sql, params);
      expect(index.selected).toBeLessThanOrEqual(holding[Table.Exchanges]);
      expect(index.total).toBeGreaterThan(SEEDED_BOOK / granule[Table.Exchanges]);
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

  it('/v2/exchanges?amm=only without the skip index costs the range too: its bound is the index at work (control)', async () => {
    const path = '/v2/exchanges?amm=only&limit=200';
    const { statements } = await served(Table.Exchanges, path);
    expect(statements).toHaveLength(1);
    const [sql, params] = statements[0];
    const reads = await readsOf(h, Table.Exchanges, async () => {
      const rows = await h.ch.query(sql, params, { use_skip_indexes: 0 });
      expect(rows.length).toBeGreaterThanOrEqual(SWAPS);
    });
    expect(reads).toHaveLength(1);
    expect(reads[0].read_rows).toBeGreaterThanOrEqual(SEEDED_BOOK);
    expect(reads[0].read_rows).toBeGreaterThan(boundOf(Table.Exchanges));
    const [{ read_rows }] = await readsOf(h, Table.Exchanges, async () => {
      await h.ch.query(sql, params);
    });
    expect(read_rows).toBeLessThanOrEqual(boundOf(Table.Exchanges));
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

describe('the history of an NFT reads the granules of a page, not its 10,000 events (read_rows over a bulk of four parts)', () => {
  // The events of an NFT are a range of the primary key of `nft_events` (the NFT, then its ledgers): `readDistinctPage` reads
  // that range in the order of the key and stops after the page. The NFT has 10,000 events, 2,500 in each of four parts, and
  // every part holds 100,000 events of two other NFTs, one that sorts before it and one after it: a read that did not use
  // the key (or the limit) would read the 410,000 rows of the table.
  const NFT = `${'5'.repeat(8)}${'0'.repeat(48)}0000A001`;
  const BEFORE = '4'.repeat(64);
  const AFTER = '6'.repeat(64);
  const TEMPLATE = '3'.repeat(64);
  const EVENTS_PER_PART = 2_500;
  const OTHERS_PER_PART = 50_000;
  const GRANULE = 8192;
  /**
   * A page touches about a granule of each part that holds the NFT (a part of 2,500 events is one granule), and one more for the
   * template row: the rows of the other two NFTs, which share the parts' ledgers, are not read.
   */
  const READ_BOUND = (BULK_BASES.length + 1) * GRANULE;
  /** The middle of the NFT's events in the second part: a marker there makes the page start inside the bulk. */
  const MID_LEDGER = BULK_BASES[1] + Math.floor(EVENTS_PER_PART / 8);

  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    // one real event is the template of the bulk: a mint of a made-up NFT, in a ledger between the mock ledgers
    await insertNftEvents(h, [nftEventRow({ nft_id: TEMPLATE, ledger_index: 20_999_000, tx_index: 1 })]);
    const template = `SELECT * FROM ${Table.NftEvents} WHERE nft_id = {template:String} LIMIT 1`;
    for (const [id, perPart] of [
      [BEFORE, OTHERS_PER_PART],
      [NFT, EVENTS_PER_PART],
      [AFTER, OTHERS_PER_PART],
    ] as const) {
      await insertBulk(
        h,
        Table.NftEvents,
        template,
        { template: TEMPLATE, nft: id },
        (base) => `{nft:String} AS nft_id, ${bulkLedger(base)} AS ledger_index, ${BULK_TX_INDEX} AS tx_index`,
        perPart,
      );
    }
  }, 600_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the seed is as assumed: 10,000 events of the NFT in four parts, among 410,000 rows of the table', async () => {
    const [mine] = await h.ch.query<{ n: string; parts: string }>(
      `SELECT count() AS n, uniqExact(_part) AS parts FROM ${Table.NftEvents} WHERE nft_id = {nft:String}`,
      { nft: NFT },
    );
    expect([Number(mine.n), Number(mine.parts)]).toEqual([BULK_BASES.length * EVENTS_PER_PART, BULK_BASES.length]);
    const [all] = await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.NftEvents}`);
    expect(Number(all.n)).toBe(BULK_BASES.length * (EVENTS_PER_PART + 2 * OTHERS_PER_PART) + 1);
    // the bound is far below the table
    expect(READ_BOUND).toBeLessThan((BULK_BASES.length * (EVENTS_PER_PART + 2 * OTHERS_PER_PART)) / 8);
  });

  describe.each([false, true])('descending=%s', (descending) => {
    const direction = `descending=${descending}`;
    const pageOf = (limit: number, marker?: (string | number)[]): string =>
      `/v2/nfts/${NFT}/history?limit=${limit}&${direction}${marker === undefined ? '' : `&marker=${markerOf(marker)}`}`;

    it.each([
      ['the first page', undefined],
      ['a page that starts inside the bulk', [MID_LEDGER, 1, 0]],
      ['a page near the start of the range', [BULK_BASES[0] + 100, 2, 0]],
    ] as const)('a page of 200 events (%s) reads about a granule of each part, and is whole', async (_name, marker) => {
      const path = pageOf(200, marker as (string | number)[] | undefined);
      const { reads, body } = await served(h, api, Table.NftEvents, path, 'events');
      expect(reads.length).toBeGreaterThanOrEqual(1);
      for (const read of reads) {
        expect([path, read.read_rows <= READ_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
      }
      expect([path, (body.events as unknown[]).length, body.marker === undefined]).toEqual([path, 200, false]);
    });

    it('the page read is read in the order of the key, stops after its rows, and holds the filter inside', async () => {
      const path = `${pageOf(200, [MID_LEDGER, 1, 0])}&event=mint,sale`;
      const { statements } = await served(h, api, Table.NftEvents, path, 'events');
      const page = statements.filter(([sql]) => isPageRead(sql));
      expect(page).toHaveLength(1);
      const [sql, params] = page[0];
      await expectBoundedInOrderRead(h, sql, params, descending, path);
      // the filter is a condition of the inner read, which the cap counts: never a step after the page
      expect(innerRead(sql)).toContain('event IN {events:Array(String)}');
      expect(sql).not.toMatch(/\bFINAL\b/i);
      // the primary key narrows the read to the NFT and its ledgers: a few granules out of those of the table
      const [primary] = primaryKeys(await explain(h, 'indexes = 1', innerRead(sql), params));
      expect(primary.keys).toEqual(['nft_id', 'ledger_index']);
      expect(primary.condition).toContain(`nft_id in ['${NFT}'`);
      expect(primary.granules[0]).toBeLessThan(primary.granules[1] / 4);
    });
  });

  it('the first event of the NFT, which says whether it is known and whether its mint is indexed, is a read of one granule per part', async () => {
    const { reads } = await served(h, api, Table.NftEvents, `/v2/nfts/${NFT}/history?limit=1`, 'events');
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const read of reads) expect(read.read_rows).toBeLessThanOrEqual(READ_BOUND);
  });

  it('the open offers and the detail read the events of the NFT only: its 10,000 and not the table', async () => {
    for (const path of [`/v2/nfts/${NFT}/offers`, `/v2/nfts/${NFT}`]) {
      const { reads } = await served(h, api, Table.NftEvents, path, 'result');
      for (const read of reads) {
        // the 10,000 events of the NFT, in granules
        expect([path, read.read_rows <= BULK_BASES.length * EVENTS_PER_PART + 2 * BULK_BASES.length * GRANULE]).toEqual(
          [path, true],
        );
      }
    }
  });
});

describe("a collection's NFTs and holders read the granules of a page, not the 120,000 NFTs of one owner, and the list reads its rows once (read_rows over a bulk of four parts)", () => {
  // One collection of 120,000 NFTs, all held by one owner, in four parts of 30,000 (the NFTs of a collection written over time:
  // the keys of the parts are interleaved). Two other collections and two other owners, one that sorts before and one after,
  // have 240,000 each in the same parts: the tables are 600,000 rows, and a read that did not use the key would read them all.
  //  - `nfts` and `account_nfts` are paged by `readNewestPage`: the prefix (the collection, or the owner and the collection) and the
  //    keyset narrow the read, and it stops after the cap, about a granule of each part;
  //  - the holders are paged by `held` and then the owner, which is not the order of their key (`issuer, taxon_key, owner`), so a
  //    page reads the collection's WHOLE holders prefix: 40,000 holders here, in four parts. That is the bound (the holders of one
  //    collection, not the table), and it is the same for every page of the list;
  //  - the list of collections is one read of the rows of `nft_collections`, kept for the next 60 s.
  const PARTS = BULK_BASES.length;
  const GRANULE = 8192;
  const NFTS_PER_PART = 30_000;
  const OTHER_NFTS_PER_PART = 60_000;
  const HOLDERS_PER_PART = 10_000;
  const OTHER_HOLDERS_PER_PART = 20_000;
  const COLLECTIONS_PER_PART = 12_500;
  const TAXON = 7;
  const [BEFORE, ISSUER, AFTER] = [accountAt(0x41), accountAt(0x42), accountAt(0x43)].sort();
  const [OWNER_BEFORE, OWNER, OWNER_AFTER] = [accountAt(0x51), accountAt(0x52), accountAt(0x53)].sort();
  /** An account that holds 200 NFTs spread over the whole collection (every 601st serial, so over all four parts). */
  const SCATTERED = accountAt(0x54);
  const SCATTERED_SERIALS = Array.from({ length: 200 }, (_, i) => 1 + 601 * i);
  /** An account that holds 100 NFTs of the collection before the collection and 100 of the collection, far from one another. */
  const SPANNING = accountAt(0x55);
  const SPANNING_HOLDINGS = [
    ...Array.from({ length: 100 }, (_, i) => ({ issuer: BEFORE, serial: 1 + 2000 * i })),
    ...Array.from({ length: 100 }, (_, i) => ({ issuer: ISSUER, serial: 1 + 1100 * i })),
  ];
  const TEMPLATE = '3'.repeat(64);
  const collection = `/v2/nft_collections/${ISSUER}/${TAXON}`;
  /**
   * A page of the collection reads two granules of each part at most (the one the read starts in and the next) and one more: the
   * measured reads are 65,536 rows for the holdings and 32,769 for the NFTs of the page, in a collection of 120,000 NFTs, so a read
   * that went on to the end of the range, from a page 10,000 NFTs in, would not fit.
   */
  const READ_BOUND = PARTS * 2 * GRANULE + GRANULE;
  /** The NFTs of the collection: what a lookup of NFTs spread over it reads at most (and a granule at each end of each part). */
  const NFTS_PREFIX = PARTS * NFTS_PER_PART;
  /** The holders of the collection: figures 1 to 7 by the order of the bulk (the owner `rHolder…` of the n-th holds 1 + n % 7). */
  const HOLDERS = PARTS * HOLDERS_PER_PART;
  const holderName = (n: number): string => `rHolder${String(n).padStart(8, '0')}`;
  const heldBy = (n: number): number => 1 + (n % 7);

  let h: Harness;
  let api: ApiClient;

  const serialOf = (part: number): string => `toUInt32(n.number * ${PARTS} + ${part} + 1)`;
  const idOf = (part: number): string => `lpad(hex(${serialOf(part)}), 64, '0')`;
  const partOf = (base: number): number => BULK_BASES.indexOf(base);

  /** The inner read of a page of `readNewestPage`: the SELECT with the plain `LIMIT {newest_page_cap}`, which is the read itself. */
  const innerNewestRead = (sql: string): string => {
    const inner = /FROM \((SELECT (?:(?!FROM \()[\s\S])*?LIMIT \{newest_page_cap:UInt32\})\)/.exec(sql)?.[1];
    if (inner === undefined) throw new Error(`not a page read of readNewestPage: ${sql}`);
    return inner;
  };
  const isNewestPageRead = (sql: string): boolean => sql.includes('{newest_page_cap:UInt32}');

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();

    // NFTs: the collection (120,000) between two others (240,000 each)
    await h.ch.insert(Table.Nfts, [{ ...SAMPLE_ROWS[Table.Nfts], nft_id: TEMPLATE, issuer: 'rTemplateIssuer' }]);
    const nfts = async (issuer: string, perPart: number): Promise<void> =>
      insertBulk(
        h,
        Table.Nfts,
        `SELECT * FROM ${Table.Nfts} WHERE nft_id = {template:String} LIMIT 1`,
        { template: TEMPLATE, issuer },
        (base) =>
          `{issuer:String} AS issuer, toUInt32(${TAXON}) AS taxon_key, ${serialOf(partOf(base))} AS serial, ${idOf(partOf(base))} AS nft_id`,
        perPart,
      );
    await nfts(BEFORE, OTHER_NFTS_PER_PART);
    await nfts(ISSUER, NFTS_PER_PART);
    await nfts(AFTER, OTHER_NFTS_PER_PART);

    // the holdings: the owner of the 120,000 between two other owners (of the collections around it)
    await h.ch.insert(Table.AccountNfts, [
      { ...SAMPLE_ROWS[Table.AccountNfts], nft_id: TEMPLATE, owner: 'rTemplateOwner' },
    ]);
    const holdings = async (owner: string, issuer: string, perPart: number): Promise<void> =>
      insertBulk(
        h,
        Table.AccountNfts,
        `SELECT * FROM ${Table.AccountNfts} WHERE nft_id = {template:String} LIMIT 1`,
        { template: TEMPLATE, owner, issuer },
        (base) =>
          `{owner:String} AS owner, {issuer:String} AS issuer, toUInt32(${TAXON}) AS taxon_key, ${serialOf(partOf(base))} AS serial, ${idOf(partOf(base))} AS nft_id, toUInt8(1) AS held`,
        perPart,
      );
    await holdings(OWNER_BEFORE, BEFORE, OTHER_NFTS_PER_PART);
    await holdings(OWNER, ISSUER, NFTS_PER_PART);
    await holdings(OWNER_AFTER, AFTER, OTHER_NFTS_PER_PART);
    // and an account that holds 200 NFTs of the collection which lie far from one another
    await h.ch.insert(
      Table.AccountNfts,
      SCATTERED_SERIALS.map((serial) => ({
        ...SAMPLE_ROWS[Table.AccountNfts],
        owner: SCATTERED,
        issuer: ISSUER,
        taxon_key: TAXON,
        serial,
        nft_id: serial.toString(16).toUpperCase().padStart(64, '0'),
        held: 1,
      })),
    );

    // and an account that holds 100 NFTs of the collection before it and 100 of it, which lie far from one another
    await h.ch.insert(
      Table.AccountNfts,
      SPANNING_HOLDINGS.map(({ issuer, serial }) => ({
        ...SAMPLE_ROWS[Table.AccountNfts],
        owner: SPANNING,
        issuer,
        taxon_key: TAXON,
        serial,
        nft_id: serial.toString(16).toUpperCase().padStart(64, '0'),
        held: 1,
      })),
    );

    // the holders: 40,000 of the collection, between 80,000 of the collections around it
    await h.ch.insert(Table.NftCollectionHolders, [
      { ...SAMPLE_ROWS[Table.NftCollectionHolders], owner: 'rTemplateHolder' },
    ]);
    const holders = async (issuer: string, perPart: number): Promise<void> =>
      insertBulk(
        h,
        Table.NftCollectionHolders,
        `SELECT * FROM ${Table.NftCollectionHolders} WHERE owner = {template:String} LIMIT 1`,
        { template: 'rTemplateHolder', issuer },
        (base) =>
          `{issuer:String} AS issuer, toUInt32(${TAXON}) AS taxon_key, concat('rHolder', lpad(toString(n.number * ${PARTS} + ${partOf(base)}), 8, '0')) AS owner, toUInt32(1 + (n.number * ${PARTS} + ${partOf(base)}) % 7) AS held`,
        perPart,
      );
    await holders(BEFORE, OTHER_HOLDERS_PER_PART);
    await holders(ISSUER, HOLDERS_PER_PART);
    await holders(AFTER, OTHER_HOLDERS_PER_PART);

    // the collections: the one of the NFTs, and 50,000 more
    await h.ch.insert(Table.NftCollections, [
      { ...SAMPLE_ROWS[Table.NftCollections], issuer: 'rTemplateCollection' },
      {
        ...SAMPLE_ROWS[Table.NftCollections],
        issuer: ISSUER,
        taxon_key: TAXON,
        taxon: TAXON,
        supply: 120_000,
        holders: HOLDERS,
      },
    ]);
    await insertBulk(
      h,
      Table.NftCollections,
      `SELECT * FROM ${Table.NftCollections} WHERE issuer = {template:String} LIMIT 1`,
      { template: 'rTemplateCollection' },
      (base) =>
        `concat('rCollection', lpad(toString(n.number * ${PARTS} + ${partOf(base)}), 8, '0')) AS issuer, toUInt32(1) AS taxon_key, toUInt64(n.number % 1000) AS supply, toFloat64(n.number % 777) AS volume_native_f`,
      COLLECTIONS_PER_PART,
    );
  }, 900_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  const count = async (table: Table): Promise<{ rows: number; parts: number }> => {
    const [row] = await h.ch.query<{ n: string; parts: string }>(
      `SELECT count() AS n, uniqExact(_part) AS parts FROM ${table}`,
    );
    return { rows: Number(row.n), parts: Number(row.parts) };
  };

  it('the seed is as assumed: the NFTs, the holdings and the holders of the collection among those of two others', async () => {
    const lots = PARTS * (NFTS_PER_PART + 2 * OTHER_NFTS_PER_PART) + 1;
    expect(await count(Table.Nfts)).toEqual({ rows: lots, parts: PARTS * 3 + 1 });
    // (and the 200 holdings of the account whose NFTs are spread over the collection, a part of their own, and the 200 of the one
    // that holds NFTs of two collections)
    expect(await count(Table.AccountNfts)).toEqual({
      rows: lots + SCATTERED_SERIALS.length + SPANNING_HOLDINGS.length,
      parts: PARTS * 3 + 3,
    });
    expect(await count(Table.NftCollectionHolders)).toEqual({
      rows: PARTS * (HOLDERS_PER_PART + 2 * OTHER_HOLDERS_PER_PART) + 1,
      parts: PARTS * 3 + 1,
    });
    expect(await count(Table.NftCollections)).toEqual({ rows: PARTS * COLLECTIONS_PER_PART + 2, parts: PARTS + 1 });
    // the bound is far below the table, and the collection has the NFTs of the one owner
    expect(READ_BOUND).toBeLessThan(lots / 5);
    const [mine] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.AccountNfts} WHERE owner = {owner:String} AND issuer = {issuer:String}`,
      { owner: OWNER, issuer: ISSUER },
    );
    expect(Number(mine.n)).toBe(PARTS * NFTS_PER_PART);
  });

  /** The id of the NFT with this serial in the bulk: the serial in 64 upper-case hex digits. */
  const idOfSerial = (serial: number): string => serial.toString(16).toUpperCase().padStart(64, '0');
  const pages = [
    ['the first page', undefined],
    ['a page deep in the collection', [10_000, idOfSerial(10_000)]],
    ['a page in the middle of the collection', [60_000, idOfSerial(60_000)]],
    ['a page near the end', [119_000, idOfSerial(119_000)]],
  ] as const;

  it('the first page and the deep one leave more than the bound to read: a read that went on to the end of the range would fail it', () => {
    for (const [, marker] of [pages[0], pages[1]]) {
      const rest = NFTS_PREFIX - (marker === undefined ? 0 : marker[0]);
      expect(rest).toBeGreaterThan(READ_BOUND);
    }
  });

  describe.each(pages)('the NFTs of the collection: %s', (_name, marker) => {
    const path = `${collection}/nfts?limit=200${marker === undefined ? '' : `&marker=${markerOf([...marker])}`}`;
    const first = marker === undefined ? 1 : marker[0] + 1;
    const serials = (body: Record<string, unknown>): number[] =>
      (body.nfts as { serial: number }[]).map((n) => n.serial);

    it('a page of 200 NFTs reads about a granule of each part, and is whole', async () => {
      const { reads, body } = await served(h, api, Table.Nfts, path, 'nfts');
      expect(reads.length).toBeGreaterThanOrEqual(1);
      for (const read of reads)
        expect([path, read.read_rows <= READ_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
      const want = Array.from({ length: Math.min(200, 120_000 - first + 1) }, (_, i) => first + i);
      expect(serials(body)).toEqual(want);
      expect(body.marker === undefined).toBe(first + 200 > 120_000);
    });

    it('the page read is a read of the newest page, in the order of the key, narrowed by the collection and the marker', async () => {
      const { statements } = await served(h, api, Table.Nfts, path, 'nfts');
      const page = statements.filter(([sql]) => isNewestPageRead(sql));
      expect(page).toHaveLength(1);
      const [sql, params] = page[0];
      expect(sql).not.toMatch(/\bFINAL\b/i);
      expect(sql).toContain('burned = 0');
      // a few granules out of those of the table
      const [primary] = primaryKeys(await explain(h, 'indexes = 1', innerNewestRead(sql), params));
      // (the collection, and after it the serial of the marker: the first page has none)
      expect(primary.keys.slice(0, 3)).toEqual(
        marker === undefined ? ['issuer', 'taxon_key'] : ['issuer', 'taxon_key', 'serial'],
      );
      expect(primary.granules[0]).toBeLessThan(primary.granules[1] / 4);
    });
  });

  it('the NFTs of the owner: a page of the holdings reads about a granule of each part, and the NFTs of the page a few more', async () => {
    const path = `${collection}/nfts?limit=200&owner=${OWNER}`;
    const holdings = await served(h, api, Table.AccountNfts, path, 'nfts');
    for (const read of holdings.reads) expect(read.read_rows).toBeLessThanOrEqual(READ_BOUND);
    expect((holdings.body.nfts as { serial: number }[]).map((n) => n.serial)).toEqual(
      Array.from({ length: 200 }, (_, i) => i + 1),
    );
    const page = holdings.statements.filter(([sql]) => isNewestPageRead(sql));
    expect(page).toHaveLength(1);
    const [primary] = primaryKeys(await explain(h, 'indexes = 1', innerNewestRead(page[0][0]), page[0][1]));
    expect(primary.keys.slice(0, 4)).toEqual(['owner', 'issuer', 'taxon_key']);
    expect(primary.granules[0]).toBeLessThan(primary.granules[1] / 4);
    // the NFTs themselves, by their keys
    const nfts = await served(h, api, Table.Nfts, path, 'nfts');
    expect(nfts.reads.length).toBeGreaterThanOrEqual(1);
    for (const read of nfts.reads)
      expect([path, read.read_rows <= READ_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
  });

  it("the NFTs of an account whose holdings are spread over the collection: the lookup reads the collection's nfts at most, not the table", async () => {
    // 200 NFTs, one in 600 or so, over all four parts: each lies in a granule of its own, so the lookup of the page reads about
    // every granule of the collection's `nfts` (its 120,000 rows) and no row of the collections around it
    const path = `${collection}/nfts?limit=200&owner=${SCATTERED}`;
    const holdings = await served(h, api, Table.AccountNfts, path, 'nfts');
    expect((holdings.body.nfts as { serial: number }[]).map((n) => n.serial)).toEqual(SCATTERED_SERIALS);
    expect(holdings.body.marker).toBeUndefined();
    // (the 200 holdings are one part of the account's own: a granule)
    for (const read of holdings.reads) expect(read.read_rows).toBeLessThanOrEqual(GRANULE);
    const nfts = await served(h, api, Table.Nfts, path, 'nfts');
    expect(nfts.reads.length).toBeGreaterThanOrEqual(1);
    const bound = NFTS_PREFIX + PARTS * GRANULE;
    const table = (await count(Table.Nfts)).rows;
    expect(bound).toBeLessThan(table / 3);
    for (const read of nfts.reads) {
      expect([path, read.read_rows <= bound ? 'within the collection' : read.read_rows]).toEqual([
        path,
        'within the collection',
      ]);
    }
  });

  // -- the NFTs of an account (`/v2/accounts/{address}/nfts`), the same tables ---------------------------------------------------------
  //  - the holdings are the owner's prefix of `account_nfts` (all of them when no collection is named: here the 120,000 of the one
  //    collection), paged by `readNewestPage` as a collection's holdings are: a page stops after the cap, a granule or two of each part;
  //  - the NFTs of the page are the newest `nfts` rows of its keys, by the WHOLE key of each (the holdings of an account lie in
  //    collections of their own): about a granule of each part for each NFT that lies in a granule of its own. Holdings that lie
  //    together read a few granules; 200 that are far from one another read up to the `nfts` rows of the collections the page names,
  //    which is the bound, and never the rows of another collection.

  describe.each(pages)('the NFTs of the account that holds the 120,000: %s', (_name, marker) => {
    const account = `/v2/accounts/${OWNER}/nfts`;
    const path = `${account}?limit=200${marker === undefined ? '' : `&marker=${markerOf([ISSUER, TAXON, ...marker])}`}`;
    const first = marker === undefined ? 1 : marker[0] + 1;
    const serials = (body: Record<string, unknown>): number[] =>
      (body.nfts as { serial: number }[]).map((n) => n.serial);

    it('a page of 200 NFTs reads about a granule of each part of the holdings and of the NFTs, and is whole', async () => {
      const holdings = await served(h, api, Table.AccountNfts, path, 'nfts');
      expect(holdings.reads.length).toBeGreaterThanOrEqual(1);
      for (const read of holdings.reads)
        expect([path, read.read_rows <= READ_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
      const want = Array.from({ length: Math.min(200, 120_000 - first + 1) }, (_, i) => first + i);
      expect(serials(holdings.body)).toEqual(want);
      expect(holdings.body.marker === undefined).toBe(first + 200 > 120_000);
      // the NFTs themselves, by their keys: they lie together, so a few granules
      const nfts = await served(h, api, Table.Nfts, path, 'nfts');
      expect(nfts.reads.length).toBeGreaterThanOrEqual(1);
      for (const read of nfts.reads)
        expect([path, read.read_rows <= READ_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
    });

    it('the page read is a read of the newest page, in the order of the key, narrowed by the owner and the marker', async () => {
      const { statements } = await served(h, api, Table.AccountNfts, path, 'nfts');
      const page = statements.filter(([sql]) => isNewestPageRead(sql));
      expect(page).toHaveLength(1);
      const [sql, params] = page[0];
      expect(sql).not.toMatch(/\bFINAL\b/i);
      expect(sql).toContain('held = 1');
      // a few granules out of those of the table: the owner's, and after the marker
      const [primary] = primaryKeys(await explain(h, 'indexes = 1', innerNewestRead(sql), params));
      expect(primary.keys[0]).toBe('owner');
      expect(primary.condition).toContain(`owner in ['${OWNER}'`);
      expect(primary.granules[0]).toBeLessThan(primary.granules[1] / 4);
      // the lookup of the NFTs is by the whole key of each, in one read
      const lookups = (await served(h, api, Table.Nfts, path, 'nfts')).statements.filter(([text]) =>
        text.includes('(issuer, taxon_key, serial, nft_id) IN'),
      );
      expect(lookups).toHaveLength(1);
      const [lookup, lookupParams] = lookups[0];
      const [byKey] = primaryKeys(await explain(h, 'indexes = 1', lookup, lookupParams));
      expect(byKey.keys).toEqual(['issuer', 'taxon_key', 'serial', 'nft_id']);
      expect(byKey.granules[0]).toBeLessThan(byKey.granules[1] / 4);
    });
  });

  it('issuer and taxon narrow the holdings to the collection: the owner, the issuer and the taxon are the prefix of the read', async () => {
    const path = `/v2/accounts/${OWNER}/nfts?limit=200&issuer=${ISSUER}&taxon=${TAXON}`;
    const { reads, statements, body } = await served(h, api, Table.AccountNfts, path, 'nfts');
    for (const read of reads) expect(read.read_rows).toBeLessThanOrEqual(READ_BOUND);
    expect((body.nfts as { serial: number }[]).map((n) => n.serial)).toEqual(
      Array.from({ length: 200 }, (_, i) => i + 1),
    );
    const page = statements.filter(([sql]) => isNewestPageRead(sql));
    expect(page).toHaveLength(1);
    const [primary] = primaryKeys(await explain(h, 'indexes = 1', innerNewestRead(page[0][0]), page[0][1]));
    expect(primary.keys.slice(0, 3)).toEqual(['owner', 'issuer', 'taxon_key']);
    expect(primary.granules[0]).toBeLessThan(primary.granules[1] / 4);
  });

  it("the NFTs of an account whose holdings are spread over one collection: the lookup reads the collection's nfts at most, not the table", async () => {
    // the 200 holdings are one part of the account's own (a granule); each NFT lies in a granule of its own in the collection's
    // `nfts`, so the lookup of the page reads about every granule of it (its 120,000 rows) and none of the collections around it
    const path = `/v2/accounts/${SCATTERED}/nfts?limit=200`;
    const holdings = await served(h, api, Table.AccountNfts, path, 'nfts');
    expect((holdings.body.nfts as { serial: number }[]).map((n) => n.serial)).toEqual(SCATTERED_SERIALS);
    expect(holdings.body.marker).toBeUndefined();
    for (const read of holdings.reads) expect(read.read_rows).toBeLessThanOrEqual(GRANULE);
    const nfts = await served(h, api, Table.Nfts, path, 'nfts');
    expect(nfts.reads.length).toBeGreaterThanOrEqual(1);
    const bound = NFTS_PREFIX + PARTS * GRANULE;
    const table = (await count(Table.Nfts)).rows;
    expect(bound).toBeLessThan(table / 3);
    for (const read of nfts.reads) {
      expect([path, read.read_rows <= bound ? 'within the collection' : read.read_rows]).toEqual([
        path,
        'within the collection',
      ]);
    }
  });

  it('the NFTs of an account that holds NFTs of two collections: the lookup reads the nfts of those collections at most, not the one beside them', async () => {
    // 100 NFTs of the collection before the collection and 100 of it, none of the collection after it: the bound is the nfts of the
    // two collections (240,000 and 120,000 rows) and a granule of each part at each end, and the 240,000 of the third are not read
    const path = `/v2/accounts/${SPANNING}/nfts?limit=200`;
    const holdings = await served(h, api, Table.AccountNfts, path, 'nfts');
    const served200 = holdings.body.nfts as { issuer: string; serial: number }[];
    // by collection, then serial: the 100 of the collection before it first
    expect(served200.map((n) => [n.issuer, n.serial])).toEqual(
      SPANNING_HOLDINGS.map(({ issuer, serial }) => [issuer, serial]),
    );
    for (const read of holdings.reads) expect(read.read_rows).toBeLessThanOrEqual(GRANULE);
    const nfts = await served(h, api, Table.Nfts, path, 'nfts');
    expect(nfts.reads.length).toBeGreaterThanOrEqual(1);
    const bound = PARTS * OTHER_NFTS_PER_PART + NFTS_PREFIX + 2 * PARTS * GRANULE;
    const table = (await count(Table.Nfts)).rows;
    expect(table - bound).toBeGreaterThan((PARTS * OTHER_NFTS_PER_PART) / 2);
    for (const read of nfts.reads) {
      expect([path, read.read_rows <= bound ? 'within the two collections' : read.read_rows]).toEqual([
        path,
        'within the two collections',
      ]);
    }
  });

  it("the holders of a collection: a page reads the collection's whole holders prefix, and no other collection's, whichever page it is", async () => {
    // by the figure held, the most first, and then by owner: the order of the bulk is the order of the owners
    const order = Array.from({ length: HOLDERS }, (_, n) => n).sort((a, b) => heldBy(b) - heldBy(a) || a - b);
    const want = (from: number): unknown[] =>
      order.slice(from, from + 200).map((n) => ({ owner: holderName(n), held: heldBy(n) }));
    // the prefix is read whole (more than the 200 rows of the page, the 40,000 of the collection) and not a row of any other
    const bound = HOLDERS + PARTS * GRANULE;
    const total = PARTS * (HOLDERS_PER_PART + 2 * OTHER_HOLDERS_PER_PART);
    expect(bound).toBeLessThan(total / 2);
    for (const [name, marker, from] of [
      ['the first page', undefined, 0],
      ['a page far down', [order.length > 0 ? heldBy(order[10_000]) : 0, holderName(order[10_000])], 10_001],
      ['the last figure', [1, holderName(order[order.length - 201])], order.length - 200],
    ] as const) {
      const path = `${collection}/holders?limit=200${marker === undefined ? '' : `&marker=${markerOf([...marker])}`}`;
      const { reads, body } = await served(h, api, Table.NftCollectionHolders, path, 'holders');
      expect([name, body.holders]).toEqual([name, want(from)]);
      expect(reads).toHaveLength(1);
      expect([name, reads[0].read_rows >= HOLDERS, reads[0].read_rows <= bound]).toEqual([name, true, true]);
    }
  });

  it('the list reads the rows of nft_collections once, the next request none, and the list of an issuer a few granules', async () => {
    const all = await count(Table.NftCollections);
    const first = await served(h, api, Table.NftCollections, '/v2/nft_collections?limit=200', 'collections');
    expect(first.reads).toHaveLength(1);
    expect(first.reads[0].read_rows).toBeLessThanOrEqual(all.rows);
    expect(first.body.total).toBe(all.rows);
    // the next request is served from what was kept: the sort and the page are made again, the table is not read
    const second = await served(
      h,
      api,
      Table.NftCollections,
      '/v2/nft_collections?limit=200&sort=holders',
      'collections',
    );
    expect(second.reads).toHaveLength(0);
    expect(second.statements).toHaveLength(0);
    // the list of an issuer is a prefix of the key
    const mine = await served(h, api, Table.NftCollections, `/v2/nft_collections?issuer=${ISSUER}`, 'collections');
    expect(mine.reads).toHaveLength(1);
    expect(mine.reads[0].read_rows).toBeLessThanOrEqual((PARTS + 1) * GRANULE);
    expect(mine.body.total).toBe(1);
  });

  it('a start 400 days back is a 400 before any read', async () => {
    const spy = jest.spyOn(h.ch, 'query');
    const start = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
    const res = await api.get(`${collection}/stats?start=${start}`);
    expect([res.status, res.body]).toEqual([
      400,
      { result: 'error', message: 'invalid window - use at most 366 days' },
    ]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    // and a year is read: the collection's row, and then its events in the ledgers of the window
    const year = new Date(Date.now() - 300 * 86_400_000).toISOString().slice(0, 10);
    const ok = await api.get(`${collection}/stats?start=${year}`);
    expect([ok.status, ok.body.days]).toEqual([200, []]);
  });
});

describe('the sales of a collection read the granules of a page, not the 400,000 events of the collection (read_rows over a bulk of four parts)', () => {
  // The sales of a collection are a range of the primary key of `collection_nft_events` (the collection, then its ledgers), read in
  // the order of the key a page at a time by `readDistinctPage`: the `sale` filter is a condition of the read that is capped. The
  // collection has 400,000 events, 100,000 in each of the four parts (every fourth a mint, the rest sales), and the collections
  // around it, one that sorts before and one that sorts after, have 200,000 each in the same parts: a read that did not stop after
  // the page would read the rest of the range, hundreds of thousands of rows, and one that did not use the key all 1,200,000.
  const PARTS = BULK_BASES.length;
  const GRANULE = 8192;
  const EVENTS_PER_PART = 100_000;
  const OTHERS_PER_PART = 50_000;
  const TAXON = 7;
  const [BEFORE, ISSUER, AFTER] = [accountAt(0x61), accountAt(0x62), accountAt(0x63)].sort();
  const TEMPLATE = '3'.repeat(64);
  const collection = `/v2/nft_collections/${ISSUER}/${TAXON}`;
  /**
   * Two granules of each part at most (the one the read starts in and the next) and one more: a page starts in one part and goes
   * on into the next, and the measured read is far below this. The rest of the range after a deep marker is larger than it.
   */
  const READ_BOUND = PARTS * 2 * GRANULE + GRANULE;
  /** A marker 5,000 ledgers (20,000 events) into the second part: the page starts inside the bulk. */
  const MID_LEDGER = BULK_BASES[1] + 5_000;

  let h: Harness;
  let api: ApiClient;

  /** The key of a sale, as a marker holds it. */
  type Sale = [ledger: number, tx: number, event: number];
  /** The sale after `sale` in the order of the key (three sales a ledger: the transactions 0 to 2, the 3rd is a mint). */
  const after = ([ledger, tx]: Sale): Sale => (tx < 2 ? [ledger, tx + 1, 0] : [ledger + 1, 0, 0]);
  const before = ([ledger, tx]: Sale): Sale => (tx > 0 ? [ledger, tx - 1, 0] : [ledger - 1, 2, 0]);

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    // the template of the bulk: a sale of a made-up NFT in a ledger between the mock ledgers
    await h.ch.insert(Table.CollectionNftEvents, [
      nftEventRow({
        nft_id: TEMPLATE,
        issuer: 'rTemplateIssuer',
        ledger_index: 20_999_000,
        tx_index: 1,
        event: 'sale',
        amount: '1',
        amount_f: 1,
        currency: 'XRP',
      }),
    ]);
    const events = async (issuer: string, perPart: number): Promise<void> =>
      insertBulk(
        h,
        Table.CollectionNftEvents,
        `SELECT * FROM ${Table.CollectionNftEvents} WHERE nft_id = {template:String} LIMIT 1`,
        { template: TEMPLATE, issuer },
        (base) =>
          `{issuer:String} AS issuer, toUInt32(${TAXON}) AS taxon_key, ${bulkLedger(base)} AS ledger_index, ${BULK_TX_INDEX} AS tx_index, if(${BULK_TX_INDEX} = 3, 'mint', 'sale') AS event`,
        perPart,
      );
    await events(BEFORE, OTHERS_PER_PART);
    await events(ISSUER, EVENTS_PER_PART);
    await events(AFTER, OTHERS_PER_PART);
    // the collection has a row: its routes are served
    await h.ch.insert(Table.NftCollections, [
      { ...SAMPLE_ROWS[Table.NftCollections], issuer: ISSUER, taxon_key: TAXON, taxon: TAXON },
    ]);
  }, 900_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the seed is as assumed: 400,000 events of the collection in four parts, 300,000 of them sales, among 1,200,001 rows', async () => {
    const [mine] = await h.ch.query<{ n: string; sales: string; parts: string }>(
      `SELECT count() AS n, countIf(event = 'sale') AS sales, uniqExact(_part) AS parts FROM ${Table.CollectionNftEvents}
        WHERE issuer = {issuer:String} AND taxon_key = {taxon:UInt32}`,
      { issuer: ISSUER, taxon: TAXON },
    );
    expect([Number(mine.n), Number(mine.sales), Number(mine.parts)]).toEqual([
      PARTS * EVENTS_PER_PART,
      PARTS * EVENTS_PER_PART * 0.75,
      PARTS,
    ]);
    const [all] = await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.CollectionNftEvents}`);
    expect(Number(all.n)).toBe(PARTS * (EVENTS_PER_PART + 2 * OTHERS_PER_PART) + 1);
    // the bound is far below the collection, and what is left of the range after the deep marker is more than the bound
    expect(READ_BOUND).toBeLessThan((PARTS * EVENTS_PER_PART) / 4);
    expect((BULK_BASES[1] + 25_000 - MID_LEDGER) * 4 + 2 * EVENTS_PER_PART).toBeGreaterThan(READ_BOUND);
    expect((MID_LEDGER - BULK_BASES[1]) * 4 + EVENTS_PER_PART).toBeGreaterThan(READ_BOUND);
  });

  describe.each([false, true])('descending=%s', (descending) => {
    const direction = `descending=${descending}`;
    const pageOf = (limit: number, marker?: Sale): string =>
      `${collection}/sales?limit=${limit}&${direction}${marker === undefined ? '' : `&marker=${markerOf(marker)}`}`;
    /** The 201 sales (the page and the one that says there is more) after the marker in the direction of the read. */
    const wantKeys = (marker: Sale | undefined): Sale[] => {
      const step = descending ? before : after;
      const keys: Sale[] = [];
      let next: Sale =
        marker === undefined ? (descending ? [BULK_BASES[3] + 24_999, 2, 0] : [BULK_BASES[0], 0, 0]) : step(marker);
      while (keys.length < 200) {
        keys.push(next);
        next = step(next);
      }
      return keys;
    };

    it.each([
      ['the first page', undefined],
      ['a page that starts inside the bulk', [MID_LEDGER, 1, 0]],
      ['a page near the start of the range', [BULK_BASES[0] + 100, 2, 0]],
    ] as const)('a page of 200 sales (%s) reads about a granule of each part, and is whole', async (_name, marker) => {
      const path = pageOf(200, marker as Sale | undefined);
      const { reads, body } = await served(h, api, Table.CollectionNftEvents, path, 'sales');
      expect(reads.length).toBeGreaterThanOrEqual(1);
      for (const read of reads) {
        expect([path, read.read_rows <= READ_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
      }
      const sales = body.sales as { ledger_index: number; tx_index: number; event_index: number }[];
      expect([path, sales.map((s) => [s.ledger_index, s.tx_index, s.event_index])]).toEqual([
        path,
        wantKeys(marker as Sale | undefined),
      ]);
      expect(body.marker).toBe(markerOf(wantKeys(marker as Sale | undefined)[199]));
    });

    it('the page read is read in the order of the key, stops after its rows, and holds the filter inside', async () => {
      const path = pageOf(200, [MID_LEDGER, 1, 0]);
      const { statements } = await served(h, api, Table.CollectionNftEvents, path, 'sales');
      const page = statements.filter(([sql]) => isPageRead(sql));
      expect(page).toHaveLength(1);
      const [sql, params] = page[0];
      await expectBoundedInOrderRead(h, sql, params, descending, path);
      // the kind of event is a condition of the inner read, which the cap counts: never a step after the page
      expect(innerRead(sql)).toContain("event = 'sale'");
      expect(sql).not.toMatch(/\bFINAL\b/i);
      // the primary key narrows the read to the collection, from the marker on: the granules of the collection (and one at each end
      // of each part) out of those of the table, not the collections around it. The read itself stops after the cap
      const [primary] = primaryKeys(await explain(h, 'indexes = 1', innerRead(sql), params));
      expect(primary.keys).toEqual(['issuer', 'taxon_key', 'ledger_index']);
      expect(primary.condition).toContain(`issuer in ['${ISSUER}'`);
      expect(primary.granules[0]).toBeLessThanOrEqual(Math.ceil((PARTS * EVENTS_PER_PART) / GRANULE) + 2 * PARTS);
      expect(primary.granules[0]).toBeLessThan(primary.granules[1] * 0.6);
    });
  });
});

describe('the sales of the network and the history of an account read the granules of a page, not the range (read_rows over a bulk of four parts)', () => {
  // `nft_sales` is a range of the ledgers (the network's sales), and `account_nft_events` a range of the primary key (the account,
  // then its ledgers); both are read in the order of the key a page at a time by `readDistinctPage`, the filters (the currency of
  // a sale, the event and the roles of an event) being conditions of the read that is capped.
  //  - the sales: 100,000 in each of four parts, four to a ledger, every fourth priced in USD and the rest in the native currency;
  //    a read that did not stop after the page would read the rest of the range, hundreds of thousands of rows;
  //  - the events of the account: 100,000 in each of four parts, four to a ledger, every fourth a sale with the broker among its
  //    roles and the rest mints; two other accounts, one that sorts before and one that sorts after, have 100,000 each in the same
  //    parts: a read that did not use the key would read all 1,200,000.
  const PARTS = BULK_BASES.length;
  const GRANULE = 8192;
  const SALES_PER_PART = 100_000;
  const EVENTS_PER_PART = 100_000;
  const [BEFORE, ACCOUNT, AFTER] = [accountAt(0x72), accountAt(0x73), accountAt(0x74)].sort();
  const USD_ISSUER = accountAt(0x71);
  const TEMPLATE = '3'.repeat(64);
  /**
   * Two granules of each part at most (the one the read starts in and the next) and one more: a page starts in one part and goes
   * on into the next, and the measured read is far below this. The rest of the range after a deep marker is larger than it.
   */
  const READ_BOUND = PARTS * 2 * GRANULE + GRANULE;
  /** A marker 5,000 ledgers (20,000 sales) into the second part: the page starts inside the bulk. */
  const MID_LEDGER = BULK_BASES[1] + 5_000;
  /** The same for the events of the account. */
  const MID_EVENT_LEDGER = MID_LEDGER;
  const LEDGERS_PER_PART_EVENTS = EVENTS_PER_PART / 4;
  /** The last ledger of the bulks. */
  const BULK_END = BULK_BASES[3] + LEDGERS_PER_PART_EVENTS;
  /** The ledger of the template of the bulks: above the newest ledger (the mock ledger 29136413), so that no window holds it. */
  const TEMPLATE_LEDGER = 29_999_000;

  let h: Harness;
  let api: ApiClient;

  /** The key of a row, as a marker holds it. */
  type Key = [ledger: number, tx: number, event: number];
  /** The row after `key` in the order of the key (four to a ledger: the transactions 0 to 3), and the one before it. */
  const after = ([ledger, tx]: Key): Key => (tx < 3 ? [ledger, tx + 1, 0] : [ledger + 1, 0, 0]);
  const before = ([ledger, tx]: Key): Key => (tx > 0 ? [ledger, tx - 1, 0] : [ledger - 1, 3, 0]);
  /** The `n` keys after the marker (or from the start of the range) in the direction of the read, `step` apart. */
  function wantKeys(
    marker: Key | undefined,
    descending: boolean,
    n: number,
    start: Key,
    end: Key,
    keep: (key: Key) => boolean = () => true,
  ): Key[] {
    const step = descending ? before : after;
    const keys: Key[] = [];
    let next: Key = marker === undefined ? (descending ? end : start) : step(marker);
    while (keys.length < n) {
      if (keep(next)) keys.push(next);
      next = step(next);
    }
    return keys;
  }

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    // one real sale is the template of the bulks: a sale of a made-up NFT in a ledger above the mock ledgers (and the copies of it
    // an ingest writes: the row of each account it names)
    await insertNftEvents(h, [
      nftEventRow({
        nft_id: TEMPLATE,
        issuer: 'rTemplateIssuer',
        ledger_index: TEMPLATE_LEDGER,
        tx_index: 1,
        event: 'sale',
        amount: '1',
        amount_f: 1,
        currency: 'XRP',
      }),
    ]);
    await insertBulk(
      h,
      Table.NftSales,
      `SELECT * FROM ${Table.NftSales} WHERE nft_id = {template:String} LIMIT 1`,
      { template: TEMPLATE, usd_issuer: USD_ISSUER },
      (base) =>
        `${bulkLedger(base)} AS ledger_index, ${BULK_TX_INDEX} AS tx_index, if(${BULK_TX_INDEX} = 3, 'USD', 'XRP') AS currency, if(${BULK_TX_INDEX} = 3, {usd_issuer:String}, '') AS amount_issuer`,
      SALES_PER_PART,
    );
    const events = async (account: string): Promise<void> =>
      insertBulk(
        h,
        Table.AccountNftEvents,
        `SELECT * FROM ${Table.AccountNftEvents} WHERE nft_id = {template:String} AND account = 'rSyntheticOwner' LIMIT 1`,
        { template: TEMPLATE, account },
        (base) =>
          `{account:String} AS account, ${bulkLedger(base)} AS ledger_index, ${BULK_TX_INDEX} AS tx_index, if(${BULK_TX_INDEX} = 3, 'sale', 'mint') AS event, if(${BULK_TX_INDEX} = 3, ['broker', 'to'], ['to']) AS roles`,
        EVENTS_PER_PART,
      );
    await events(BEFORE);
    await events(ACCOUNT);
    await events(AFTER);
  }, 900_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the seed is as assumed: 400,000 sales in four parts, and 400,000 events of the account among 1,200,000', async () => {
    const [sales] = await h.ch.query<{ n: string; parts: string }>(
      `SELECT count() AS n, uniqExact(_part) AS parts FROM ${Table.NftSales} WHERE ledger_index BETWEEN {from:UInt32} AND {to:UInt32}`,
      { from: BULK_BASES[0], to: BULK_END },
    );
    expect([Number(sales.n), Number(sales.parts)]).toEqual([PARTS * SALES_PER_PART, PARTS]);
    const [mine] = await h.ch.query<{ n: string; parts: string }>(
      `SELECT count() AS n, uniqExact(_part) AS parts FROM ${Table.AccountNftEvents} WHERE account = {account:String} AND ledger_index BETWEEN {from:UInt32} AND {to:UInt32}`,
      { account: ACCOUNT, from: BULK_BASES[0], to: BULK_END },
    );
    expect([Number(mine.n), Number(mine.parts)]).toEqual([PARTS * EVENTS_PER_PART, PARTS]);
    const [all] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.AccountNftEvents} WHERE ledger_index BETWEEN {from:UInt32} AND {to:UInt32}`,
      { from: BULK_BASES[0], to: BULK_END },
    );
    expect(Number(all.n)).toBe(3 * PARTS * EVENTS_PER_PART);
    // the bounds are far below what a read that did not stop would read, and what is left of the range after the deep markers is more
    expect(READ_BOUND).toBeLessThan((PARTS * SALES_PER_PART) / 4);
    expect(READ_BOUND).toBeLessThan((PARTS * EVENTS_PER_PART) / 4);
    expect((MID_LEDGER - BULK_BASES[1]) * 4 + SALES_PER_PART).toBeGreaterThan(READ_BOUND);
    expect((BULK_BASES[1] + SALES_PER_PART / 4 - MID_LEDGER) * 4 + 2 * SALES_PER_PART).toBeGreaterThan(READ_BOUND);
    expect((MID_EVENT_LEDGER - BULK_BASES[1]) * 4 + EVENTS_PER_PART).toBeGreaterThan(READ_BOUND);
    expect((BULK_BASES[1] + LEDGERS_PER_PART_EVENTS - MID_EVENT_LEDGER) * 4 + 2 * EVENTS_PER_PART).toBeGreaterThan(
      READ_BOUND,
    );
  });

  describe.each([false, true])('descending=%s', (descending) => {
    const direction = `descending=${descending}`;
    const pageOf = (path: string, limit: number, marker?: Key, extra = ''): string =>
      `${path}?limit=${limit}&${direction}${extra}${marker === undefined ? '' : `&marker=${markerOf(marker)}`}`;

    describe('GET /v2/nft_sales', () => {
      const salesStart: Key = [BULK_BASES[0], 0, 0];
      const salesEnd: Key = [BULK_BASES[3] + SALES_PER_PART / 4 - 1, 3, 0];

      it.each([
        ['the first page', undefined],
        ['a page that starts inside the bulk', [MID_LEDGER, 1, 0]],
        ['a page near the start of the range', [BULK_BASES[0] + 100, 2, 0]],
      ] as const)(
        'a page of 200 sales (%s) reads about a granule of each part, and is whole',
        async (_name, marker) => {
          const path = pageOf('/v2/nft_sales', 200, marker as Key | undefined);
          const { reads, body } = await served(h, api, Table.NftSales, path, 'sales');
          expect(reads.length).toBeGreaterThanOrEqual(1);
          for (const read of reads) {
            expect([path, read.read_rows <= READ_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
          }
          const keys = (body.sales as { ledger_index: number; tx_index: number; event_index: number }[]).map(
            (s) => [s.ledger_index, s.tx_index, s.event_index] as Key,
          );
          const want = wantKeys(marker as Key | undefined, descending, 200, salesStart, salesEnd);
          expect([path, keys]).toEqual([path, want]);
          expect(body.marker).toBe(markerOf(want[199]));
        },
      );

      it('the page read is read in the order of the key, stops after its rows, and reads no table but the sales', async () => {
        const path = pageOf('/v2/nft_sales', 200, [MID_LEDGER, 1, 0]);
        const { statements } = await served(h, api, Table.NftSales, path, 'sales');
        const page = statements.filter(([sql]) => isPageRead(sql));
        expect(page).toHaveLength(1);
        const [sql, params] = page[0];
        await expectBoundedInOrderRead(h, sql, params, descending, path);
        expect(sql).toContain(`FROM ${Table.NftSales}`);
        expect(sql).not.toMatch(/\bFINAL\b/i);
        const [primary] = primaryKeys(await explain(h, 'indexes = 1', innerRead(sql), params));
        expect(primary.keys[0]).toBe('ledger_index');
        expect(primary.parts[0]).toBeGreaterThanOrEqual(1);
      });

      it('a page of the sales priced in one currency (every fourth) reads about a granule of each part too: the filter is inside the capped read', async () => {
        const path = pageOf('/v2/nft_sales', 200, [MID_LEDGER, 1, 0], `&currency=USD%2B${USD_ISSUER}`);
        const { reads, body, statements } = await served(h, api, Table.NftSales, path, 'sales');
        for (const read of reads) {
          expect([path, read.read_rows <= READ_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
        }
        const keys = (body.sales as { ledger_index: number; tx_index: number; event_index: number }[]).map(
          (s) => [s.ledger_index, s.tx_index, s.event_index] as Key,
        );
        expect([path, keys]).toEqual([
          path,
          wantKeys([MID_LEDGER, 1, 0], descending, 200, salesStart, salesEnd, ([, tx]) => tx === 3),
        ]);
        const page = statements.filter(([sql]) => isPageRead(sql));
        expect(page).toHaveLength(1);
        expect(innerRead(page[0][0])).toContain(
          'currency = {currency:String} AND amount_issuer = {amount_issuer:String}',
        );
        await expectBoundedInOrderRead(h, page[0][0], page[0][1], descending, path);
      });
    });

    describe('GET /v2/accounts/{address}/nft_history', () => {
      const historyPath = `/v2/accounts/${ACCOUNT}/nft_history`;
      const eventsStart: Key = [BULK_BASES[0], 0, 0];
      const eventsEnd: Key = [BULK_BASES[3] + LEDGERS_PER_PART_EVENTS - 1, 3, 0];
      const keysOf = (body: Record<string, unknown>): Key[] =>
        (body.events as { ledger_index: number; tx_index: number; event_index: number }[]).map(
          (e) => [e.ledger_index, e.tx_index, e.event_index] as Key,
        );

      it.each([
        ['the first page', undefined],
        ['a page that starts inside the bulk', [MID_EVENT_LEDGER, 1, 0]],
        ['a page near the start of the range', [BULK_BASES[0] + 100, 2, 0]],
      ] as const)(
        'a page of 200 events (%s) reads about a granule of each part, and is whole',
        async (_name, marker) => {
          const path = pageOf(historyPath, 200, marker as Key | undefined);
          const { reads, body } = await served(h, api, Table.AccountNftEvents, path, 'events');
          expect(reads.length).toBeGreaterThanOrEqual(1);
          for (const read of reads) {
            expect([path, read.read_rows <= READ_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
          }
          const want = wantKeys(marker as Key | undefined, descending, 200, eventsStart, eventsEnd);
          expect([path, keysOf(body)]).toEqual([path, want]);
          expect(body.marker).toBe(markerOf(want[199]));
        },
      );

      it('the page read is read in the order of the key, stops after its rows, and holds the filters inside', async () => {
        const path = pageOf(historyPath, 200, [MID_EVENT_LEDGER, 1, 0], '&event=sale&role=broker');
        const { statements, body } = await served(h, api, Table.AccountNftEvents, path, 'events');
        // every fourth event is a sale with the broker among its roles: the page of them is whole
        expect([path, keysOf(body)]).toEqual([
          path,
          wantKeys([MID_EVENT_LEDGER, 1, 0], descending, 200, eventsStart, eventsEnd, ([, tx]) => tx === 3),
        ]);
        const page = statements.filter(([sql]) => isPageRead(sql));
        expect(page).toHaveLength(1);
        const [sql, params] = page[0];
        await expectBoundedInOrderRead(h, sql, params, descending, path);
        // the event and the roles are conditions of the inner read, which the cap counts: never a step after the page
        expect(innerRead(sql)).toContain('event IN {events:Array(String)}');
        expect(innerRead(sql)).toContain('hasAny(roles, {roles:Array(String)})');
        expect(sql).not.toMatch(/\bFINAL\b/i);
        // the primary key narrows the read to the account's rows: its 400,000 of the 1,200,000 of the bulk
        const [primary] = primaryKeys(await explain(h, 'indexes = 1', innerRead(sql), params));
        expect(primary.keys[0]).toBe('account');
        expect(primary.condition).toContain(`account in ['${ACCOUNT}'`);
        expect(primary.granules[0]).toBeLessThan(primary.granules[1] * 0.6);
      });

      it('a page of the events in which the account has one role (every fourth) reads about a granule of each part too', async () => {
        const path = pageOf(historyPath, 200, [MID_EVENT_LEDGER, 1, 0], '&role=broker');
        const { reads, body } = await served(h, api, Table.AccountNftEvents, path, 'events');
        for (const read of reads) {
          expect([path, read.read_rows <= READ_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
        }
        expect(keysOf(body)).toEqual(
          wantKeys([MID_EVENT_LEDGER, 1, 0], descending, 200, eventsStart, eventsEnd, ([, tx]) => tx === 3),
        );
      });
    });
  });
});

describe('the detail and the history of an escrow read the granules of a page and the rows of the escrow, not the 810,000 rows of the table (read_rows over a bulk of four parts)', () => {
  // The rows of an object are a range of the primary key of `object_changes` (its type and id, then its ledgers):
  // `readDistinctPage` reads that range in the order of the key and stops after the page, and the creation is a read of the same
  // range. The escrow has 10,000 events, 2,500 in each of four parts, and its creation in a part of its own. Two other escrows, one
  // that sorts before it and one after it, have 100,000 rows in each of four parts of their own, in the same partition: a read that
  // did not use the key (or the limit, or the object) would read the 810,000 rows of the table.
  const ESCROW = '5'.repeat(64);
  const BEFORE = '4'.repeat(64);
  const AFTER = '6'.repeat(64);
  const TEMPLATE = '3'.repeat(64);
  const EVENTS_PER_PART = 2_500;
  const OTHERS_PER_PART = 100_000;
  const GRANULE = 8192;
  /** The parts that hold rows of the escrow: the four of the bulk and the one with its creation. */
  const PARTS = BULK_BASES.length + 1;
  const ESCROW_ROWS = BULK_BASES.length * EVENTS_PER_PART + 1;
  /** The rows the bulk and the two made by hand add to the table; the rows of the mock ledgers come with the seed. */
  const ADDED_ROWS = BULK_BASES.length * (EVENTS_PER_PART + 2 * OTHERS_PER_PART) + 2;
  /** A page touches about a granule of each part that holds the escrow, and one more for the part's partial granule. */
  const PAGE_BOUND = (PARTS + 1) * GRANULE;
  /** The creation (and the existence read) reads the prefix of the escrow and nothing else: its rows and two granules a part. */
  const PREFIX_BOUND = ESCROW_ROWS + 2 * GRANULE * PARTS;
  /** The creation of the escrow, below the bulk. */
  const CREATED_LEDGER = 20_999_500;
  /** The middle of the escrow's events in the second part: a marker there makes the page start inside the bulk. */
  const MID_LEDGER = BULK_BASES[1] + Math.floor(EVENTS_PER_PART / 8);

  let h: Harness;
  let api: ApiClient;
  /** The rows of the table before the bulk: the object rows of the mock ledgers (an escrow and two channel claims). */
  let seeded: number;

  /** The reads of a request on `object_changes`, told apart by what they read. */
  function readsByKind(reads: LoggedRead[]) {
    return {
      page: reads.filter((r) => r.query.includes('AS distinct_page_read')),
      creation: reads.filter((r) => r.query.includes("action = 'created'")),
      known: reads.filter((r) => r.query.startsWith('SELECT ledger_index FROM')),
    };
  }

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    const [before] = await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.ObjectChanges}`);
    seeded = Number(before.n);
    const fields = jsonOf({ Account: OWNER, Amount: '1000000', Destination: COUNTERPARTY, Sequence: 1 });
    // one real row is the template of the bulk (a change of a made-up escrow, in a ledger between the mock ledgers) and one
    // is the creation of the escrow under test
    await insertObjects(h, [
      objectRow({
        object_type: 'Escrow',
        object_id: TEMPLATE,
        ledger_index: 20_999_000,
        tx_index: 1,
        tx_type: 'Payment',
        action: 'modified',
        event: 'update',
        fields,
      }),
      objectRow({ object_type: 'Escrow', object_id: ESCROW, ledger_index: CREATED_LEDGER, tx_index: 0, fields }),
    ]);
    const template = `SELECT * FROM ${Table.ObjectChanges} WHERE object_id = {template:String} LIMIT 1`;
    for (const [id, perPart] of [
      [BEFORE, OTHERS_PER_PART],
      [ESCROW, EVENTS_PER_PART],
      [AFTER, OTHERS_PER_PART],
    ] as const) {
      await insertBulk(
        h,
        Table.ObjectChanges,
        template,
        { template: TEMPLATE, id },
        // the first digit of the escrow in its transaction hash: a page of another escrow's rows would show. The rows of the
        // other escrows are creations (`action`), so a read of `action = 'created'` that is not bound by the escrow's key reads
        // them all: with only `modified` rows ClickHouse prunes the parts by the column's min and max before the key looks at
        // the read, and the creation read touched about four rows whatever its WHERE said
        (base) =>
          `{id:String} AS object_id, ${bulkLedger(base)} AS ledger_index, ${BULK_TX_INDEX} AS tx_index, ` +
          `concat('bulk-', substring({id:String}, 1, 1)) AS tx_hash` +
          (id === ESCROW ? '' : ", 'created' AS action"),
        perPart,
      );
    }
  }, 600_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  /** The transactions of the events of an answer that are the bulk's: all of them are the escrow's. */
  const bulkHashes = (events: unknown): string[] =>
    (events as { tx_hash: string }[]).map((e) => e.tx_hash).filter((hash) => hash.startsWith('bulk-'));

  /**
   * The creation read goes through the prefix of the escrow from its start (the creation is the first row of an object): its
   * pipeline reads the table in the order of the key. A read in the reverse order (`algorithm: InReverseOrder`) walks from the
   * newest row back to the creation, the object's whole prefix on every call of a long-lived object, which the bound of rows alone
   * cannot tell here: the escrow has 10,000 rows and the bound allows more.
   */
  async function expectCreationFromTheStart(statements: [string, Record<string, unknown>][], label: string) {
    const creation = statements.filter(([sql]) => sql.includes("action = 'created'"));
    expect(creation).toHaveLength(1);
    const [sql, params] = creation[0];
    const pipeline = await explain(h, 'PIPELINE', sql, params);
    expect([label, pipeline.includes('algorithm: InOrder')]).toEqual([label, true]);
  }

  it('the seed is as assumed: 10,001 rows of the escrow in five parts, among the 800,000 rows of two other escrows', async () => {
    const [mine] = await h.ch.query<{ n: string; parts: string }>(
      `SELECT count() AS n, uniqExact(_part) AS parts FROM ${Table.ObjectChanges} WHERE object_id = {id:String}`,
      { id: ESCROW },
    );
    expect([Number(mine.n), Number(mine.parts)]).toEqual([ESCROW_ROWS, PARTS]);
    const [all] = await h.ch.query<{ n: string; partitions: string }>(
      `SELECT count() AS n, uniqExact(_partition_id) AS partitions FROM ${Table.ObjectChanges}`,
    );
    // the bulk of the other escrows is 800,000 rows (4 x 200,000) in the partition of the escrow
    expect([Number(all.n), Number(all.partitions)]).toEqual([seeded + ADDED_ROWS, 1]);
    expect(BULK_ROWS).toBe(800_000);
    // the bounds are far below the table: a read of the table, or of the type, fails them
    expect(PAGE_BOUND).toBeLessThan((seeded + ADDED_ROWS) / 8);
    expect(PREFIX_BOUND).toBeLessThan((seeded + ADDED_ROWS) / 8);
  });

  it('the detail reads the newest 51 rows (a granule of each part) and the creation (the prefix of the escrow), not the table', async () => {
    const path = `/v2/escrows/${ESCROW}`;
    const { reads, body } = await served(h, api, Table.ObjectChanges, path, 'escrow');
    const kinds = readsByKind(reads);
    expect([kinds.page.length, kinds.creation.length, kinds.known.length]).toEqual([1, 1, 0]);
    for (const read of kinds.page)
      expect([path, read.read_rows <= PAGE_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
    // the creation is older than the newest 51 rows: the prefix is read to find it
    for (const read of kinds.creation)
      expect([path, read.read_rows <= PREFIX_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
    // and the answer is whole: the creation was found, the page is the newest 50 of the escrow's rows and a marker for the rest
    expect((body.escrow as Record<string, unknown>).created).toMatchObject({ ledger_index: CREATED_LEDGER });
    expect([(body.history as unknown[]).length, body.history_marker === undefined]).toEqual([50, false]);
    expect(bulkHashes(body.history)).toHaveLength(50);
  });

  it('the page of the detail is read in the reverse order of the key and stops after its rows, the creation from the start of the key', async () => {
    const path = `/v2/escrows/${ESCROW}`;
    const { statements } = await served(h, api, Table.ObjectChanges, path, 'escrow');
    const page = statements.filter(([sql]) => isPageRead(sql));
    expect(page).toHaveLength(1);
    await expectBoundedInOrderRead(h, page[0][0], page[0][1], true, path);
    await expectCreationFromTheStart(statements, path);
  });

  it('the lookup by ID is one read of the newest row, in the reverse order of the key: a granule of each part, not the 10,001 rows', async () => {
    const path = `/v2/ledger_objects/${ESCROW}`;
    const { reads, statements, body } = await served(h, api, Table.ObjectChanges, path, 'ledger_object');
    // the escrow's rows are in five parts of a partition that holds 810,000 rows: a granule of each part and a few more
    expect(reads).toHaveLength(1);
    expect([path, reads[0].read_rows <= PAGE_BOUND ? 'bounded' : reads[0].read_rows]).toEqual([path, 'bounded']);
    // and the answer is the escrow's newest row: the last event of the last part
    expect(body.ledger_object).toEqual({
      object_id: ESCROW,
      object_type: 'Escrow',
      account: OWNER,
      deleted: false,
      ledger_index: BULK_BASES[3] + Math.floor((EVENTS_PER_PART - 1) / 4),
    });
    // the read is the newest row of the object by the whole key backwards, which stops after its row
    expect(statements).toHaveLength(1);
    const [sql, params] = statements[0];
    expect(sql).not.toMatch(/\bFINAL\b/i);
    expect(await explain(h, 'PIPELINE', sql, params)).toContain('InReverseOrder');
    expect(await tableReads(h, sql, params)).toEqual([expect.objectContaining({ readType: 'InReverseOrder' })]);
    // the type and the id narrow the read to the escrow's rows: a few granules of the table's
    const [primary] = primaryKeys(await explain(h, 'indexes = 1', sql, params));
    expect(primary.keys.slice(0, 3)).toEqual(['object_type', 'object_id', 'ledger_index']);
    expect(primary.condition).toContain(`object_id in ['${ESCROW}'`);
    expect(primary.granules[0]).toBeLessThan(primary.granules[1] / 4);
  });

  describe.each([false, true])('descending=%s', (descending) => {
    const pageOf = (limit: number, marker?: (string | number)[]): string =>
      `/v2/escrows/${ESCROW}/history?limit=${limit}&descending=${descending}${marker === undefined ? '' : `&marker=${markerOf(marker)}`}`;

    it.each([
      ['the first page', undefined],
      ['a page that starts inside the bulk', [MID_LEDGER, 1]],
      ['a page near the start of the range', [BULK_BASES[0] + 100, 2]],
    ] as const)('a page of 200 events (%s) reads about a granule of each part, and is whole', async (_name, marker) => {
      const path = pageOf(200, marker as (string | number)[] | undefined);
      const { reads, body } = await served(h, api, Table.ObjectChanges, path, 'history');
      const kinds = readsByKind(reads);
      expect([path, kinds.page.length, kinds.creation.length, kinds.known.length]).toEqual([
        path,
        1,
        1,
        marker === undefined ? 0 : 1,
      ]);
      for (const read of kinds.page)
        expect([path, read.read_rows <= PAGE_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
      // the creation and the existence read are the prefix of the escrow
      for (const read of [...kinds.creation, ...kinds.known]) {
        expect([path, read.read_rows <= PREFIX_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
      }
      expect([path, (body.history as unknown[]).length, body.marker === undefined]).toEqual([path, 200, false]);
      // every event is the escrow's (the other escrows share its ledgers), but its creation
      expect(bulkHashes(body.history).length).toBeGreaterThanOrEqual(199);
    });

    it.each([
      ['the first page', undefined],
      ['a page that starts inside the bulk', [MID_LEDGER, 1]],
    ] as const)(
      'the page read of %s is read in the order of the key, stops after its rows, and the other reads are the prefix of the escrow',
      async (_name, marker) => {
        const path = pageOf(200, marker as (string | number)[] | undefined);
        const { statements } = await served(h, api, Table.ObjectChanges, path, 'history');
        const page = statements.filter(([sql]) => isPageRead(sql));
        expect(page).toHaveLength(1);
        const [sql, params] = page[0];
        await expectBoundedInOrderRead(h, sql, params, descending, path);
        expect(sql).not.toMatch(/\bFINAL\b/i);
        // the primary key narrows the read to the escrow and its ledgers: a few granules out of those of the table
        const [primary] = primaryKeys(await explain(h, 'indexes = 1', innerRead(sql), params));
        expect(primary.keys).toEqual(['object_type', 'object_id', 'ledger_index']);
        expect(primary.condition).toContain(`object_id in ['${ESCROW}'`);
        expect(primary.granules[0]).toBeLessThan(primary.granules[1] / 4);
        // the creation (and with a marker the existence read) narrow by the type and the id the same way: the prefix of the escrow
        const others = statements.filter(([text]) => !isPageRead(text));
        expect(others).toHaveLength(marker === undefined ? 1 : 2);
        for (const [other, otherParams] of others) {
          const [narrowed] = primaryKeys(await explain(h, 'indexes = 1', other, otherParams));
          expect(narrowed.keys.slice(0, 2)).toEqual(['object_type', 'object_id']);
          expect(narrowed.condition).toContain(`object_id in ['${ESCROW}'`);
          // the parts of the two other escrows hold creations, so the creation read cannot skip them by the column's range:
          // the key is what keeps it off their 800,000 rows
          expect(narrowed.granules[0]).toBeLessThan(narrowed.granules[1] / 4);
        }
        // and the creation is read from the start of the escrow's rows
        await expectCreationFromTheStart(statements, path);
      },
    );
  });
});

describe('the detail of a payment channel reads the granules of a page, its creation and the rows of the channel for its counts, not the 810,000 rows of the table (read_rows over a bulk of four parts)', () => {
  // The same shape as the escrow's above: the rows of an object are a range of the primary key of `object_changes` (its type and
  // id, then its ledgers). The channel has 10,000 events, 2,500 in each of four parts (one in 500 a `fund`, the others claims
  // that moved the balance), and its creation in a part of its own. Two other channels, one that sorts before it and one after
  // it, have 100,000 creations in each of four parts of their own, in the same partition: the counts, which read the channel's
  // whole prefix, and the creation read are bound by its key, and a read that did not use the object would read the 810,000 rows
  // of the table.
  const CHANNEL = '5'.repeat(64);
  const BEFORE = '4'.repeat(64);
  const AFTER = '6'.repeat(64);
  const TEMPLATE = '3'.repeat(64);
  const EVENTS_PER_PART = 2_500;
  const FUND_EVERY = 500;
  const OTHERS_PER_PART = 100_000;
  const GRANULE = 8192;
  /** The parts that hold rows of the channel: the four of the bulk and the one with its creation. */
  const PARTS = BULK_BASES.length + 1;
  const CHANNEL_ROWS = BULK_BASES.length * EVENTS_PER_PART + 1;
  /** What the counts must say: five funds a part, every other event of the bulk a claim. */
  const FUNDS = (BULK_BASES.length * EVENTS_PER_PART) / FUND_EVERY;
  const CLAIMS = BULK_BASES.length * EVENTS_PER_PART - FUNDS;
  const ADDED_ROWS = BULK_BASES.length * (EVENTS_PER_PART + 2 * OTHERS_PER_PART) + 2;
  /** A page touches about a granule of each part that holds the channel, and one more for the part's partial granule. */
  const PAGE_BOUND = (PARTS + 1) * GRANULE;
  /** The counts and the creation read the prefix of the channel and nothing else: its rows and two granules a part. */
  const PREFIX_BOUND = CHANNEL_ROWS + 2 * GRANULE * PARTS;
  const CREATED_LEDGER = 20_999_500;

  let h: Harness;
  let api: ApiClient;
  let seeded: number;

  /** The reads of a request on `object_changes`, told apart by what they read. */
  function readsByKind(reads: LoggedRead[]) {
    return {
      page: reads.filter((r) => r.query.includes('AS distinct_page_read')),
      creation: reads.filter((r) => r.query.includes("action = 'created'")),
      counts: reads.filter((r) => r.query.includes('countIf')),
    };
  }

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    const [before] = await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.ObjectChanges}`);
    seeded = Number(before.n);
    const fields = jsonOf({
      Account: OWNER,
      Amount: '1000000',
      Balance: '1',
      Destination: COUNTERPARTY,
      PublicKey: `ED${'7'.repeat(64)}`,
      SettleDelay: 86_400,
      Sequence: 1,
    });
    await insertObjects(h, [
      objectRow({
        object_type: 'PayChannel',
        object_id: TEMPLATE,
        ledger_index: 20_999_000,
        tx_index: 1,
        tx_type: 'PaymentChannelClaim',
        action: 'modified',
        event: 'claim',
        fields,
        previous: jsonOf({ Balance: '0' }),
      }),
      objectRow({
        object_type: 'PayChannel',
        object_id: CHANNEL,
        ledger_index: CREATED_LEDGER,
        tx_index: 0,
        tx_type: 'PaymentChannelCreate',
        fields,
      }),
    ]);
    const template = `SELECT * FROM ${Table.ObjectChanges} WHERE object_id = {template:String} LIMIT 1`;
    for (const [id, perPart] of [
      [BEFORE, OTHERS_PER_PART],
      [CHANNEL, EVENTS_PER_PART],
      [AFTER, OTHERS_PER_PART],
    ] as const) {
      await insertBulk(
        h,
        Table.ObjectChanges,
        template,
        { template: TEMPLATE, id },
        // the other channels' rows are creations (see the escrow's bulk above); the channel's are funds and claims
        (base) =>
          `{id:String} AS object_id, ${bulkLedger(base)} AS ledger_index, ${BULK_TX_INDEX} AS tx_index, ` +
          `concat('bulk-', substring({id:String}, 1, 1)) AS tx_hash` +
          (id === CHANNEL
            ? `, if(n.number % ${FUND_EVERY} = 0, 'fund', 'claim') AS event` +
              `, if(n.number % ${FUND_EVERY} = 0, '{"Amount":"999999"}', '{"Balance":"0"}') AS previous`
            : ", 'created' AS action"),
        perPart,
      );
    }
  }, 600_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the seed is as assumed: 10,001 rows of the channel in five parts, among the 800,000 rows of two other channels', async () => {
    const [mine] = await h.ch.query<{ n: string; parts: string; funds: string; claims: string }>(
      `SELECT count() AS n, uniqExact(_part) AS parts, countIf(event = 'fund') AS funds,
              countIf(JSONHas(previous, 'Balance')) AS claims
         FROM ${Table.ObjectChanges} WHERE object_id = {id:String}`,
      { id: CHANNEL },
    );
    expect([Number(mine.n), Number(mine.parts), Number(mine.funds), Number(mine.claims)]).toEqual([
      CHANNEL_ROWS,
      PARTS,
      FUNDS,
      CLAIMS,
    ]);
    const [all] = await h.ch.query<{ n: string; partitions: string }>(
      `SELECT count() AS n, uniqExact(_partition_id) AS partitions FROM ${Table.ObjectChanges}`,
    );
    expect([Number(all.n), Number(all.partitions)]).toEqual([seeded + ADDED_ROWS, 1]);
    // the bounds are far below the table: a read of the table, or of the type, fails them
    expect(PAGE_BOUND).toBeLessThan((seeded + ADDED_ROWS) / 8);
    expect(PREFIX_BOUND).toBeLessThan((seeded + ADDED_ROWS) / 8);
  });

  it('the detail reads the newest 51 rows, the creation and the counts, none of them more than the prefix of the channel', async () => {
    const path = `/v2/payment_channels/${CHANNEL}`;
    const { reads, statements, body } = await served(h, api, Table.ObjectChanges, path, 'payment_channel');
    const kinds = readsByKind(reads);
    expect([kinds.page.length, kinds.creation.length, kinds.counts.length]).toEqual([1, 1, 1]);
    for (const read of kinds.page)
      expect([path, read.read_rows <= PAGE_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
    // the counts read the whole prefix of the channel (its rows and two granules a part), and nothing of the other channels
    for (const read of [...kinds.creation, ...kinds.counts])
      expect([path, read.read_rows <= PREFIX_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
    expect(kinds.counts[0].read_rows).toBeGreaterThanOrEqual(CHANNEL_ROWS);
    // and the answer is whole: the counts are of the 10,001 events, the creation was found, the page is the newest 50
    const channel = body.payment_channel as Record<string, unknown>;
    expect([channel.funds, channel.claims]).toEqual([FUNDS, CLAIMS]);
    expect(channel.created).toMatchObject({ ledger_index: CREATED_LEDGER });
    expect([(body.history as unknown[]).length, body.history_marker === undefined]).toEqual([50, false]);

    // the page is read in the reverse order of the key; the creation from the start of it (an object's first row)
    const page = statements.filter(([sql]) => isPageRead(sql));
    expect(page).toHaveLength(1);
    await expectBoundedInOrderRead(h, page[0][0], page[0][1], true, path);
    const [creationSql, creationParams] = statements.filter(([sql]) => sql.includes("action = 'created'"))[0];
    expect(await explain(h, 'PIPELINE', creationSql, creationParams)).toContain('algorithm: InOrder');
    // the counts and the creation narrow by the type and the id: the prefix of the channel, a few granules of the table's
    for (const [sql, params] of statements.filter(([text]) => !isPageRead(text))) {
      const [narrowed] = primaryKeys(await explain(h, 'indexes = 1', sql, params));
      expect(narrowed.keys.slice(0, 2)).toEqual(['object_type', 'object_id']);
      expect(narrowed.condition).toContain(`object_id in ['${CHANNEL}'`);
      expect(narrowed.granules[0]).toBeLessThan(narrowed.granules[1] / 4);
    }
    const counts = statements.filter(([sql]) => sql.includes('countIf'));
    expect(counts).toHaveLength(1);
    expect(counts[0][0]).not.toMatch(/\bFINAL\b/i);
  });

  it.each([false, true])(
    'the first page of the history (descending=%s) is read in the order of the key',
    async (descending) => {
      const path = `/v2/payment_channels/${CHANNEL}/history?limit=200&descending=${descending}`;
      const { reads, statements, body } = await served(h, api, Table.ObjectChanges, path, 'history');
      const kinds = readsByKind(reads);
      // the history reads no counts: the page and the creation
      expect([kinds.page.length, kinds.creation.length, kinds.counts.length]).toEqual([1, 1, 0]);
      for (const read of kinds.page)
        expect([path, read.read_rows <= PAGE_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
      for (const read of kinds.creation)
        expect([path, read.read_rows <= PREFIX_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
      expect([(body.history as unknown[]).length, body.marker === undefined]).toEqual([200, false]);
      const page = statements.filter(([sql]) => isPageRead(sql));
      expect(page).toHaveLength(1);
      await expectBoundedInOrderRead(h, page[0][0], page[0][1], descending, path);
    },
  );
});

describe("the delegations of an account read the account's prefix of account_object_changes and the rows of its IDs, not the millions of rows beside them (read_rows over a bulk of four parts)", () => {
  // The IDs of the delegations an account gave are the `(account, 'Delegate', role)` prefix of `account_object_changes`, a range of its
  // primary key, and the rows of those IDs are `(object_type, object_id)` ranges of `object_changes`. The account has 20 delegations of 20
  // rows each, 5 of each in each of four parts. Beside them, in the same partition: the delegations of two other accounts, one that
  // sorts before it and one after it (200,000 index rows a part each), the account's own rows as the one that holds a delegation
  // (50,000 a part, after its own in the key), and in `object_changes` the 200,000 rows a part of two other IDs, one before its IDs and
  // one after them. A read that did not use the account, the type, the role or the IDs would read the 1.8 million rows of the index
  // or the 1.6 million of the objects.
  const ACCOUNT = accountAt(0xd660);
  /** The owner of the template rows of the index, an account no test reads (the rows are copied from it). */
  const TEMPLATE_OWNER = 'zTemplateOwner';
  const BEFORE_ACCOUNT = 'qBefore';
  const AFTER_ACCOUNT = 'sAfter';
  const TEMPLATE = '3'.repeat(64);
  const BEFORE = '4'.repeat(64);
  const AFTER = '6'.repeat(64);
  const IDS = 20;
  const ROWS_PER_PART = 100;
  const HELD_PER_PART = 50_000;
  const GRANULE = 8192;
  /** The parts that hold rows of the account's delegations. */
  const PARTS = BULK_BASES.length;
  const ACCOUNT_ROWS = PARTS * ROWS_PER_PART;
  /** Its own rows and two granules a part: the prefix of the index, or the ranges of the IDs. */
  const PREFIX_BOUND = ACCOUNT_ROWS + 2 * GRANULE * PARTS;
  const idOf = (k: number): string => '5'.repeat(60) + k.toString(16).toUpperCase().padStart(4, '0');
  const ids = Array.from({ length: IDS }, (_, k) => idOf(k));

  let h: Harness;
  let api: ApiClient;
  /** The rows of the tables before the bulks: what the mock ledgers and the templates hold. */
  let indexSeeded: number;
  let objectsSeeded: number;

  const countOf = async (table: Table): Promise<number> =>
    Number((await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${table}`))[0].n);

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    // one real row of each table is the template of its bulks: a Delegate of the account (a made-up ID, in a ledger between the mock
    // ledgers), and the two rows of the index of an account no test reads
    await h.ch.insert(Table.ObjectChanges, [
      objectRow({
        object_type: 'Delegate',
        object_id: TEMPLATE,
        ledger_index: 20_999_000,
        tx_index: 1,
        tx_type: 'DelegateSet',
        action: 'modified',
        event: 'set',
        owner: ACCOUNT,
        counterparty: COUNTERPARTY,
        fields: jsonOf({
          Account: ACCOUNT,
          Authorize: COUNTERPARTY,
          Permissions: [{ Permission: { PermissionValue: 'Payment' } }],
        }),
      }),
    ]);
    await h.ch.insert(
      Table.AccountObjectChanges,
      (['owner', 'counterparty'] as const).map((role) => ({
        account: TEMPLATE_OWNER,
        object_type: 'Delegate',
        role,
        ledger_index: 20_999_000,
        tx_index: 1,
        object_id: TEMPLATE,
        action: 'modified' as const,
      })),
    );
    indexSeeded = await countOf(Table.AccountObjectChanges);
    objectsSeeded = await countOf(Table.ObjectChanges);

    const objectTemplate = `SELECT * FROM ${Table.ObjectChanges} WHERE object_id = {template:String} LIMIT 1`;
    const indexTemplate = (role: string): string =>
      `SELECT * FROM ${Table.AccountObjectChanges} WHERE account = {template_owner:String} AND role = '${role}' LIMIT 1`;
    // the n-th row of a part: the IDs take turns, and the first row of each ID in a part is a creation
    const own = `concat(repeat('5', 60), lpad(hex(n.number % ${IDS}), 4, '0'))`;
    const ownAction = `if(n.number < ${IDS}, 'created', 'modified')`;
    const place = (base: number): string => `${bulkLedger(base)} AS ledger_index, ${BULK_TX_INDEX} AS tx_index`;
    const owned = { template: TEMPLATE, template_owner: TEMPLATE_OWNER, account: ACCOUNT };

    // the account's delegations: the same rows in both tables
    await insertBulk(
      h,
      Table.AccountObjectChanges,
      indexTemplate('owner'),
      owned,
      (base) => `{account:String} AS account, ${own} AS object_id, ${place(base)}, ${ownAction} AS action`,
      ROWS_PER_PART,
    );
    await insertBulk(
      h,
      Table.ObjectChanges,
      objectTemplate,
      owned,
      (base) => `${own} AS object_id, ${place(base)}, ${ownAction} AS action`,
      ROWS_PER_PART,
    );
    // beside them: the delegations of two other accounts in the index, the account's own rows as the holder of one, and the objects
    // of two other IDs (creations, so that a read of `action = 'created'` that the IDs do not bound reads them all)
    for (const account of [BEFORE_ACCOUNT, AFTER_ACCOUNT]) {
      await insertBulk(
        h,
        Table.AccountObjectChanges,
        indexTemplate('owner'),
        { ...owned, account },
        (base) => `{account:String} AS account, ${place(base)}`,
        BULK_PER_PART,
      );
    }
    await insertBulk(
      h,
      Table.AccountObjectChanges,
      indexTemplate('counterparty'),
      owned,
      (base) => `{account:String} AS account, ${place(base)}`,
      HELD_PER_PART,
    );
    for (const id of [BEFORE, AFTER]) {
      await insertBulk(
        h,
        Table.ObjectChanges,
        objectTemplate,
        { ...owned, id },
        (base) => `{id:String} AS object_id, ${place(base)}, 'created' AS action`,
        BULK_PER_PART,
      );
    }
  }, 600_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  /** The SELECTs of a request on a table: what each read, and the SQL with its params. */
  const through = (table: Table, path: string) => served(h, api, table, path, 'delegations');

  it('the seed is as assumed: 400 rows of the account in the index and in the objects, among millions of other rows', async () => {
    const [mine] = await h.ch.query<{ n: string; parts: string; ids: string }>(
      `SELECT count() AS n, uniqExact(_part) AS parts, uniqExact(object_id) AS ids FROM ${Table.AccountObjectChanges}
        WHERE account = {account:String} AND role = 'owner'`,
      { account: ACCOUNT },
    );
    expect([Number(mine.n), Number(mine.parts), Number(mine.ids)]).toEqual([ACCOUNT_ROWS, PARTS, IDS]);
    const [objects] = await h.ch.query<{ n: string; parts: string }>(
      `SELECT count() AS n, uniqExact(_part) AS parts FROM ${Table.ObjectChanges} WHERE object_id IN ({ids:Array(String)})`,
      { ids },
    );
    expect([Number(objects.n), Number(objects.parts)]).toEqual([ACCOUNT_ROWS, PARTS]);
    // the bulks: 2 x 800,000 index rows of other accounts, 200,000 of the account as a holder, and 2 x 800,000 object rows
    expect(await countOf(Table.AccountObjectChanges)).toBe(
      indexSeeded + ACCOUNT_ROWS + 2 * BULK_ROWS + BULK_BASES.length * HELD_PER_PART,
    );
    expect(await countOf(Table.ObjectChanges)).toBe(objectsSeeded + ACCOUNT_ROWS + 2 * BULK_ROWS);
    // the bound is far below the table, and below one part of a bulk
    expect(PREFIX_BOUND).toBeLessThan(BULK_PER_PART / 2);
  });

  it("the IDs are the account's prefix of the index and the rows of the IDs are read twice, each bounded by the rows they name", async () => {
    const path = `/v2/accounts/${ACCOUNT}/delegations`;
    const index = await through(Table.AccountObjectChanges, path);
    expect(index.reads).toHaveLength(1);
    expect([path, index.reads[0].read_rows <= PREFIX_BOUND ? 'bounded' : index.reads[0].read_rows]).toEqual([
      path,
      'bounded',
    ]);
    const objects = await through(Table.ObjectChanges, path);
    // the newest row of each ID, and the newest creation of each
    expect(objects.reads).toHaveLength(2);
    for (const read of objects.reads) {
      expect([path, read.read_rows <= PREFIX_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
      expect(read.read_rows).toBeGreaterThanOrEqual(ACCOUNT_ROWS);
    }
    expect(objects.statements.map(([sql]) => sql.includes("action = 'created'"))).toEqual([false, true]);
    // and the answer is whole: the 20 delegations, from the newest part
    const body = objects.body;
    expect([body.count, body.marker]).toEqual([IDS, undefined]);
    const listed = body.delegations as {
      delegation_id: string;
      updated: { ledger_index: number };
      created: { ledger_index: number };
    }[];
    expect(new Set(listed.map((d) => d.delegation_id))).toEqual(new Set(ids));
    for (const d of listed) {
      expect([d.updated.ledger_index >= BULK_BASES[3], d.created.ledger_index >= BULK_BASES[3]]).toEqual([true, true]);
    }
  });

  it('the plans narrow by the account, the type and the role in the index, and by the type and the IDs in the objects', async () => {
    const path = `/v2/accounts/${ACCOUNT}/delegations`;
    const index = await through(Table.AccountObjectChanges, path);
    expect(index.statements).toHaveLength(1);
    const [indexSql, indexParams] = index.statements[0];
    expect(indexSql).not.toMatch(/\bFINAL\b/i);
    const [byAccount] = primaryKeys(await explain(h, 'indexes = 1', indexSql, indexParams));
    expect(byAccount.keys.slice(0, 4)).toEqual(['account', 'object_type', 'role', 'ledger_index']);
    expect(byAccount.condition).toContain(`account in ['${ACCOUNT}'`);
    expect(byAccount.condition).toContain('role in [');
    expect(byAccount.granules[0]).toBeLessThan(byAccount.granules[1] / 8);

    const objects = await through(Table.ObjectChanges, path);
    for (const [sql, params] of objects.statements) {
      expect(sql).not.toMatch(/\bFINAL\b/i);
      const [byIds] = primaryKeys(await explain(h, 'indexes = 1', sql, params));
      expect(byIds.keys.slice(0, 2)).toEqual(['object_type', 'object_id']);
      expect(byIds.condition).toContain('object_id in');
      expect(byIds.granules[0]).toBeLessThan(byIds.granules[1] / 8);
    }
  });

  it('the account as the holder is the other prefix of the index: its 200,000 rows, bounded by the key and not by the owner rows', async () => {
    // the account holds one delegation, changed 200,000 times: the ID read stops at the end of that prefix (its rows, and two granules
    // a part of the tail), and it is the one read of the index; the owner direction above did not read these rows
    const path = `/v2/accounts/${ACCOUNT}/delegations?direction=held`;
    const index = await through(Table.AccountObjectChanges, path);
    expect(index.reads).toHaveLength(1);
    expect(index.reads[0].read_rows).toBeLessThanOrEqual(BULK_BASES.length * HELD_PER_PART + 2 * GRANULE * PARTS);
    expect(index.body.count).toBe(1);
  });
});
