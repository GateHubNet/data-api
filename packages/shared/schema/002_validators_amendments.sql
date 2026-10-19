-- =============================================================================
-- GateHub Data API: validators and amendments (D1). Additive to 001_baseline.sql, one database per network.
--
-- Two ALTER TABLE statements add columns to the collector's tables (validations, validator_manifests) and ten
-- tables are new. None of them is a ledger table: ingest recovery never deletes from them.
--
--  * Written by the validations collector: server_version, the manifest columns, validator_validations and
--    validator_seen. The last two are AggregatingMergeTree tables like validations (sightings merge), with a dedup
--    window of 100 so that a retried insert carrying the same insert_deduplication_token is dropped.
--  * Written by the validators worker: unl_lists, unl_publishers, validator_domains, network_state and
--    amendment_features, which are small ReplacingMergeTree tables (the newest row wins), and validator_votes,
--    amendment_tallies and validator_agreement_hourly, which are version sets: a round (or an hour) is written whole
--    under one version, its sentinel row last, and a reader keeps only the rows of the newest sentinel's version.
--  * Times: DateTime('UTC') for ledger and wall times (unix seconds), DateTime64(3, 'UTC') for times of receipt.
--    Keys are base58 node public keys, amendment IDs are upper-case hex.
--
-- Every statement is IF NOT EXISTS, so a file that failed half way can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Columns added to the collector's tables.
-- ---------------------------------------------------------------------------

-- The software version a validator reports in the validation of a voting ledger (NULL elsewhere).
ALTER TABLE validations
  ADD COLUMN IF NOT EXISTS server_version SimpleAggregateFunction(any, Nullable(UInt64));

-- The manifest's domain, the raw manifest (upper-case hex) and where it came from (stream, rpc or unl).
ALTER TABLE validator_manifests
  ADD COLUMN IF NOT EXISTS domain   String DEFAULT '',
  ADD COLUMN IF NOT EXISTS manifest String DEFAULT '',
  ADD COLUMN IF NOT EXISTS source   LowCardinality(String) DEFAULT 'stream';

-- ---------------------------------------------------------------------------
-- Written by the validations collector.
-- ---------------------------------------------------------------------------

-- One row per (validator, ledger, ledger hash), kept for 7 days. Sightings merge: counts add up, the
-- first/last timestamps take the min/max, full takes the max and every other field keeps an arbitrary value.
CREATE TABLE IF NOT EXISTS validator_validations
(
  validation_public_key LowCardinality(String),
  ledger_index          UInt32,
  ledger_hash           String,
  count                 SimpleAggregateFunction(sum, UInt64),
  first_datetime        SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
  last_datetime         SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
  ephemeral_public_key  SimpleAggregateFunction(any, String),
  signing_time          SimpleAggregateFunction(any, UInt32),
  full                  SimpleAggregateFunction(max, UInt8),
  server_version        SimpleAggregateFunction(any, Nullable(UInt64))
)
ENGINE = AggregatingMergeTree
PARTITION BY intDiv(ledger_index, 100000)
ORDER BY (validation_public_key, ledger_index, ledger_hash)
TTL toDateTime(last_datetime) + INTERVAL 7 DAY
SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 100;

-- When each validator was first and last seen by this deployment. Kept for ever.
CREATE TABLE IF NOT EXISTS validator_seen
(
  validation_public_key String,
  first_seen            SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
  last_seen             SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
  last_ledger_index     SimpleAggregateFunction(max, UInt32)
)
ENGINE = AggregatingMergeTree
ORDER BY validation_public_key
SETTINGS non_replicated_deduplication_window = 100;

-- ---------------------------------------------------------------------------
-- Written by the validators worker.
-- ---------------------------------------------------------------------------

-- Every UNL list a publisher served, as served (response) and as verified (validators: master keys, sorted).
CREATE TABLE IF NOT EXISTS unl_lists
(
  publisher     LowCardinality(String),
  publisher_key String,
  sequence      UInt64,
  version       UInt8,
  effective     Nullable(DateTime('UTC')),
  expiration    DateTime('UTC'),
  validators    Array(String),
  blob_sha256   String,
  fetched_at    DateTime64(3, 'UTC'),
  response      String CODEC(ZSTD(3))
)
ENGINE = ReplacingMergeTree(fetched_at)
ORDER BY (publisher, sequence);

