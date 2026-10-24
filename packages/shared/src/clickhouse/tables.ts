/** Canonical ClickHouse table names. Single source of truth: no magic strings in services. */
export enum Table {
  // Ledger-prefixed base tables (wide rows, ordered by ledger).
  Ledgers = 'ledgers',
  Transactions = 'transactions',
  Payments = 'payments',
  // Secondary lookup tables, written explicitly by the syncer.
  LedgerByHash = 'ledger_by_hash',
  TxByHash = 'tx_by_hash',
  TxByType = 'tx_by_type',
  AccountTransactions = 'account_transactions',
  AccountTxBySequence = 'account_tx_by_sequence',
  PaymentsByCurrency = 'payments_by_currency',
  AccountPayments = 'account_payments',
  Exchanges = 'exchanges',
  AccountExchanges = 'account_exchanges',
  BalanceChanges = 'balance_changes',
  AccountsCreated = 'accounts_created',
  // AMM ledger tables (written by ingest, one row per pool and transaction).
  AmmPoolStates = 'amm_pool_states',
  AmmPoolTouches = 'amm_pool_touches',
  AmmLiquidity = 'amm_liquidity',
  AccountAmmLiquidity = 'account_amm_liquidity',
  AmmGovernance = 'amm_governance',
  // Collected from the node (not derived from a ledger).
  FeeStats = 'fee_stats',
  Validations = 'validations',
  ValidatorManifests = 'validator_manifests',
  // Validators and amendments (migration 002): written by the validations collector and the validators worker.
  ValidatorValidations = 'validator_validations',
  ValidatorSeen = 'validator_seen',
  UnlLists = 'unl_lists',
  UnlPublishers = 'unl_publishers',
  ValidatorDomains = 'validator_domains',
  NetworkState = 'network_state',
  AmendmentFeatures = 'amendment_features',
  ValidatorVotes = 'validator_votes',
  AmendmentTallies = 'amendment_tallies',
  ValidatorAgreementHourly = 'validator_agreement_hourly',
  // Written by the aggregator.
  StatsHourly = 'stats_hourly',
  VolumeDaily = 'volume_daily',
  VolumeLive = 'volume_live',
  AmmPools = 'amm_pools',
  AmmDaily = 'amm_daily',
  // Account and market aggregates (migration 003).
  NativeRatesDaily = 'native_rates_daily',
  PairHourly = 'pair_hourly',
  MarketsLive = 'markets_live',
  AccountRollupState = 'account_rollup_state',
  AccountPartitionRows = 'account_partition_rows',
  AccountRollupDays = 'account_rollup_days',
  AccountLinesDaily = 'account_lines_daily',
  AccountTxDaily = 'account_tx_daily',
  AccountTradesDaily = 'account_trades_daily',
  // Internal bookkeeping.
  IngestLog = 'ingest_log',
  AggDirty = 'agg_dirty',
  SyncerLease = 'syncer_lease',
}

/**
 * The tables of the shared database (ADR-0014, `schema-shared/*.sql`), which the apis of every network read. They are
 * not in `Table`: that enum is exactly the tables of a network database. A reader names them qualified with the shared
 * database: `${sharedDatabase}.${SharedTable.AccountNames}`.
 */
export enum SharedTable {
  /** Migration 001: the account name of an address, append-only, the newest row of an address wins. */
  AccountNames = 'account_names',
  /** Migration 002: the labels of an address (`scam`, `spam`, `advisory`), append-only, the newest row of (address, label) wins. */
  AccountLabels = 'account_labels',
}
