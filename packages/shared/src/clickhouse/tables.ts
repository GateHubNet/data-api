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
  // Internal bookkeeping.
  IngestLog = 'ingest_log',
  AggDirty = 'agg_dirty',
  SyncerLease = 'syncer_lease',
}