-- The newest state of each configured publisher.
CREATE TABLE IF NOT EXISTS unl_publishers
(
  publisher     LowCardinality(String),
  url           String,
  publisher_key String,
  configured    UInt8,
  threshold     UInt8,
  checked_at    DateTime64(3, 'UTC'),
  status        LowCardinality(String),
  error         LowCardinality(String),
  last_ok_at    Nullable(DateTime64(3, 'UTC'))
)
ENGINE = ReplacingMergeTree(checked_at)
ORDER BY publisher;

-- The newest domain verification of each (validator, domain).
CREATE TABLE IF NOT EXISTS validator_domains
(
  validation_public_key String,
  domain                String,
  status                LowCardinality(String),
  reason                LowCardinality(String),
  status_code           UInt16,
  toml_url              String,
  checked_at            DateTime64(3, 'UTC'),
  verified_at           Nullable(DateTime64(3, 'UTC')),
  next_check_at         DateTime('UTC'),
  accounts              Array(String)
)
ENGINE = ReplacingMergeTree(checked_at)
ORDER BY (validation_public_key, domain);

-- The ledger state read from the node: enabled amendments, majorities, negative UNL and fees. Kept 100 days.
CREATE TABLE IF NOT EXISTS network_state
(
  ledger_index UInt32,
  ledger_hash  String,
  polled_at    DateTime64(3, 'UTC'),
  amendments   Array(String),
  majorities   Array(Tuple(amendment String, since DateTime('UTC'))),
  negative_unl Array(Tuple(validation_public_key String, first_ledger UInt32)),
  to_disable   String,
  to_reenable  String,
  base_fee     UInt64,
  reserve_base UInt64,
  reserve_inc  UInt64,
  node_quorum  UInt32
)
ENGINE = ReplacingMergeTree(polled_at)
ORDER BY ledger_index
TTL toDateTime(polled_at) + INTERVAL 100 DAY;

-- The name and support the node reports for each amendment ID.
CREATE TABLE IF NOT EXISTS amendment_features
(
  amendment_id String,
  name         String,
  supported    UInt8,
  polled_at    DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(polled_at)
ORDER BY amendment_id;

-- Version set: each validator's votes in a voting ledger. A round is written whole under one version.
CREATE TABLE IF NOT EXISTS validator_votes
(
  ledger_index          UInt32,
  validation_public_key String,
  ledger_hash           String,
  close_time            DateTime('UTC'),
  full                  UInt8,
  amendments            Array(LowCardinality(String)),
  base_fee              Nullable(UInt64),
  reserve_base          Nullable(UInt64),
  reserve_inc           Nullable(UInt64),
  server_version        Nullable(UInt64),
  version               UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (ledger_index, validation_public_key);

-- Version set: the tally of each amendment in a voting ledger. amendment_id = '' is the round's sentinel.
CREATE TABLE IF NOT EXISTS amendment_tallies
(
  ledger_index UInt32,
  amendment_id String,
  close_time   DateTime('UTC'),
  yes          UInt16,
  trusted      UInt16,
  threshold    UInt16,
  unl_size     UInt16,
  observed     UInt16,
  unl          Array(String),
  negative_unl Array(String),
  base_fee     UInt64,
  reserve_base UInt64,
  reserve_inc  UInt64,
  version      UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (amendment_id, ledger_index);

-- Version set: each validator's agreement in an hour. validation_public_key = '' is the hour's sentinel.
-- Kept 400 days.
CREATE TABLE IF NOT EXISTS validator_agreement_hourly
(
  hour                  DateTime('UTC'),
  validation_public_key String,
  agreed                UInt32,
  missed                UInt32,
  partial               UInt32,
  last_seen             DateTime64(3, 'UTC'),
  ledgers               UInt32,
  unobserved            UInt32,
  gaps                  UInt32,
  unl_size              UInt16,
  quorum                UInt16,
  final                 UInt8,
  version               UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (hour, validation_public_key)
TTL hour + INTERVAL 400 DAY;
