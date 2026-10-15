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
import { NETWORK_PROFILE } from '../config/api.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { BinaryCodecService, withoutDeliverMax } from './binary-codec.service';
import { fmtTxDate } from './format';

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
 */
@Injectable()
export class TxService {
  private readonly logger = new Logger(TxService.name);
  private readonly ctx: ParseContext;

  constructor(
    private readonly ch: ClickHouseService,
    private readonly codec: BinaryCodecService,
    @Inject(NETWORK_PROFILE) profile: NetworkProfile,
    private readonly prometheus: PrometheusService,
  ) {
    this.ctx = parseContextFor(profile);
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
   * The API object of a stored transaction.
   *
   *  - JSON mode: `tx` and `meta` are what the Ripple API served, the binary form decoded again:
   *    `decode(encode(stored))` with the definitions of the network. That drops what rippled adds to its JSON and
   *    the binary does not carry (`DeliverMax`, `type` and `type_hex` in the steps of `Paths`, rippled's own
   *    `meta.delivered_amount`), writes UInt64 fields as 16 upper case hex digits and lists the fields in the order of
   *    the binary format. A successful Payment then gets `meta.delivered_amount`: `DeliveredAmount`, else `Amount`
   *    unless the payment is partial and from before the fix (`'unavailable'`), as the Ripple API worked it out.
   *    An issued-currency or MPT amount is cloned, so that no object is shared inside the answer.
   *  - Binary mode: `tx` and `meta` are the serialized original as upper case hex, without the injected field.
   *
   * A transaction that the codec cannot serialize (a type or field the definitions lack, a malformed value) must not
   * fail the page it is on: it is served as its stored JSON in either mode (without `DeliverMax` when `Amount` says
   * the same), with a warning in the log and `api_tx_encode_fallback_total{mode}` counted.
   */
  toTxObject(row: TransactionsRow, o: { binary: boolean; ledgerHash?: string }): TxObject {
    const stored = {
      tx: JSON.parse(row.tx_json) as Record<string, unknown>,
      meta: JSON.parse(row.meta_json) as Record<string, unknown>,
    };
    const head = {
      hash: row.hash,
      ledger_index: row.ledger_index,
      date: fmtTxDate(row.close_time),
      ...(o.ledgerHash !== undefined && { ledger_hash: o.ledgerHash }),
    };

    let { tx, meta } = stored;
    try {
      if (o.binary) return { ...head, tx: this.codec.encode(tx), meta: this.codec.encode(meta) };
      // Both before either is used: a transaction is served canonical or as stored, never half of each.
      const canonical = {
        tx: this.codec.decode(this.codec.encode(tx)),
        meta: this.codec.decode(this.codec.encode(meta)),
      };
      ({ tx, meta } = canonical);
    } catch (err) {
      this.fellBack(row, o.binary, err);
      tx = withoutDeliverMax(tx);
    }

    if (tx.TransactionType === 'Payment' && meta.TransactionResult === 'tesSUCCESS') {
      meta = { ...meta, delivered_amount: copyOf(deliveredAmount(tx, meta, row.ledger_index, this.ctx)) };
    }
    return { ...head, tx, meta };
  }

  private fellBack(row: TransactionsRow, binary: boolean, err: unknown): void {
    this.prometheus.txEncodeFallback.inc({ mode: binary ? 'binary' : 'json' });
    this.logger.warn(
      `Cannot serialize ${row.tx_type} ${row.hash} with the ${this.codec.definitionsSource} definitions ` +
        `(${err instanceof Error ? err.message : String(err)}); serving its stored JSON`,
    );
  }
}
