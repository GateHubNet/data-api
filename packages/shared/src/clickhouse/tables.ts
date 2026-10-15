/** Canonical ClickHouse table names. Single source of truth — no magic strings in services. */
export enum Table {
  Ledgers = 'ledgers',
  Transactions = 'transactions',
  Payments = 'payments',
  Exchanges = 'exchanges',
  BalanceChanges = 'balance_changes',
  AffectedAccounts = 'affected_accounts',
  AccountsCreated = 'accounts_created',
  Offers = 'offers',
  Issuers = 'issuers',
  Escrows = 'escrows',
  PayChannels = 'paychannels',
}

/** Materialized view targets (pre-aggregated, queried by the API for analytics). */
export enum View {
  ExchangeCandles1m = 'exchange_candles_1m',
  PaymentVolumeDaily = 'payment_volume_daily',
  ExchangeVolumeDaily = 'exchange_volume_daily',
  StatsDaily = 'stats_daily',
}
