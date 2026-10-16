import {
  ClickHouseService,
  deliveredAmount,
  NetworkProfile,
  ParseContext,
  parseContextFor,
  Table,
  TransactionsRow,
} from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfig, NETWORK_PROFILE } from '../config/api.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { BinaryCodecService, withoutDeliverMax } from './binary-codec.service';
import { fmtTxDate } from './format';
import { LruCache } from './lru-cache';

/**
 * A transaction as the Ripple API serves it (`hash, ledger_index, date, ledger_hash?, tx, meta`, in this order, as
 * `lib/hbase/hbase-thrift/data.js` builds it). `tx` and `meta` are the JSON of the node, or with `binary=true` their
 * serialization as upper case hex.
 */
export interface TxObject {
  hash: string;
  ledger_index: number;
  /** `YYYY-MM-DDTHH:mm:ss+00:00` */
  date: string;
  ledger_hash?: string;
  tx: object | string;
  meta: object | string;
}

/** A copy that shares nothing with `value` (a drops string is returned as it is). */
function copyOf<T>(value: T): T {
  return typeof value === 'object' && value !== null ? structuredClone(value) : value;
}

/** How many transactions of a page are converted before the event loop gets a turn. */
export const PAGE_SLICE = 50;

/** The canonical JSON of a transaction: `tx` and `meta` as the binary form decodes them, before `delivered_amount`. */
interface CanonicalForm {
  tx: Record<string, unknown>;
  meta: Record<string, unknown>;
}

/** The columns `TxService` reads, as the `TransactionsRow` the syncer writes. */
const TRANSACTION_COLUMNS = [
  'ledger_index',
  'tx_index',
  'hash',
  'tx_type',
  'result',
  'account',
  'sequence',
  'toString(fee) AS fee',
  'toUnixTimestamp(close_time) AS close_time',
  'tx_json',
  'meta_json',
].join(', ');

/**
 * Reads transactions for the endpoints and turns a stored row into the object they answer with. The endpoints find
 * the keys (`ledger_index`, `tx_index`) in the lookup table that suits their filter and hand them over here.
 *
 * Serializing a transaction costs 0.7 to 1.5 ms, synchronously, and a page may hold 1000 of them. Two things keep that
 * from stalling the process (ruling R41): the serialized forms are kept by transaction hash (`GH_TX_CACHE_SIZE`
 * entries; a transaction never changes, and the cache is dropped when the codec switches to other definitions), and
 * `toTxObjects` converts a page in slices of `PAGE_SLICE`, letting the event loop run in between.
 */
@Injectable()
export class TxService {
  private readonly logger = new Logger(TxService.name);
  private readonly ctx: ParseContext;
  /**
   * Per hash, as strings: `json:<hash>` holds the JSON of a `CanonicalForm`, `bin:<hash>` the two hex blobs joined by
   * `|`. A string cannot be changed by whoever is handed what was parsed from it, so no response can corrupt an entry,
   * and parsing one is several times cheaper than decoding the binary again.
   */
  private readonly cache?: LruCache<string>;
  private cacheGeneration: number;

  constructor(
    private readonly ch: ClickHouseService,
    private readonly codec: BinaryCodecService,
    @Inject(NETWORK_PROFILE) profile: NetworkProfile,
    private readonly prometheus: PrometheusService,
    config: ApiConfig,
  ) {
    this.ctx = parseContextFor(profile);
    this.cache = config.txCacheSize > 0 ? new LruCache<string>(config.txCacheSize) : undefined;
    this.cacheGeneration = codec.generation;
  }

  /**
   * The transactions with the given keys, in the order of the keys, from one query. A key without a transaction is
   * left out; a key that is given twice is answered twice.
   */
  async fetchByKeys(keys: { ledger_index: number; tx_index: number }[]): Promise<TransactionsRow[]> {
    if (keys.length === 0) return [];
    const rows = await this.ch.query<TransactionsRow>(
      `SELECT ${TRANSACTION_COLUMNS}
         FROM ${Table.Transactions}
        WHERE (ledger_index, tx_index) IN (
              SELECT tupleElement(key, 1), tupleElement(key, 2)
                FROM (SELECT arrayJoin(arrayZip({ledgers:Array(UInt32)}, {indexes:Array(UInt32)})) AS key))`,
      { ledgers: keys.map((k) => k.ledger_index), indexes: keys.map((k) => k.tx_index) },
    );
    const byKey = new Map(rows.map((row) => [`${row.ledger_index}:${row.tx_index}`, row]));
    return keys.flatMap((k) => byKey.get(`${k.ledger_index}:${k.tx_index}`) ?? []);
  }

  /** The hash of each of the ledgers; an index that is not a committed ledger is not in the map. */
  async ledgerHashes(indexes: number[]): Promise<Map<number, string>> {
    if (indexes.length === 0) return new Map();
    const rows = await this.ch.query<{ ledger_index: number; ledger_hash: string }>(
      `SELECT ledger_index, ledger_hash FROM ${Table.Ledgers} WHERE ledger_index IN {indexes:Array(UInt32)}`,
      { indexes: [...new Set(indexes)] },
    );
    return new Map(rows.map((row) => [row.ledger_index, row.ledger_hash]));
  }

