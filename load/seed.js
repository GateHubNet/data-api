/**
 * Seeds a ClickHouse database with SYNTHETIC ledgers so the API can be load-tested with realistic row counts and without a
 * rippled node. It writes the tables the endpoints read, in the order the syncer's `LedgerWriter` does (child tables first,
 * `ledger_by_hash`, then `ledgers`, the commit marker), plus `stats_hourly` and `fee_stats`:
 *
 *   ledgers, ledger_by_hash, transactions, tx_by_hash, tx_by_type, account_transactions, account_tx_by_sequence,
 *   payments, payments_by_currency, account_payments, exchanges, account_exchanges, balance_changes,
 *   stats_hourly (hours of the synthetic window), fee_stats (one snapshot every 5 s)
 *
 * Not seeded: accounts_created, validations, volume_live / volume_daily (the aggregator writes those; run a syncer against
 * the database, or accept empty volumes).
 *
 * Use a THROWAWAY database, never one a live syncer writes to (the ledgers are synthetic, and a live syncer owns everything
 * above its checkpoint). Build first (`pnpm build`: the seeder uses the compiled shared package), then:
 *
 *   docker compose up -d clickhouse
 *   export GH_NETWORK=xrpl GH_CLICKHOUSE_DATABASE=loadtest GH_CLICKHOUSE_URL=http://localhost:8123
 *   pnpm ch:migrate                                  # creates the `loadtest` database with the real schema
 *   node load/seed.js 20000 10                       # 20,000 ledgers x 10 transactions  (usage below)
 *
 * Then run the API against the same database (`GH_CLICKHOUSE_DATABASE=loadtest`) and `k6 run load/api-load.js`.
 *
 *   node load/seed.js [ledgers=20000] [txPerLedger=10] [firstLedger=90000000]
 *
 * The ledgers end "now" (one every 4 s), so date windows relative to the present contain data. Every fifth transaction is an
 * OfferCreate that produces one exchange (USD/XRP or EUR/XRP of the issuer of load/api-load.js); the others are Payments in
 * XRP, USD, EUR or BTC. Accounts are valid classic addresses derived from a hash. The seeder refuses a database that already
 * has ledgers unless SEED_ALLOW_NONEMPTY=1.
 */
const { createHash } = require('node:crypto');
const path = require('node:path');

const { ClickHouseService, clickHouseConfigFromEnv, getNetworkProfile, Table } = require('../packages/shared/dist');
const { encodeAccountID } = require(
  require.resolve('ripple-address-codec', { paths: [path.join(__dirname, '..', 'apps', 'api')] }),
);

const LEDGERS = Number(process.argv[2] || 20_000);
const TX_PER_LEDGER = Number(process.argv[3] || 10);
const FIRST_LEDGER = Number(process.argv[4] || 90_000_000);
const CLOSE_INTERVAL = 4; // seconds between ledgers
const FLUSH_ROWS = 50_000;
const ACCOUNT_COUNT = 5000;
const FEE_DROPS = 12;

// The issuers of the shipped XRPL markets config (valid classic addresses).
const ISSUER_A = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
const ISSUER_B = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';

const sha = (text) => createHash('sha256').update(text).digest('hex').toUpperCase();
const accounts = Array.from({ length: ACCOUNT_COUNT }, (_, i) =>
  encodeAccountID(createHash('sha256').update(`load-seed-account:${i}`).digest().subarray(0, 20)),
);

if (!Number.isInteger(LEDGERS) || LEDGERS < 1 || !Number.isInteger(TX_PER_LEDGER) || TX_PER_LEDGER < 1) {
  console.error('usage: node load/seed.js [ledgers=20000] [txPerLedger=10] [firstLedger=90000000]');
  process.exit(2);
}

/** A decimal without float noise: 6 places, trailing zeros trimmed. */
const dec = (n) => String(Number(n.toFixed(6)));

