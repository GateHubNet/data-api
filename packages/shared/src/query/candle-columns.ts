import { exactAmount, exactSum, floatSum, volumeColumns } from './decimal';

/**
 * The columns an aggregation reads from its subquery (see `AGGREGATE_SOURCE_COLUMNS`): the key, the close time, the
 * rates, the amounts as exact decimals (`NULL` when they do not fit) and as floats, and the parties.
 */
export const AGGREGATE_SOURCE_COLUMNS = [
  'ledger_index',
  'tx_index',
  'node_index',
  'close_time',
  'rate',
  'rate_f',
  `${exactAmount('base_amount')} AS base_exact`,
  `${exactAmount('counter_amount')} AS counter_exact`,
  'base_amount_f',
  'counter_amount_f',
  'buyer',
  'seller',
  'taker',
].join(', ');

/**
 * The expressions of an aggregation over the rows of `AGGREGATE_SOURCE_COLUMNS`. The aliases are none of the column
 * names, so that an expression over `close_time` (the bucket) still means the column. Every pick is deterministic:
 * equal rates are told apart by the key of the exchange, and decimal sums do not depend on the order of the rows.
 */
export const AGGREGATE_COLUMNS = [
  'argMin(rate, (ledger_index, tx_index, node_index)) AS open_rate',
  'argMax(rate, (ledger_index, tx_index, node_index)) AS close_rate',
  'argMax(rate, (rate_f, -toInt64(ledger_index), -toInt64(tx_index), -toInt32(node_index))) AS high_rate',
  'argMin(rate, (rate_f, ledger_index, tx_index, node_index)) AS low_rate',
  // the count, the two volumes (exact and Float64) and the exchanges the exact sums cannot hold: the shared ones
  volumeColumns(),
  `${exactSum('base_exact', 'buyer = taker')} AS base_bought`,
  `${exactSum('counter_exact', 'seller = taker')} AS counter_bought`,
  `${floatSum('base_amount_f', 'buyer = taker')} AS base_bought_f`,
  `${floatSum('counter_amount_f', 'seller = taker')} AS counter_bought_f`,
  'toUnixTimestamp(min(close_time)) AS open_ts',
  'toUnixTimestamp(max(close_time)) AS close_ts',
].join(',\n         ');
