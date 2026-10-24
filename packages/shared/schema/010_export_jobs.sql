-- =============================================================================
-- GateHub Data API: the state of the export jobs (spec #4, ticket #15). Additive to 001_baseline.sql, one database
-- per network.
--
-- export_jobs is append-only, in the manner of ingest_log: the api writes a 'queued' row when a client asks for an
-- export (POST /v2/exports), the exporter of the network writes 'running' when it takes the job and 'done' or 'failed'
-- when it is over. Every row repeats the job (path, format, creator, creation time), so the row with the highest seq of
-- an id is the whole state of that job, and the rows before it are its history. The creating API key is kept as the
-- hex SHA-256 of the key, never the key; '' when the api ran without keys. Rows go 7 days after the job was created,
-- with the file (a bucket lifecycle rule deletes it).
--
-- The statement is IF NOT EXISTS, so the file can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

CREATE TABLE IF NOT EXISTS export_jobs
(
  id       String,
  seq      UInt32,
  key_hash String,
  path     String,
  format   LowCardinality(String),
  status   Enum8('queued' = 1, 'running' = 2, 'done' = 3, 'failed' = 4),
  created  DateTime64(3, 'UTC'),
  at       DateTime64(3, 'UTC'),
  rows     UInt64,
  object   String,
  error    String
)
ENGINE = MergeTree
ORDER BY (id, seq)
TTL toDateTime(created) + INTERVAL 7 DAY;
