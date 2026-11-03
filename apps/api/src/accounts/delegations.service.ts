import { ClickHouseService, NetworkProfile, Table, transactionTypesOf } from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { Coverage, FeatureCoverageService } from '../common/feature-coverage.service';
import { fmtTime } from '../common/format';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { decodeMarker, KeysetKey, KeyValue, paginate } from '../common/pagination';
import { NETWORK_PROFILE } from '../config/api.config';
import { AsOf, OBJECT_COLUMNS, readOf, StoredRow } from '../ledger-objects/ledger-objects.service';
import { delegationCsvRow, DelegationObject, delegationObject, ObjectRead } from '../ledger-objects/object-views';
import { CsvRow } from '../nft/nft-objects';

/**
 * How many delegations, given or held, an account can have in the ledger at the head for `GET /v2/accounts/{address}/delegations`
 * to list them (deleted ones are not counted): a guard, not a page. An account that has more is answered 500, and the account is logged (in the message of the failure), so that the
 * limit can be looked at for it.
 */
export const DELEGATION_IDS_CAP = 10_000;

/**
 * How many IDs a read of `object_changes` names. They are one query parameter (`Array(String)`), and ClickHouse refuses a
 * parameter of more than 128 KiB (`http_max_field_value_size`: "Field value too long"), which is about 1,900 IDs of 64 digits.
 */
export const IDS_PER_READ = 1_000;

/** `given`: the delegations the account made (it is the `Account`); `held`: those it was given (it is the `Authorize`). */
export type DelegationDirection = 'given' | 'held';

/** The `role` of the index by account that each direction is. */
const ROLE_OF: Record<DelegationDirection, 'owner' | 'counterparty'> = { given: 'owner', held: 'counterparty' };

/** The `object_type` of a delegation in the index and in `object_changes`. */
const DELEGATE = 'Delegate';

/** What a marker of the delegations holds: the place of the last row of a page (its `updated`), then its ID. */
export const DELEGATION_POSITION: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
  { column: 'delegation_id', type: 'String' },
];

/** One page of the delegations of an account, as of the newest committed ledger. */
export interface DelegationsPage {
  asOf: AsOf;
  rows: DelegationObject[];
  marker?: string;
}

/** `GET /v2/accounts/{address}/delegations`: the keys are `DELEGATIONS_BODY_KEYS`, in this order; `delegations` is the CSV rows for `format=csv`. */
export interface DelegationsBody {
  result: 'success';
  coverage: Coverage;
  ledger_index: number;
  close_time: string;
  count: number;
  marker?: string;
  delegations: DelegationObject[] | CsvRow[];
}

/** The newest first: `updated` (the place of the newest row) descending, then the ID ascending. */
const newestFirst = (a: ObjectRead, b: ObjectRead): number =>
  b.ledger_index - a.ledger_index ||
  b.tx_index - a.tx_index ||
  (a.object_id < b.object_id ? -1 : a.object_id > b.object_id ? 1 : 0);

/** Whether a row comes after the last row of the page a marker names (its place and ID), in the order of `newestFirst`. */
function comesAfter(row: ObjectRead, [ledger, tx, id]: KeyValue[]): boolean {
  if (row.ledger_index !== ledger) return row.ledger_index < Number(ledger);
  if (row.tx_index !== tx) return row.tx_index < Number(tx);
  return row.object_id > String(id);
}

/**
 * The delegations an account gave or holds (spec 5.6), as of the newest committed ledger `H`, read in the two steps of spec 6:
 *
 *  1. the IDs: the account's prefix of `account_object_changes` for (`Delegate`, role), up to `H`, the newest row of each ID, and
 *     those whose newest row is no deletion (the entries in the ledger at `H`), at most `DELEGATION_IDS_CAP + 1` (more is a guard:
 *     500, and the account is logged);
 *  2. their rows: from `object_changes`, by `object_type = 'Delegate' AND object_id IN ids` (`IDS_PER_READ` IDs a read), the newest
 *     row of each (its state, and `updated`) and the newest `created` row of each (`created`, the creation of the entry it is now:
 *     an entry deleted and made again under the same ID has the newest). A deleted entry is not listed. The rest is sorted and
 *     paged in memory.
 *
 * A network that cannot have delegation (`NetworkProfile.hasDelegation`: Xahau) answers the empty list without a read of either
 * table. With no committed ledger the answer is a failure (the route's 500), as it has no point to be as of.
 */
