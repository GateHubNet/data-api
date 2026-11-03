import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { firstCommittedLedger } from '../ingest/ingest-state';

/**
 * The newest stored ledger a parser older than `version` wrote (`ledgers.parser_version`), `null` when there is none.
 * Gaps in the ledger numbers do not matter: the ledgers that are not stored are not looked at, and a ledger that was
 * reprocessed counts only by the row it has now (the old row is deleted before the new one is written).
 */
export async function newestLedgerBelowVersion(ch: ClickHouseService, version: number): Promise<number | null> {
  const [row] = await ch.query<{ ledger_index: number | string | null }>(
    `SELECT maxOrNull(ledger_index) AS ledger_index FROM ${Table.Ledgers} WHERE parser_version < {version:UInt16}`,
    { version },
  );
  return row?.ledger_index == null ? null : Number(row.ledger_index);
}

/**
 * Where the rows of parser `version` start: one above `newestLedgerBelowVersion`, else the oldest stored ledger (`null`
 * when no ledger is stored). Every stored ledger from there up was written by that parser or a later one.
 */
export async function coverageFrom(ch: ClickHouseService, version: number): Promise<number | null> {
  const newestOlder = await newestLedgerBelowVersion(ch, version);
  if (newestOlder !== null) return newestOlder + 1;
  return (await firstCommittedLedger(ch)) ?? null;
}
