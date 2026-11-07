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
  // Account state history (migration 005): the state of an account root after each change, from parser version 3.
  AccountStates = 'account_states',
  // Trust line state history (migration 006): the state of each side of a trust line after each change, from version 3.
  TrustLineStates = 'trust_line_states',
  // Path payments (migration 007, written by ingest).
  PathPayments = 'path_payments',
  // The path payments of an account (migration 008): the index of path_payments by source and destination.
  AccountPathPayments = 'account_path_payments',
  // NFTs and URITokens (migration 011, written by ingest from parser version 5, NFT_PARSER_VERSION): the events, their
  // copies by account, by collection and for the sales, and the narrow index of the NFTs a transaction touched.
  NftEvents = 'nft_events',
  AccountNftEvents = 'account_nft_events',
  CollectionNftEvents = 'collection_nft_events',
  NftSales = 'nft_sales',
  NftTouches = 'nft_touches',
  // The domain of an account (migration 012, written by ingest from parser version 6): ordered by account, not by the
  // unique key (ADR-0007's exception, spec 1.1).
  AccountDomains = 'account_domains',
  // The history of the tracked ledger objects (migration 013, written by ingest from parser version 7,
  // OBJECT_PARSER_VERSION): one row per created, modified or deleted Escrow, Check, PayChannel or Delegate node, and its
  // narrow index by account.
  ObjectChanges = 'object_changes',
  AccountObjectChanges = 'account_object_changes',
  // The ledger-ordered index of the trust lines and issuers whose token state a transaction changed (migration 014, written by
  // ingest from parser version 8): the tokens job scans it by ledger, as the aggregator scans the other touch tables.
  StateTouches = 'state_touches',
  // The Xahau mint tables (migration 015, written by ingest from parser version 9, MINT_PARSER_VERSION; empty on XRPL): the
  // native entries of a successful GenesisMint, a successful Import and every ClaimReward, from which the supply job derives
  // the minted totals.
  GenesisMints = 'genesis_mints',
  Imports = 'imports',
  RewardClaims = 'reward_claims',
  // The MPT ledger tables (migration 017, written by ingest from parser version 10, MPT_PARSER_VERSION; empty on Xahau): the state of
  // an issuance and of a holder's balance after each transaction that changed its node, the ledger-ordered index of what a
  // transaction touched, and the transfers in ledger order and by issuance.
  MptIssuanceStates = 'mpt_issuance_states',
  MptHolderStates = 'mpt_holder_states',
  MptTouches = 'mpt_touches',
  MptTransfers = 'mpt_transfers',
  MptIssuanceTransfers = 'mpt_issuance_transfers',
  // The destination tag index (migration 018, written by ingest from parser version 11, DESTINATION_TAG_PARSER_VERSION): every
  // transaction whose own Destination and DestinationTag are set, of any type and whatever its result, under its destination
  // and tag, so that a lookup of one tag reads only its rows.
  AccountTxByDestinationTag = 'account_tx_by_destination_tag',
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
  // NFT aggregates (migration 011), written by the aggregator: the state of every NFT, the holdings of an account, the
  // collections and their holders.
  Nfts = 'nfts',
  AccountNfts = 'account_nfts',
  NftCollections = 'nft_collections',
  NftCollectionHolders = 'nft_collection_holders',
  // Migration 013, written by the aggregator: the state of every escrow, plus a sentinel row that holds the escrowed total.
  Escrows = 'escrows',
  // Written by the aggregator's `tokens` job (migration 014): the generations of the token set and the lines and tokens of each,
  // swapped and dropped by generation.
  TokenGenerations = 'token_generations',
  TokenLines = 'token_lines',
  Tokens = 'tokens',
  // Written by the aggregator's `supply` job (migration 015): one row per snapshot of the native supply, the newest version of a
  // ledger wins.
  NetworkSupply = 'network_supply',
  // Written by the aggregator's `mpt_state` job (migration 017): the current state of each issuance and the current balance of each
  // holder, the newest version of a key wins.
  MptIssuances = 'mpt_issuances',
  MptHolders = 'mpt_holders',
  // Migration 012, written by the syncer's tomls worker: one row per check of a domain's toml, the newest wins.
  DomainTomls = 'domain_tomls',
  // Written by the operator with plain SQL inserts (ADR-0014).
  /** Migration 009: the account network name of an address, append-only, the newest row of an address wins. */
  AccountNetworkNames = 'account_network_names',
  // Internal bookkeeping.
  IngestLog = 'ingest_log',
  AggDirty = 'agg_dirty',
  /** Migration 011: the ledger ranges whose NFTs must be rebuilt after a re-ingest, as `agg_dirty` is for hours. */
  NftDirty = 'nft_dirty',
  SyncerLease = 'syncer_lease',
  // Export jobs (migration 010): written by the api (queued) and the exporter (running, done, failed).
  ExportJobs = 'export_jobs',
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