@Injectable()
export class DelegationsService {
  /** The network's `TRANSACTION_TYPES`, read once: the definitions of the profile are parsed from their file on every call. */
  private types?: Readonly<Record<string, number>>;

  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
    private readonly coverage: FeatureCoverageService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  /**
   * One page of the delegations in the order `updated` newest first, then `delegation_id`: `limit` of them after the marker. Throws
   * 400 `invalid marker` for a marker that is none of ours (before any read), and fails when the account has more than
   * `DELEGATION_IDS_CAP` delegations of the direction, or no ledger is committed.
   */
  async page(
    address: string,
    o: { direction: DelegationDirection; limit: number; marker?: string },
  ): Promise<DelegationsPage> {
    const position = decodeMarker(o.marker, DELEGATION_POSITION);
    const asOf = await this.ranges.latestWithTime();
    if (asOf === undefined) throw new Error('no ledger is committed');
    // the network cannot have a delegation: there is nothing to read
    if (!this.coverage.isAvailable('delegations')) return { asOf, rows: [] };

    const ids = await this.idsOf(address, o.direction, asOf);
    if (ids.length === 0) return { asOf, rows: [] };
    const [newest, created] = await Promise.all([this.rowsOf(ids, asOf, false), this.rowsOf(ids, asOf, true)]);
    const createdOf = new Map(created.map((row) => [row.object_id, row]));

    const listed = newest.filter((row) => row.action !== 'deleted').sort(newestFirst);
    const rows = position === undefined ? listed : listed.filter((row) => comesAfter(row, position));
    const page = paginate(rows, o.limit, (row) => [row.ledger_index, row.tx_index, row.object_id]);
    return {
      asOf,
      rows: page.rows.map((row) => delegationObject(row, createdOf.get(row.object_id), this.transactionTypes())),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }

  /** The answer of the route: the page, the coverage of delegations, and the point it is as of. `csv`: the rows of the CSV. */
  async answer(
    address: string,
    o: { direction: DelegationDirection; limit: number; marker?: string; csv: boolean },
  ): Promise<DelegationsBody> {
    const found = await this.page(address, o);
    return {
      result: 'success',
      coverage: await this.coverage.coverage('delegations'),
      ledger_index: found.asOf.ledger_index,
      close_time: fmtTime(found.asOf.close_time),
      count: found.rows.length,
      ...(found.marker !== undefined && { marker: found.marker }),
      delegations: o.csv ? found.rows.map(delegationCsvRow) : found.rows,
    };
  }

  /**
   * The IDs of the delegations of the account in the direction that are in the ledger at `H`: one read of the account's prefix of
   * the index, the newest row of each ID, and those whose newest row is not a deletion, in the order of the IDs. An entry deleted
   * and made again under the same ID is in it; one deleted is not, so that the cap counts what is listed and not every ID the prefix
   * ever named (entries made and deleted again by other accounts, at the cost of their fees, cannot make the list a 500 for ever).
   * The owner and the authorized account of a `Delegate` are fixed by its ID, so its newest row in the index is its newest row.
   */
  private async idsOf(address: string, direction: DelegationDirection, asOf: AsOf): Promise<string[]> {
    const rows = await this.ch.query<{ object_id: string }>(
      `SELECT object_id
         FROM (
              SELECT object_id, action
                FROM ${Table.AccountObjectChanges}
               WHERE account = {account:String} AND object_type = {type:String} AND role = {role:String}
                 AND ledger_index <= {H:UInt32}
               ORDER BY object_id, ledger_index DESC, tx_index DESC
               LIMIT 1 BY object_id
              )
        WHERE action != 'deleted'
        ORDER BY object_id
        LIMIT {cap:UInt32}`,
      { account: address, type: DELEGATE, role: ROLE_OF[direction], H: asOf.ledger_index, cap: DELEGATION_IDS_CAP + 1 },
    );
    if (rows.length > DELEGATION_IDS_CAP) {
      // the route logs the failure with this message: the account is what is needed to raise the limit for it
      throw new Error(
        `the account ${address} has more than ${DELEGATION_IDS_CAP} delegations ${direction} (the delegations are not listed)`,
      );
    }
    return rows.map((row) => row.object_id);
  }

  /**
   * The newest row up to `H` of each ID, or with `createdOnly` the newest row of each that created it: the object's rows by the
   * type and the IDs, the newest first, one for each ID. The IDs go in `IDS_PER_READ` at a time, one read each: the IDs are one
   * query parameter, which ClickHouse refuses past 128 KiB (an account with 10,000 delegations has 670 KB of them).
   */
  private async rowsOf(ids: string[], asOf: AsOf, createdOnly: boolean): Promise<ObjectRead[]> {
    const found: ObjectRead[] = [];
    for (let at = 0; at < ids.length; at += IDS_PER_READ) {
      const rows = await this.ch.query<StoredRow>(
        `SELECT ${OBJECT_COLUMNS}
           FROM ${Table.ObjectChanges}
          WHERE object_type = {type:String} AND object_id IN {ids:Array(String)} AND ledger_index <= {H:UInt32}${
            createdOnly ? " AND action = 'created'" : ''
          }
          ORDER BY ledger_index DESC, tx_index DESC
          LIMIT 1 BY object_id`,
        { type: DELEGATE, ids: ids.slice(at, at + IDS_PER_READ), H: asOf.ledger_index },
      );
      found.push(...rows.map(readOf));
    }
    return found;
  }

  /** The `TRANSACTION_TYPES` of the network, read from the definitions once. */
  private transactionTypes(): Readonly<Record<string, number>> {
    return (this.types ??= transactionTypesOf(this.profile));
  }
}
