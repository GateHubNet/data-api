-- =============================================================================
-- GateHub Data API: display names (D4, spec 2026-10-24-display-names-design.md section 1). Additive to 001_baseline.sql,
-- one database per network.
--
-- account_domains is ledger-derived, written by ingest with the ledger's other rows from parser version 6 on: a row for
-- each AccountRoot node of a transaction's metadata that has or had a Domain, with the Domain as it stands after the
-- transaction (domain_hex, upper-case hex, empty when it has none) and deleted = 1 for a deleted node. version is
-- ledger_index * 2^32 + tx_index * 2^16 + node_index as decimal text (it passes 2^53); the newest row of an account is its
-- current domain. Unlike every other ledger-derived table it is ordered by account and not by the unique key (ADR-0007's
-- exception, spec 1.1): merges keep about one row per account and partition, and the tomls worker reads the current domain
-- of every account. Recovery and --reprocess delete by ledger_index and write the ledger again, so a row merged away under
-- a deleted one comes back with it. A ledger written by an older parser has no rows in it. It carries the dedup window of
-- every ledger-derived table and a finer index granularity (the names batch reads up to 100 accounts by key).
--
-- domain_tomls is written by the syncer's tomls worker only, ReplacingMergeTree(checked_at), no partition and no dedup
-- window: one row per check of a domain's toml, the newest wins. status is ok or failed, reason the failure ('' for ok),
-- toml_url the address that was fetched. modified to principals are what the domain's toml says in effect (read at
-- fetched_at, carried over by a transient failure, empty otherwise). Readers keep the newest row of a domain without FINAL.
-- Times: DateTime64(3) columns are unix seconds with the milliseconds as the fraction.
--
-- Every statement is IF NOT EXISTS, so the file can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

CREATE TABLE IF NOT EXISTS account_domains
(
  account      String,
  ledger_index UInt32,
  tx_index     UInt32,
  node_index   UInt16,
  version      UInt64,
  domain_hex   String,
  deleted      UInt8
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY account
SETTINGS non_replicated_deduplication_window = 1000, index_granularity = 1024;

CREATE TABLE IF NOT EXISTS domain_tomls
(
  domain        String,
  toml_url      String,
  status        LowCardinality(String),
  reason        LowCardinality(String),
  status_code   UInt16,
  checked_at    DateTime64(3, 'UTC'),
  fetched_at    Nullable(DateTime64(3, 'UTC')),
  next_check_at DateTime('UTC'),
  failures      UInt16,
  modified      Nullable(DateTime('UTC')),
  expires       Nullable(DateTime('UTC')),
  accounts      Array(Tuple(address String, network String, desc String)),
  currencies    Array(Tuple(code String, issuer String, network String, fields String)),
  validators    Array(Tuple(public_key String, network String, fields String)),
  principals    Array(String)
)
ENGINE = ReplacingMergeTree(checked_at)
ORDER BY domain;
