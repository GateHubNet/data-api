import { Table } from '../clickhouse/tables';

/**
 * The accounts are seeded in this many buckets (`cityHash64(account) % 16`), one statement a bucket, to bound the memory of the
 * `GROUP BY account` (spec 10).
 */
export const ACCOUNT_DOMAINS_SEED_BUCKETS = 16;

/**
 * The seed of `account_domains` (spec 10, run once per network by the operator, `docs/backfill.md` "Account domains seed"): for
 * the ledgers that were written before `account_domains` existed, the current domain of every account with a state row, from
 * `account_states`. Run it for each `bucket` from 0 to `ACCOUNT_DOMAINS_SEED_BUCKETS - 1`, with `X`, the last ledger an older
 * parser wrote (`SELECT maxOrNull(ledger_index) FROM ledgers WHERE parser_version < <DOMAIN_PARSER_VERSION>`), both bound
 * parameters (`{X:UInt32}` and `{bucket:UInt8}`).
 *
 * The row sits on the account's newest state row at or below `X` (its `ledger_index`, `tx_index` and `node_index`, the same
 * `version` the parser gives it), so a later `--reprocess` of that ledger deletes it and the parser writes the same row back.
 * An account without a Domain, and a deleted account, get no row. Running it twice inserts the same rows again; the row with the
 * largest `version` of an account is its current Domain either way.
 */
export const ACCOUNT_DOMAINS_SEED_SQL = `INSERT INTO ${Table.AccountDomains} (account, ledger_index, tx_index, node_index, version, domain_hex, deleted)
SELECT account, top.1, top.2, top.3,
       bitOr(bitShiftLeft(toUInt64(top.1), 32), bitOr(bitShiftLeft(toUInt64(top.2), 16), toUInt64(top.3))), hex, 0
  FROM (SELECT account,
               argMax((ledger_index, tx_index, node_index), (ledger_index, tx_index, node_index)) AS top,
               argMax(JSONExtractString(fields, 'Domain'), (ledger_index, tx_index, node_index)) AS hex,
               argMax(deleted, (ledger_index, tx_index, node_index)) AS gone
          FROM ${Table.AccountStates}
         WHERE ledger_index <= {X:UInt32} AND cityHash64(account) % ${ACCOUNT_DOMAINS_SEED_BUCKETS} = {bucket:UInt8}
         GROUP BY account)
 WHERE hex != '' AND gone = 0`;