async function main() {
  const profile = getNetworkProfile();
  const native = profile.nativeCurrency;
  const currencies = [
    { currency: native, issuer: '' },
    { currency: 'USD', issuer: ISSUER_A },
    { currency: 'EUR', issuer: ISSUER_A },
    { currency: 'BTC', issuer: ISSUER_B },
  ];

  const ch = new ClickHouseService(clickHouseConfigFromEnv());
  try {
    const [{ n }] = await ch.query('SELECT count() AS n FROM ledgers');
    if (Number(n) > 0 && process.env.SEED_ALLOW_NONEMPTY !== '1') {
      throw new Error(
        `The database already has ${n} ledgers. Seed a throwaway database (GH_CLICKHOUSE_DATABASE=loadtest), or set SEED_ALLOW_NONEMPTY=1.`,
      );
    }

    console.log(
      `Seeding ${LEDGERS.toLocaleString()} synthetic ledgers x ${TX_PER_LEDGER} transactions (${profile.name}, ledgers ${FIRST_LEDGER}..${FIRST_LEDGER + LEDGERS - 1}) ...`,
    );
    const started = Date.now();
    const lastLedger = FIRST_LEDGER + LEDGERS - 1;
    const lastClose = Math.floor(Date.now() / 1000);
    const closeOf = (ledger) => lastClose - (lastLedger - ledger) * CLOSE_INTERVAL;

    const buffers = {};
    const buf = (table) => (buffers[table] ??= []);
    let buffered = 0;
    let written = 0;
    const hours = new Map(); // hour start -> counters for stats_hourly

    async function flush() {
      if (buffered === 0) return;
      const children = Object.keys(buffers).filter((t) => t !== Table.LedgerByHash && t !== Table.Ledgers);
      await Promise.all(children.map((t) => ch.insert(t, buffers[t])));
      await ch.insert(Table.LedgerByHash, buffers[Table.LedgerByHash] ?? []);
      await ch.insert(Table.Ledgers, buffers[Table.Ledgers] ?? []); // the commit marker last
      written += buffered;
      for (const t of Object.keys(buffers)) delete buffers[t];
      buffered = 0;
    }
    const push = (table, row) => {
      buf(table).push(row);
      buffered++;
    };

    let parentHash = sha(`load-seed-ledger:${FIRST_LEDGER - 1}`);
    for (let ledger = FIRST_LEDGER; ledger <= lastLedger; ledger++) {
      const closeTime = closeOf(ledger);
      const ledgerHash = sha(`load-seed-ledger:${ledger}`);
      let payments = 0;
      let exchanges = 0;
      const typeCounts = {};

      for (let txIndex = 0; txIndex < TX_PER_LEDGER; txIndex++) {
        const g = (ledger - FIRST_LEDGER) * TX_PER_LEDGER + txIndex;
        const hash = sha(`load-seed-tx:${ledger}:${txIndex}`);
        const from = accounts[g % ACCOUNT_COUNT];
        const to = accounts[(g * 7 + 1) % ACCOUNT_COUNT];
        const sequence = Math.floor(g / ACCOUNT_COUNT) + 1;
        const isOffer = g % 5 === 4;
        const txType = isOffer ? 'OfferCreate' : 'Payment';
        typeCounts[txType] = (typeCounts[txType] ?? 0) + 1;

        const common = {
          Account: from,
          Fee: String(FEE_DROPS),
          Flags: 2147483648,
          Sequence: sequence,
          SigningPubKey: `02${sha(`pk:${from}`)}`,
          TxnSignature: sha(`sig:${hash}`) + sha(`sig2:${hash}`).slice(0, 8),
        };
        let txJson;

        if (isOffer) {
          const market = currencies[1 + (g % 2)]; // USD or EUR against the native currency
          const baseAmount = 1 + (g % 100);
          const rate = [0.5, 2, 2.5, 4][g % 4];
          const counterAmount = baseAmount * rate;
          exchanges++;
          txJson = {
            TransactionType: 'OfferCreate',
            ...common,
            TakerGets: String(Math.round(counterAmount * 1_000_000)),
            TakerPays: { currency: market.currency, issuer: market.issuer, value: String(baseAmount) },
          };
          const exchange = {
            base_currency: market.currency,
            base_issuer: market.issuer,
            counter_currency: native,
            counter_issuer: '',
            ledger_index: ledger,
            tx_index: txIndex,
            node_index: 0,
            tx_hash: hash,
            close_time: closeTime,
            base_amount: String(baseAmount),
            counter_amount: dec(counterAmount),
            base_amount_f: baseAmount,
            counter_amount_f: counterAmount,
            rate: dec(rate),
            rate_f: rate,
            buyer: from,
            seller: to,
            taker: from,
            provider: to,
            offer_sequence: sequence,
            autobridged_currency: null,
            autobridged_issuer: null,
            tx_type: 'OfferCreate',
            client: null,
          };
          push(Table.Exchanges, exchange);
          push(Table.AccountExchanges, { account: from, ...exchange });
          push(Table.AccountExchanges, { account: to, ...exchange });
        } else {
          const money = currencies[g % 5 === 0 ? 0 : g % currencies.length]; // XRP twice as often
          const value = 1 + (g % 1000);
          const amountText = String(value);
          const isNative = money.issuer === '';
          payments++;
          txJson = {
            TransactionType: 'Payment',
            ...common,
            Destination: to,
            Amount: isNative
              ? String(value * 1_000_000)
              : { currency: money.currency, issuer: money.issuer, value: amountText },
          };
          const counterparty = money.issuer;
          const feeText = dec(FEE_DROPS / 1_000_000);
          push(Table.Payments, {
            ledger_index: ledger,
            tx_index: txIndex,
            tx_hash: hash,
            close_time: closeTime,
            source: from,
            destination: to,
            currency: money.currency,
            issuer: money.issuer,
            amount: amountText,
            delivered_amount: amountText,
            delivered_amount_f: value,
            max_amount: null,
            source_currency: money.currency,
            source_tag: null,
            destination_tag: g % 3 === 0 ? 1000 + (g % 50) : null,
            invoice_id: null,
            fee: String(FEE_DROPS),
            source_balance_changes: JSON.stringify([{ counterparty, currency: money.currency, value: `-${amountText}` }]),
            destination_balance_changes: JSON.stringify([{ counterparty, currency: money.currency, value: amountText }]),
            client: null,
          });
          push(Table.PaymentsByCurrency, {
            currency: money.currency,
            issuer: money.issuer,
            ledger_index: ledger,
            tx_index: txIndex,
          });
          for (const [account, other, direction] of [
            [from, to, 'sent'],
            [to, from, 'received'],
          ]) {
            push(Table.AccountPayments, {
              account,
              ledger_index: ledger,
              tx_index: txIndex,
              tx_hash: hash,
              close_time: closeTime,
              direction,
              counterparty: other,
              currency: money.currency,
              issuer: money.issuer,
              delivered_amount: amountText,
              delivered_amount_f: value,
              source_tag: null,
              destination_tag: g % 3 === 0 ? 1000 + (g % 50) : null,
            });
          }
          const change = (account, nodeIndex, amountChange, type, currency, issuer) => ({
            account,
            ledger_index: ledger,
            tx_index: txIndex,
            node_index: nodeIndex,
            tx_hash: hash,
            close_time: closeTime,
            currency,
            counterparty: issuer,
            amount_change: amountChange,
            final_balance: '100000',
            final_balance_f: 100000,
            change_type: type,
            escrow_counterparty: null,
            escrow_balance_change: null,
            paychannel_counterparty: null,
            paychannel_fund_change: null,
            paychannel_fund_final_balance: null,
            paychannel_final_balance: null,
            paychannel_balance_change: null,
            client: null,
          });
          push(Table.BalanceChanges, change(from, -1, `-${feeText}`, 'transaction_cost', native, ''));
          push(Table.BalanceChanges, change(from, 0, `-${amountText}`, 'payment_source', money.currency, money.issuer));
          push(Table.BalanceChanges, change(to, 1, amountText, 'payment_destination', money.currency, money.issuer));
        }

        push(Table.Transactions, {
          ledger_index: ledger,
          tx_index: txIndex,
          hash,
          tx_type: txType,
          result: 'tesSUCCESS',
          account: from,
          sequence,
          fee: String(FEE_DROPS),
          close_time: closeTime,
          tx_json: JSON.stringify(txJson),
          meta_json: JSON.stringify({ AffectedNodes: [], TransactionIndex: txIndex, TransactionResult: 'tesSUCCESS' }),
        });
        push(Table.TxByHash, { hash, ledger_index: ledger, tx_index: txIndex });
        push(Table.TxByType, { tx_type: txType, ledger_index: ledger, tx_index: txIndex, result: 'tesSUCCESS' });
        push(Table.AccountTxBySequence, { account: from, sequence, ledger_index: ledger, tx_index: txIndex });
        for (const [account, initiator] of [
          [from, 1],
          [to, 0],
        ]) {
          push(Table.AccountTransactions, {
            account,
            ledger_index: ledger,
            tx_index: txIndex,
            tx_type: txType,
            result: 'tesSUCCESS',
            is_initiator: initiator,
            close_time: closeTime,
          });
        }
      }

      push(Table.LedgerByHash, { ledger_hash: ledgerHash, ledger_index: ledger });
      push(Table.Ledgers, {
        ledger_index: ledger,
        ledger_hash: ledgerHash,
        parent_hash: parentHash,
        account_hash: sha(`load-seed-account-hash:${ledger}`),
        transaction_hash: sha(`load-seed-tx-hash:${ledger}`),
        total_coins: '99987654321000000',
        close_time: closeTime,
        parent_close_time: closeTime - CLOSE_INTERVAL,
        close_time_resolution: 10,
        close_flags: 0,
        tx_count: TX_PER_LEDGER,
        type_counts: typeCounts,
        result_counts: { tesSUCCESS: TX_PER_LEDGER },
        payments_count: payments,
        exchanges_count: exchanges,
        accounts_created: 0,
        fee_total: String(FEE_DROPS * TX_PER_LEDGER),
        fee_min: String(FEE_DROPS),
        fee_max: String(FEE_DROPS),
        parser_version: 1,
      });
      parentHash = ledgerHash;

      const hour = Math.floor(closeTime / 3600) * 3600;
      const h = hours.get(hour) ?? {
        transaction_count: 0,
        payments_count: 0,
        exchanges_count: 0,
        ledger_count: 0,
        first_close_time: closeTime,
        last_close_time: closeTime,
        type_counts: {},
      };
      h.transaction_count += TX_PER_LEDGER;
      h.payments_count += payments;
      h.exchanges_count += exchanges;
      h.ledger_count += 1;
      h.last_close_time = closeTime;
      for (const [type, count] of Object.entries(typeCounts)) h.type_counts[type] = (h.type_counts[type] ?? 0) + count;
      hours.set(hour, h);

      if (buffered >= FLUSH_ROWS) {
        await flush();
        const done = ledger - FIRST_LEDGER + 1;
        console.log(`  ${done.toLocaleString()}/${LEDGERS.toLocaleString()} ledgers (${Math.round(written / ((Date.now() - started) / 1000)).toLocaleString()} rows/s)`);
      }
    }
    await flush();

    // Hourly stats (what the aggregator would write), and a fee snapshot every 5 s over the window.
    const version = Date.now();
    await ch.insert(
      Table.StatsHourly,
      [...hours.entries()].map(([hour, h]) => ({
        hour,
        transaction_count: h.transaction_count,
        payments_count: h.payments_count,
        exchanges_count: h.exchanges_count,
        accounts_created: 0,
        ledger_count: h.ledger_count,
        first_close_time: h.first_close_time,
        last_close_time: h.last_close_time,
        type_counts: h.type_counts,
        result_counts: { tesSUCCESS: h.transaction_count },
        version,
      })),
    );
    const fees = [];
    for (let ts = closeOf(FIRST_LEDGER); ts <= lastClose; ts += 5) {
      fees.push({
        ts: ts + 0.123, // seconds with a fraction: DateTime64(3) reads integers as seconds
        current_ledger_size: TX_PER_LEDGER,
        expected_ledger_size: 53,
        current_queue_size: 0,
        max_queue_size: 2000,
        pct_max_queue_size: 0,
        median_fee: '5000',
        minimum_fee: '10',
        open_ledger_fee: '10',
      });
    }
    for (let i = 0; i < fees.length; i += FLUSH_ROWS) await ch.insert(Table.FeeStats, fees.slice(i, i + FLUSH_ROWS));

    console.log(`Sample account for the load test: ${accounts[1]} (k6 ... -e ACCOUNT=${accounts[1]} -e FIRST_LEDGER=${FIRST_LEDGER} -e LEDGERS=${LEDGERS})`);
    console.log(
      `Done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${written.toLocaleString()} rows in ${LEDGERS.toLocaleString()} ledgers, ${hours.size} hourly stat rows, ${fees.length.toLocaleString()} fee snapshots.`,
    );
  } finally {
    await ch.onModuleDestroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
