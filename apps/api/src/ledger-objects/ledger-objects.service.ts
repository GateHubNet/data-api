import { ClickHouseService, readDistinctPage, Table, TrackedObjectType } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { CoverageFeatureName } from '../common/coverage-features';
import { notFound } from '../common/errors';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { columnsOf, decodeMarker, keysetClause, KeysetKey, KeyValue, paginate } from '../common/pagination';
import { ObjectRead } from './object-views';

/** The objects whose history is read from `object_changes` by `/{id}` and `/{id}/history`: an escrow, a check, a payment channel. */
export type ObjectKind = 'escrow' | 'check' | 'payment_channel';

/** The `object_type` of each kind in `object_changes` (the node's `LedgerEntryType`). */
export const OBJECT_TYPE_OF: Record<ObjectKind, 'Escrow' | 'Check' | 'PayChannel'> = {
  escrow: 'Escrow',
  check: 'Check',
  payment_channel: 'PayChannel',
};

/** The coverage feature of each kind (`COVERAGE_FEATURES`). */
export const FEATURE_OF: Record<ObjectKind, CoverageFeatureName> = {
  escrow: 'escrows',
  check: 'checks',
  payment_channel: 'payment_channels',
};

/** The 404 message of each kind. */
export const NOT_FOUND_OF: Record<ObjectKind, string> = {
  escrow: 'escrow not found',
  check: 'check not found',
  payment_channel: 'payment channel not found',
};

/** How many events the detail of an object embeds; it reads one more to know whether there are more. */
export const DETAIL_EVENTS = 50;

/** The newest committed ledger and when it closed (unix seconds): the point an answer is as of, and the cap of every read of it. */
export interface AsOf {
  ledger_index: number;
  close_time: number;
}

/**
 * The detail of an object: the newest rows of its history (newest first, `DETAIL_EVENTS + 1` at most: the one more only tells
 * that there are more), and the row that created it when the index has it. `counts` is the payment channels' (spec 5.5).
 */
export interface ObjectDetail {
  asOf: AsOf;
  rows: ObjectRead[];
  created?: ObjectRead;
  counts?: ChannelCounts;
}

/** The `funds` and `claims` of a payment channel: the events that added to it, and the events that moved its `Balance`. */
export interface ChannelCounts {
  funds: number;
  claims: number;
}

/** One page of the history of an object, in the order asked for, with the row that created it when the index has it. */
export interface ObjectHistory {
  asOf: AsOf;
  rows: ObjectRead[];
  created?: ObjectRead;
  marker?: string;
}

/** The key of a history, the end of the ORDER BY of `object_changes`: what a marker holds (one route and direction each). */
export const OBJECT_POSITION: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
];

/** The whole ORDER BY of `object_changes`: the object is fixed by the read, but the read has to ask for the whole key. */
const OBJECT_ORDER = ['object_type', 'object_id', ...columnsOf(OBJECT_POSITION)];

/** The columns of a row of `ObjectRead`: the close time in unix seconds, the JSON columns as the text they are stored in. */
const COLUMNS = [
  'object_type',
  'object_id',
  'ledger_index',
  'tx_index',
  'tx_hash',
  'toUnixTimestamp(close_time) AS close_time',
  'tx_type',
  'result',
  'sender',
  'delegate',
  'action',
  'event',
  'owner',
  'counterparty',
  'fields',
  'previous',
  'event_fields',
].join(', ');

/** A row as ClickHouse gives it: `ObjectRead` with its three JSON columns still text. */
type StoredRow = Omit<ObjectRead, 'fields' | 'previous' | 'event_fields'> & {
  fields: string;
  previous: string;
  event_fields: string;
};

const readOf = (row: StoredRow): ObjectRead => ({
  ...row,
  ledger_index: Number(row.ledger_index),
  tx_index: Number(row.tx_index),
  close_time: Number(row.close_time),
  fields: JSON.parse(row.fields) as Record<string, unknown>,
  previous: JSON.parse(row.previous) as Record<string, unknown>,
  event_fields: JSON.parse(row.event_fields) as Record<string, unknown>,
});

