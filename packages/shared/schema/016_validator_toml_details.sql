-- =============================================================================
-- GateHub Data API: what a validator's verified toml says about it (D8, an amendment of ADR-0012). Additive, one
-- database per network.
--
-- validator_domains gains the facts the domain checker reads from the [[VALIDATORS]] entry that lists the master key,
-- since they belong to the (validator, domain) pair whose check read them: owner_country and server_country (upper-case
-- ISO 3166-1 alpha-2 codes), and toml_network and toml_unl (the file's claims, which nothing checks and nothing
-- fetches). All four are filled only on a verified row, as accounts is. toml_version says what the checker read of the
-- file: 0 for a row from before this release, which a transient failure within the grace carries on, and
-- TOML_DETAILS_VERSION for every other row the checker of this release writes.
--
-- From this release the domain checker of the validators worker writes domain_tomls too, for every file it fetched, so
-- the sentence of 012_display_names.sql that says the tomls worker is its only writer no longer holds. An applied
-- migration cannot change, so it is said here.
--
-- A rollback needs no undo: code from before this release neither reads nor writes the columns. Each column is added
-- IF NOT EXISTS, so the file can simply be run again, and a run that stopped half way completes.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

ALTER TABLE validator_domains
  ADD COLUMN IF NOT EXISTS owner_country  LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS server_country LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS toml_network   String DEFAULT '',
  ADD COLUMN IF NOT EXISTS toml_unl       String DEFAULT '',
  ADD COLUMN IF NOT EXISTS toml_version   UInt8 DEFAULT 0;
