/**
 * Seeds ClickHouse with synthetic data so the API can be load-tested with realistic
 * row counts. Uses the built shared ClickHouse client (run `pnpm build` first).
 *
 *   GH_CLICKHOUSE_URL=http://localhost:8123 node load/seed.js 2000000
 *
 * The single arg is the number of payments to insert (default 1,000,000). It also
 * seeds proportional exchanges so candle/volume endpoints have data.
 */
const { ClickHouseService } = require('../packages/shared/dist/clickhouse/clickhouse.service');
const { clickHouseConfigFromEnv } = require('../packages/shared/dist/clickhouse/clickhouse.config');
const { Table } = require('../packages/shared/dist/clickhouse/tables');

const TOTAL = Number(process.argv[2] || 1_000_000);
const BATCH = 50_000;
const CURRENCIES = ['XRP', 'USD', 'EUR', 'BTC', 'ETH'];
const ISSUERS = ['', 'rIssuer1', 'rIssuer2', 'rIssuer3', 'rIssuer4'];
const ACCOUNTS = Array.from({ length: 5000 }, (_, i) => `rAcct${i}`);
const DAY_MS = 86_400_000;
const START = Date.UTC(2023, 0, 1);

function dt(ms) {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

async function main() {
  const svc = new ClickHouseService(clickHouseConfigFromEnv());
  console.log(`Seeding ${TOTAL.toLocaleString()} payments + exchanges…`);
  const start = Date.now();
  let ledger = 80_000_000;

  for (let offset = 0; offset < TOTAL; offset += BATCH) {
    const n = Math.min(BATCH, TOTAL - offset);
    const payments = [];
    const exchanges = [];
    for (let i = 0; i < n; i++) {
      const g = offset + i;
      const ci = g % CURRENCIES.length;
      const date = dt(START + (g % 600) * DAY_MS + (g % 86_400) * 1000);
      ledger++;
      payments.push({
        ctid: `C${ledger.toString(16).padStart(7, '0')}${(i % 1000).toString(16).padStart(4, '0')}0000`,
        tx_hash: `H${g}`,
        source: ACCOUNTS[g % ACCOUNTS.length],
        destination: ACCOUNTS[(g * 7) % ACCOUNTS.length],
        currency: CURRENCIES[ci],
        issuer: ISSUERS[ci],
        amount: (g % 1000) + 1,
        delivered_amount: (g % 1000) + 1,
        fee: 0.00001,
        date,
        ledger_index: ledger,
        tx_index: i % 1000,
      });
      if (g % 3 === 0) {
        exchanges.push({
          tx_hash: `EX${g}`,
          node_index: 0,
          base_currency: 'USD',
          base_issuer: 'rIssuer1',
          base_amount: (g % 100) + 1,
          counter_currency: 'XRP',
          counter_issuer: '',
          counter_amount: ((g % 100) + 1) * 2,
          rate: 2,
          buyer: ACCOUNTS[g % ACCOUNTS.length],
          seller: ACCOUNTS[(g * 3) % ACCOUNTS.length],
          taker: ACCOUNTS[g % ACCOUNTS.length],
          provider: 'rProv',
          sequence: g,
          date,
          tx_type: 'OfferCreate',
          tx_index: i % 1000,
          ledger_index: ledger,
        });
      }
    }
    await svc.insert(Table.Payments, payments);
    if (exchanges.length) await svc.insert(Table.Exchanges, exchanges);
    const done = offset + n;
    const rate = Math.round(done / ((Date.now() - start) / 1000));
    console.log(`  ${done.toLocaleString()}/${TOTAL.toLocaleString()} (${rate.toLocaleString()} rows/s)`);
  }

  await svc.onModuleDestroy();
  console.log(`Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