  /**
   * The API objects of a page of stored transactions, in the order of `rows`, each with the ledger hash of its ledger
   * from `ledgerHashes` (see `ledgerHashes()`). Same as `toTxObject` per row, but after every `PAGE_SLICE` rows it lets
   * the event loop run, so that a page of 1000 does not hold up every other request for as long as it takes.
   */
  async toTxObjects(
    rows: TransactionsRow[],
    o: { binary: boolean; ledgerHashes?: Map<number, string> },
  ): Promise<TxObject[]> {
    const objects: TxObject[] = [];
    for (const [i, row] of rows.entries()) {
      if (i > 0 && i % PAGE_SLICE === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      objects.push(this.toTxObject(row, { binary: o.binary, ledgerHash: o.ledgerHashes?.get(row.ledger_index) }));
    }
    return objects;
  }

  /**
   * The API object of a stored transaction.
   *
   *  - JSON mode: `tx` and `meta` are what the Ripple API served, the binary form decoded again:
   *    `decode(encode(stored))` with the definitions of the network (an empty AccountID stays `""`, see
   *    `BinaryCodecService.roundTrip`). That drops what rippled adds to its JSON and
   *    the binary does not carry (`DeliverMax`, `type` and `type_hex` in the steps of `Paths`, rippled's own
   *    `meta.delivered_amount`), writes UInt64 fields as 16 upper case hex digits and lists the fields in the order of
   *    the binary format. A successful Payment then gets `meta.delivered_amount`: `DeliveredAmount`, else `Amount`
   *    unless the payment is partial and from before the fix (`'unavailable'`), as the Ripple API worked it out.
   *    An issued-currency or MPT amount is cloned, so that no object is shared inside the answer.
   *  - Binary mode: `tx` and `meta` are the serialized original as upper case hex, without the injected field: the
   *    node's bytes, which re-hash to the transaction hash (an empty AccountID is a zero-length field, ruling R97).
   *
   * Every call returns objects of its own (nothing is shared with the cache or with other calls).
   *
   * A transaction that the codec cannot serialize (a type or field the definitions lack, a malformed value) must not
   * fail the page it is on: it is served as its stored JSON in either mode (without `DeliverMax` when `Amount` says
   * the same), with a warning in the log and `api_tx_encode_fallback_total{mode}` counted.
   */
  toTxObject(row: TransactionsRow, o: { binary: boolean; ledgerHash?: string }): TxObject {
    const head = {
      hash: row.hash,
      ledger_index: row.ledger_index,
      date: fmtTxDate(row.close_time),
      ...(o.ledgerHash !== undefined && { ledger_hash: o.ledgerHash }),
    };

    let tx: Record<string, unknown>;
    let meta: Record<string, unknown>;
    try {
      if (o.binary) return { ...head, ...this.serialized(row) };
      ({ tx, meta } = this.canonical(row));
    } catch (err) {
      this.fellBack(row, o.binary, err);
      tx = withoutDeliverMax(JSON.parse(row.tx_json) as Record<string, unknown>);
      meta = JSON.parse(row.meta_json) as Record<string, unknown>;
    }

    if (tx.TransactionType === 'Payment' && meta.TransactionResult === 'tesSUCCESS') {
      meta = { ...meta, delivered_amount: copyOf(deliveredAmount(tx, meta, row.ledger_index, this.ctx)) };
    }
    return { ...head, tx, meta };
  }

  /**
   * `decode(encode(stored))` of the transaction and of its metadata (`roundTrip`). Throws what the codec cannot
   * serialize.
   */
  private canonical(row: TransactionsRow): CanonicalForm {
    const key = `json:${row.hash}`;
    const hit = this.cacheGet(key);
    if (hit !== undefined) return JSON.parse(hit) as CanonicalForm;

    // Both before either is used: a transaction is served canonical or as stored, never half of each. `roundTrip` is
    // decode(encode()) that keeps an empty AccountID ("", Xahau's UNLReport) as the node shows it.
    const tx = this.codec.roundTrip(JSON.parse(row.tx_json));
    const meta = this.codec.roundTrip(JSON.parse(row.meta_json));
    this.cacheSet(key, JSON.stringify({ tx, meta }));
    return { tx, meta };
  }

  /** The two blobs of the transaction as upper case hex. Throws what the codec cannot serialize. */
  private serialized(row: TransactionsRow): { tx: string; meta: string } {
    const key = `bin:${row.hash}`;
    const hit = this.cacheGet(key);
    if (hit !== undefined) {
      const [tx, meta] = hit.split('|');
      return { tx, meta };
    }
    const tx = this.codec.encode(JSON.parse(row.tx_json));
    const meta = this.codec.encode(JSON.parse(row.meta_json));
    this.cacheSet(key, `${tx}|${meta}`);
    return { tx, meta };
  }

  private cacheGet(key: string): string | undefined {
    return this.currentCache()?.get(key);
  }

  private cacheSet(key: string, value: string): void {
    this.currentCache()?.set(key, value);
  }

  /** The cache, emptied first if the codec has other definitions than the ones it was filled under. */
  private currentCache(): LruCache<string> | undefined {
    if (this.cache && this.cacheGeneration !== this.codec.generation) {
      this.cache.clear();
      this.cacheGeneration = this.codec.generation;
    }
    return this.cache;
  }

  private fellBack(row: TransactionsRow, binary: boolean, err: unknown): void {
    this.prometheus.txEncodeFallback.inc({ mode: binary ? 'binary' : 'json' });
    this.logger.warn(
      `Cannot serialize ${row.tx_type} ${row.hash} with the ${this.codec.definitionsSource} definitions ` +
        `(${err instanceof Error ? err.message : String(err)}); serving its stored JSON`,
    );
  }
}
