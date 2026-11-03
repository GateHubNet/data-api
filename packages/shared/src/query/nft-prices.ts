import BigNumber from 'bignumber.js';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { AssetDay, DailyRates } from './daily-rates';

/**
 * The price of an NFT sale in the native currency (spec 3.3): the one conversion that the collections job, the `nft_volume`
 * metric, `/stats` and every sale's `converted_amount` use, so that a collection's volume is the same everywhere.
 *
 * A price in the native currency is itself. A price in an issued currency is divided by the asset's native rate of the sale's
 * UTC day (`DailyRates.rateRowsSql`: the day's `native_rates_daily` set, else computed on read) and rounded to 6 decimals.
 * A price with no rate that day has no converted value (`NULL`), not a zero, and neither has one of 1e30 native coins or more.
 */

/** A piece of SQL with the parameters it names: a subquery to splice into a statement, and what to bind for it. */
export interface SqlPart {
  sql: string;
  params: Record<string, unknown>;
}

/**
 * A converted price from this many native coins up has none: a `Decimal(38, 6)` holds less than 1e32 and ClickHouse throws, for
 * the whole statement, at a value that it cannot hold, so one sale of a worthless token (an amount up to 1e96 is valid on the
 * ledger, and so is a tiny rate) would fail every read that has it. The native currency's supply is 1e11.
 */
const NATIVE_PRICE_LIMIT = '1e30';

/** The asset-days of the issued prices of `sales`: what `DailyRates.rateRowsSql` has to find the rates of. */
async function assetDaysOf(ch: ClickHouseService, sales: SqlPart): Promise<AssetDay[]> {
  const rows = await ch.query<{ currency: string; amount_issuer: string; day_text: string }>(
    `SELECT DISTINCT currency, amount_issuer, toString(toDate(close_time, 'UTC')) AS day_text
       FROM (${sales.sql})
      WHERE amount_issuer != ''`,
    sales.params,
  );
  return rows.map((r) => ({ asset: { currency: r.currency, issuer: r.amount_issuer }, day: r.day_text }));
}

/**
 * The sales of `sales` with their price in the native currency. `sales` is a subquery of sale rows with at least `currency`,
 * `amount_issuer`, `close_time`, `amount` and `amount_f` (rows of `nft_sales`, each once: the caller's subquery is where a
 * sale that was written twice is read once). The answer is a subquery in its turn: every column of `sales`, plus
 * `converted_native` `Nullable(Decimal(38, 6))` and `converted_native_f` `Nullable(Float64)`, and the parameters of `sales`
 * with those of the rates (prefixed `dr_`).
 *
 * The quotient is rounded to 6 places as a Float64, and the Decimal is read from the shortest round-trip text of that
 * (`toString`): ClickHouse converts a Float64 to a Decimal by truncating `x * 10^6`, which for 1.3 % of the multiples of 1e-6
 * lands just under the integer and gives the place below (0.498 / 1000 is 0.000497, 65.477876 is 65.477875), and in a
 * large value gives the digits of the binary fraction (4e19 is 40000000000000003625.904556).
 *
 * This is a call, not a constant: it first reads the asset-days of the issued prices of `sales`, then their rates through
 * `DailyRates.rateRowsSql`, whose rows the SQL it returns joins. A price in the native currency (an empty `amount_issuer`)
 * is `amount` as it is.
 */
export async function nftSalesNativeSql(ch: ClickHouseService, rates: DailyRates, sales: SqlPart): Promise<SqlPart> {
  const rateRows = await rates.rateRowsSql(await assetDaysOf(ch, sales));
  return {
    sql: `SELECT s.*,
       if(s.amount_issuer = '', toDecimal128OrNull(s.amount, 6),
          if(r.rate_f > 0 AND s.amount_f / r.rate_f < ${NATIVE_PRICE_LIMIT}, toDecimal128(toString(round(s.amount_f / r.rate_f, 6)), 6), NULL)) AS converted_native,
       toFloat64OrNull(toString(converted_native)) AS converted_native_f
  FROM (${sales.sql}) AS s
  LEFT ANY JOIN (${rateRows.sql}) AS r
    ON s.currency = r.currency AND s.amount_issuer = r.issuer AND toDate(s.close_time, 'UTC') = r.day`,
    params: { ...sales.params, ...rateRows.params },
  };
}

/** The key of a sale of `nft_sales`. */
export interface SaleKey {
  ledger_index: number;
  tx_index: number;
  event_index: number;
}

/**
 * The `${ledger_index}:${tx_index}:${event_index}` text that `convertedSalePrices` answers by. The parts may be numbers or the
 * text of one (ClickHouse writes a UInt32 either way).
 */
export function saleKey(sale: {
  ledger_index: number | string;
  tx_index: number | string;
  event_index: number | string;
}): string {
  return `${Number(sale.ledger_index)}:${Number(sale.tx_index)}:${Number(sale.event_index)}`;
}

/**
 * The converted price of each sale of `nft_sales` asked for, keyed by `saleKey`, as text in the native currency: at most 6
 * decimals, no trailing zeros and no exponent (`1250`, `61.25`, `0.000001`). A sale without a converted price (no rate that
 * day), and a key that is no sale, are absent. Each sale is read once, though its row was written twice.
 */
export async function convertedSalePrices(
  ch: ClickHouseService,
  rates: DailyRates,
  keys: readonly SaleKey[],
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const sales: SqlPart = {
    sql: `SELECT ledger_index, tx_index, event_index, currency, amount_issuer, close_time, amount, amount_f
            FROM ${Table.NftSales}
           WHERE (ledger_index, tx_index, event_index) IN (
                 SELECT arrayJoin(arrayZip({ns_ledgers:Array(UInt32)}, {ns_txs:Array(UInt32)}, {ns_events:Array(UInt16)})))
             AND ledger_index BETWEEN {ns_min:UInt32} AND {ns_max:UInt32}
           ORDER BY ledger_index, tx_index, event_index
           LIMIT 1 BY ledger_index, tx_index, event_index`,
    params: {
      ns_ledgers: keys.map((k) => k.ledger_index),
      ns_txs: keys.map((k) => k.tx_index),
      ns_events: keys.map((k) => k.event_index),
      ns_min: keys.reduce((min, k) => Math.min(min, k.ledger_index), keys[0].ledger_index),
      ns_max: keys.reduce((max, k) => Math.max(max, k.ledger_index), keys[0].ledger_index),
    },
  };
  const native = await nftSalesNativeSql(ch, rates, sales);
  const rows = await ch.query<{
    ledger_index: number | string;
    tx_index: number | string;
    event_index: number | string;
    converted: string;
  }>(
    `SELECT ledger_index, tx_index, event_index, toString(converted_native) AS converted
       FROM (${native.sql})
      WHERE converted_native IS NOT NULL
      ORDER BY ledger_index, tx_index, event_index`,
    native.params,
  );
  return new Map(rows.map((r) => [saleKey(r), nativeText(r.converted)]));
}

/** A converted price as the readers show it, whatever the text ClickHouse gives a Decimal: no trailing zeros and no exponent. */
function nativeText(decimal: string): string {
  return new BigNumber(decimal).toFixed();
}
