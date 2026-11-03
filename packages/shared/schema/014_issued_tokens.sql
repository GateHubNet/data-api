-- =============================================================================
-- GateHub Data API: issued tokens (D6, spec 2026-10-24-issued-tokens-design.md section 2). Additive to 001_baseline.sql,
-- one database per network. Required before the syncer of this release (its writer inserts into state_touches on every
-- ledger) and before the api.
--
-- state_touches is ledger-derived, written by ingest with the ledger's other rows from parser version 8 on. It is the
-- narrow, ledger-ordered index of trust_line_states and account_states, as amm_pool_touches is of amm_pool_states: one
-- row for each trust line whose state a transaction changed (kind line: account is the line's low account, counterparty
-- its high account, currency as the ledger writes it) and for each account whose token settings it may have changed (kind
-- account: counterparty and currency are empty). The tokens job reads it by a range of the primary key, which the two
-- state tables, ordered by account, cannot serve once their parts have merged. Recovery and --reprocess delete it by
-- ledger_index with the other ledger tables, so it carries the dedup window of every ledger-derived table.
--
-- token_generations, token_lines and tokens are aggregates, written by the syncer's aggregator only (job tokens,
-- ReplacingMergeTree(version), no dedup window, never deleted by recovery). A generation is one build of the token set:
-- token_generations holds the job's state, one row for every change of a generation, and the newest version of a
-- generation is its state. token_lines holds the current state of every trust line that counts and tokens the tokens
-- made of them. Both are PARTITION BY generation: a generation is swapped in whole and a retired one is dropped whole
-- (the syncer runs ALTER TABLE ... DROP PARTITION, so its ClickHouse user needs that right on the two tables). Readers
-- name one generation, keep the newest version of each key without FINAL and drop deleted = 1 rows after that. A version
-- is the writer's clock in milliseconds, at least one more than any version already written.
--
-- Every statement is IF NOT EXISTS, so the file can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

CREATE TABLE IF NOT EXISTS state_touches
(
  ledger_index UInt32,
  tx_index     UInt32,
  kind         Enum8('line' = 1, 'account' = 2),
  account      String,
  counterparty String,
  currency     LowCardinality(String)
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY (ledger_index, tx_index, kind, account, counterparty, currency)
SETTINGS non_replicated_deduplication_window = 1000;

-- One row per change of a generation's state. state is building, live or retired. coverage_from is the state coverage
-- start the generation was built on and head_ledger the ledger its account pass reads at, account_cursor the last
-- account the pass finished (empty before the first) and pass_done 1 once it has finished. through_ledger is the ledger
-- up to which every touch has been applied and repair_from the lowest ledger to apply again (0: none). holders is the
-- number of distinct holders of all tokens at holders_ledger.
CREATE TABLE IF NOT EXISTS token_generations
(
  generation     UInt32,
  state          Enum8('building' = 1, 'live' = 2, 'retired' = 3),
  config_version UInt16,
  coverage_from  UInt32,
  head_ledger    UInt32,
  account_cursor String,
  pass_done      UInt8,
  through_ledger UInt32,
  repair_from    UInt32,
  holders        UInt32,
  holders_ledger UInt32,
  started_at     DateTime64(3, 'UTC'),
  changed_at     DateTime64(3, 'UTC'),
  version        UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY generation;

-- The state of every line that counts, from the token's side: balance is the holder's (0 or above, exact decimal
-- text, balance_f its Float64 shadow) and limit the holder's limit. frozen and authorized are the issuer side's freeze
-- and auth flags and ledger_index the ledger of the line's newest state. deleted 1 is a tombstone: the line no longer
-- counts (deleted, emptied with no limit, or turned round).
CREATE TABLE IF NOT EXISTS token_lines
(
  generation   UInt32,
  issuer       String,
  currency     LowCardinality(String),
  holder       String,
  balance      String,
  balance_f    Float64,
  limit        String,
  frozen       UInt8,
  authorized   UInt8,
  ledger_index UInt32,
  deleted      UInt8,
  version      UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY generation
ORDER BY (issuer, currency, holder);

-- One row per token and recompute. code is the currency as text (empty when it has none), supply the exact sum of the
-- holders' balances (supply_f its shadow) and last_ledger the newest ledger_index of the token's lines. The issuer's
-- settings are those of its newest account_states row at the ledger the row was computed at: issuer_flags (the
-- AccountRoot Flags), transfer_rate (0 when absent) and issuer_ledger (that row's ledger, 0 when the issuer has no
-- row in the state tables). domain is the issuer's account domain (empty when none), listed, name and toml come from
-- the toml of that domain: toml is the JSON of the served fields of the matched currency entry (empty when not listed).
-- deleted 1 means that no line counts any more.
CREATE TABLE IF NOT EXISTS tokens
(
  generation    UInt32,
  issuer        String,
  currency      LowCardinality(String),
  code          String,
  holders       UInt32,
  trust_lines   UInt32,
  supply        String,
  supply_f      Float64,
  last_ledger   UInt32,
  issuer_ledger UInt32,
  issuer_flags  UInt32,
  transfer_rate UInt32,
  domain        String,
  listed        UInt8,
  name          String,
  toml          String,
  deleted       UInt8,
  version       UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY generation
ORDER BY (issuer, currency);