/** The prefix of an object's rows up to the head: the object, then every ledger up to `H`. */
const OBJECT_PREFIX = 'object_type = {type:String} AND object_id = {id:String} AND ledger_index <= {H:UInt32}';

/**
 * The history of the escrows, checks and payment channels (spec 3), read at query time from `object_changes`. Every read is
 * capped at the newest committed ledger `H` (the `ledgers` commit marker), whose index and close time the answer carries and
 * its `status` is evaluated at; with no committed ledger the answer is the 404 of the kind.
 *
 *  - **The detail** reads the newest `DETAIL_EVENTS + 1` rows of the object (a page of `readDistinctPage`, newest first). No
 *    row is the 404. The creation is the page's row of `created`, else, when the page is full (the object has older events),
 *    the first row of the object's prefix with `action = 'created'`; a page that is not full holds the whole history, so
 *    there is no creation to look for. A payment channel's detail also reads its counts (`funds`, `claims`): one read of
 *    the channel's prefix beside the page.
 *  - **The history** reads, side by side, the page (limit + 1 rows in the order asked for, after the marker), the creation
 *    and, with a marker, one row of the object's prefix: no row at all is the 404, while a page past the end of an object
 *    that has rows is `count: 0`. Without a marker an empty page is already the 404.
 *
 * A marker is `(ledger_index, tx_index)` of the last row of a page; it belongs to one route and one direction.
 */
