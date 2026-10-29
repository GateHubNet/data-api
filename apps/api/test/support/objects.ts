import {
  AccountObjectChangesRow,
  OBJECT_PARSER_VERSION,
  ObjectChangesRow,
  stableStringify,
  Table,
} from '@gatehub/data-api-shared';
import type { Harness } from '../harness';
import { accountAt } from './amm';
import { ledgerRow } from './validators-seed';

/**
 * Rows of `object_changes` made by hand, for the e2e suites of the ledger objects (escrows, checks, payment channels,
 * delegations): the escrow routes, the delegations route and the read bounds. A hand-made row says `synthetic-…` in its
 * transaction hash unless the test gives it one (a hand-made row is never presented as a recorded one).
 */

/** The owner of a row made by hand, and its counterparty (a valid address each; the same number is always the same account). */
export const OWNER = accountAt(0xd501);
export const COUNTERPARTY = accountAt(0xd502);

/** The close time of a row made by hand when the test gives none: 2026-10-28T22:30:00Z, a moment of the recorded ledgers. */
export const SYNTHETIC_CLOSE_TIME = 1_793_226_600;

/** `JSON` text as the parser writes the three JSON columns: keys sorted, no spaces. */
export const jsonOf = (value: Record<string, unknown>): string => stableStringify(value);

/**
 * A row of `object_changes` made by hand: the creation of an escrow of `OWNER` for `COUNTERPARTY` by an `EscrowCreate` that
 * succeeded, every JSON column empty (`'{}'`), unless `o` names the column. The key (`object_type`, `object_id`,
 * `ledger_index`) is the test's; `tx_index` is 0 unless given.
 */
export function objectRow(
  o: Partial<ObjectChangesRow> & Pick<ObjectChangesRow, 'object_type' | 'object_id' | 'ledger_index'>,
): ObjectChangesRow {
  const txIndex = o.tx_index ?? 0;
  return {
    tx_index: txIndex,
    tx_hash: `synthetic-${o.ledger_index}-${txIndex}-${o.object_id.slice(0, 8)}`,
    close_time: SYNTHETIC_CLOSE_TIME,
    tx_type: 'EscrowCreate',
    result: 'tesSUCCESS',
    sender: OWNER,
    delegate: '',
    action: 'created',
    event: 'create',
    owner: OWNER,
    counterparty: COUNTERPARTY,
    fields: '{}',
    previous: '{}',
    event_fields: '{}',
    ...o,
  };
}

/** The rows of `account_object_changes` the ingest writes for rows of `object_changes`: the owner's, and the counterparty's if any. */
export function accountRowsOf(rows: ObjectChangesRow[]): AccountObjectChangesRow[] {
  return rows.flatMap((r) => {
    const index = (account: string, role: AccountObjectChangesRow['role']): AccountObjectChangesRow => ({
      account,
      object_type: r.object_type,
      role,
      ledger_index: r.ledger_index,
      tx_index: r.tx_index,
      object_id: r.object_id,
      action: r.action,
    });
    return [index(r.owner, 'owner'), ...(r.counterparty !== '' ? [index(r.counterparty, 'counterparty')] : [])];
  });
}

/** Writes rows to both tables an ingest writes them to (`object_changes` and its index by account), as one insert each. */
export async function insertObjects(h: Harness, rows: ObjectChangesRow[]): Promise<void> {
  await h.ch.insert(Table.ObjectChanges, rows);
  await h.ch.insert(Table.AccountObjectChanges, accountRowsOf(rows));
}

/**
 * Writes `rows` and a committed ledger `head` (its index and close time, unix seconds): the ledger the routes are as of. Its
 * `ledgers` row says it was written by the parser of the objects, so the coverage of the objects starts at the oldest ledger
 * stored (nothing older was written by an older parser). A ledger row is not written again for an index that is there: use
 * `insertObjects` for rows in the ledgers of a fixture set.
 */
export async function seedObjects(
  h: Harness,
  rows: ObjectChangesRow[],
  head: { ledger_index: number; close_time: number },
): Promise<void> {
  await insertObjects(h, rows);
  await h.ch.insert(Table.Ledgers, [
    { ...ledgerRow(head.ledger_index, head.close_time), parser_version: OBJECT_PARSER_VERSION },
  ]);
}