@Injectable()
export class LedgerObjectsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
  ) {}

  /**
   * The newest rows of the object and its creation, and for a payment channel its counts. Throws the 404 of the kind when the
   * object has no row up to the head.
   */
  detail(kind: 'payment_channel', id: string): Promise<ObjectDetail & { counts: ChannelCounts }>;
  detail(kind: ObjectKind, id: string): Promise<ObjectDetail>;
  async detail(kind: ObjectKind, id: string): Promise<ObjectDetail> {
    const asOf = await this.head(kind);
    const type = OBJECT_TYPE_OF[kind];
    // the counts read runs beside the page: both are the object's prefix, and an object with no row is the 404 whatever they say
    const [rows, counts] = await Promise.all([
      this.page(type, id, asOf, { descending: true, limit: DETAIL_EVENTS + 1 }),
      kind === 'payment_channel' ? this.counts(id, asOf) : undefined,
    ]);
    if (rows.length === 0) throw notFound(NOT_FOUND_OF[kind]);
    const created =
      rows.find((row) => row.action === 'created') ??
      (rows.length > DETAIL_EVENTS ? await this.creation(type, id, asOf) : undefined);
    return { asOf, rows, ...(created !== undefined && { created }), ...(counts !== undefined && { counts }) };
  }

  /** One page of the history. Throws 400 `invalid marker` for a marker that is none of ours, and the 404 of the kind for an object with no row. */
  async history(
    kind: ObjectKind,
    id: string,
    o: { descending: boolean; limit: number; marker?: string },
  ): Promise<ObjectHistory> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the object is
    const after = decodeMarker(o.marker, OBJECT_POSITION);
    const asOf = await this.head(kind);
    const type = OBJECT_TYPE_OF[kind];
    const [rows, creation, known] = await Promise.all([
      this.page(type, id, asOf, { descending: o.descending, limit: o.limit + 1, after }),
      this.creation(type, id, asOf),
      after === undefined ? undefined : this.known(type, id, asOf),
    ]);
    if (rows.length === 0 && (after === undefined || !known)) throw notFound(NOT_FOUND_OF[kind]);
    const page = paginate(rows, o.limit, (row) => [row.ledger_index, row.tx_index]);
    const created = page.rows.find((row) => row.action === 'created') ?? creation;
    return {
      asOf,
      rows: page.rows,
      ...(created !== undefined && { created }),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }

  /** The newest committed ledger, or the 404 of the kind when none is committed. */
  private async head(kind: ObjectKind): Promise<AsOf> {
    const asOf = await this.ranges.latestWithTime();
    if (asOf === undefined) throw notFound(NOT_FOUND_OF[kind]);
    return asOf;
  }

  /** A page of the object's rows up to the head, each once, in the order of the key; `after` is the decoded marker. */
  private async page(
    type: TrackedObjectType,
    id: string,
    asOf: AsOf,
    o: { descending: boolean; limit: number; after?: KeyValue[] },
  ): Promise<ObjectRead[]> {
    // `ledger_index` is the column after the object, which the query fixes: `keysetClause` bounds it on its own, which
    // ClickHouse narrows the read with
    const cursor = keysetClause(OBJECT_POSITION, o.descending, o.after);
    const rows = await readDistinctPage<StoredRow>(this.ch, {
      columns: COLUMNS,
      table: Table.ObjectChanges,
      where: [OBJECT_PREFIX, ...(cursor.clause !== '' ? [cursor.clause] : [])],
      orderBy: OBJECT_ORDER,
      unique: columnsOf(OBJECT_POSITION),
      descending: o.descending,
      params: { type, id, H: asOf.ledger_index, ...cursor.params },
      limit: o.limit,
    });
    return rows.map(readOf);
  }

  /**
   * The row that created the object: an object has one creation (its id is made of a sequence nobody uses twice), and it is
   * the first row the index holds of it. The read therefore goes from the start of the object's prefix and stops at the first
   * `created` row, which a long-lived channel has in its first granule; the other way round it would walk the whole prefix (every
   * event of the object up to the head) on every call. The read is the prefix of the object and nothing else.
   */
  private async creation(type: TrackedObjectType, id: string, asOf: AsOf): Promise<ObjectRead | undefined> {
    const [row] = await this.ch.query<StoredRow>(
      `SELECT ${COLUMNS}
         FROM ${Table.ObjectChanges}
        WHERE ${OBJECT_PREFIX} AND action = 'created'
        ORDER BY ${OBJECT_ORDER.join(', ')}
        LIMIT 1`,
      { type, id, H: asOf.ledger_index },
    );
    return row === undefined ? undefined : readOf(row);
  }

  /**
   * The counts of a payment channel, one read of the channel's prefix with each transaction once (a row stored twice counts once):
   * `funds` are the `fund` events and `claims` the events whose `previous` holds a `Balance`, that is the events that moved it.
   * A channel's first claim is one, as its previous balance is "0" on both networks, while a created node may have no `Balance`.
   */
  private async counts(id: string, asOf: AsOf): Promise<ChannelCounts> {
    const [row] = await this.ch.query<{ funds: string; claims: string }>(
      `SELECT countIf(event = 'fund') AS funds, countIf(JSONHas(previous, 'Balance')) AS claims
         FROM (SELECT event, previous FROM ${Table.ObjectChanges}
                WHERE ${OBJECT_PREFIX}
                ORDER BY ${OBJECT_ORDER.join(', ')}
                LIMIT 1 BY ledger_index, tx_index)`,
      { type: OBJECT_TYPE_OF.payment_channel, id, H: asOf.ledger_index },
    );
    return { funds: Number(row?.funds ?? 0), claims: Number(row?.claims ?? 0) };
  }

  /** Whether the object has a row up to the head: one row of its prefix. */
  private async known(type: TrackedObjectType, id: string, asOf: AsOf): Promise<boolean> {
    const rows = await this.ch.query<{ ledger_index: number }>(
      `SELECT ledger_index FROM ${Table.ObjectChanges}
        WHERE ${OBJECT_PREFIX}
        ORDER BY ${OBJECT_ORDER.join(', ')}
        LIMIT 1`,
      { type, id, H: asOf.ledger_index },
    );
    return rows.length > 0;
  }
}
