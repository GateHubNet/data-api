import { NetworkProfile } from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { Coverage, FeatureCoverageService } from '../common/feature-coverage.service';
import { fmtTime } from '../common/format';
import { paginate } from '../common/pagination';
import { NETWORK_PROFILE } from '../config/api.config';
import { CsvRow } from '../nft/nft-objects';
import {
  AsOf,
  DETAIL_EVENTS,
  FEATURE_OF,
  LedgerObjectsService,
  ObjectDetail,
  ObjectHistory,
  ObjectKind,
} from './ledger-objects.service';
import {
  CheckObject,
  checkObject,
  EscrowObject,
  escrowObject,
  ObjectEvent,
  objectEvent,
  objectEventCsvRow,
  ObjectRead,
  PaymentChannelObject,
  paymentChannelObject,
} from './object-views';

/** What every answer of an object starts with: `result`, the object's `coverage`, and the point it is as of (`DETAIL_BODY_KEYS`). */
interface ObjectBodyHead {
  result: 'success';
  coverage: Coverage;
  ledger_index: number;
  close_time: string;
}

/** The newest events of the object, newest first, and `history_marker` when there are more (it continues `/history?descending=true`). */
interface EmbeddedHistory {
  history: ObjectEvent[];
  history_marker?: string;
}

/** `GET /v2/escrows/{id}`: the keys are `DETAIL_BODY_KEYS.escrow`, in this order. */
export interface EscrowBody extends ObjectBodyHead, EmbeddedHistory {
  escrow: EscrowObject;
}

/** `GET /v2/checks/{id}`: the keys are `DETAIL_BODY_KEYS.check`, in this order. */
export interface CheckBody extends ObjectBodyHead, EmbeddedHistory {
  check: CheckObject;
}

/** `GET /v2/payment_channels/{id}`: the keys are `DETAIL_BODY_KEYS.payment_channel`, in this order. */
export interface PaymentChannelBody extends ObjectBodyHead, EmbeddedHistory {
  payment_channel: PaymentChannelObject;
}

/** `GET /v2/{escrows,checks,payment_channels}/{id}/history`: the keys are `HISTORY_BODY_KEYS`, in this order; `history` is the CSV rows for `format=csv`. */
export interface ObjectHistoryBody extends ObjectBodyHead {
  count: number;
  marker?: string;
  history: ObjectEvent[] | CsvRow[];
}

/**
 * The answers of the escrow, check and payment channel routes, built from what `LedgerObjectsService` read: the object as of
 * the newest committed ledger (its `status` is evaluated at that ledger's close time), its newest `DETAIL_EVENTS` events, and
 * `history_marker` when there are more. The `coverage` is the object's own: complete when its creation is indexed (spec 1.4).
 *
 * Each kind of object has one method here, the three steps of every detail (read, coverage, answer) in one place; the
 * controllers check their parameters, call it, and set the headers. `GET /v2/escrows/{id}` and the owner and sequence route of
 * an escrow are both `escrow(id)`.
 */
@Injectable()
export class ObjectAnswers {
  constructor(
    private readonly objects: LedgerObjectsService,
    private readonly coverage: FeatureCoverageService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  /** The escrow with the ID. Throws `escrow not found` for an escrow with no row up to the newest committed ledger. */
  async escrow(id: string): Promise<EscrowBody> {
    const detail = await this.objects.detail('escrow', id);
    const { asOf, rows, created } = detail;
    return {
      ...(await this.start('escrow', asOf, created)),
      escrow: escrowObject(rows[0], created, asOf.close_time, this.native),
      ...this.embedded(detail),
    };
  }

  /** The check with the ID. Throws `check not found` for a check with no row up to the newest committed ledger. */
  async check(id: string): Promise<CheckBody> {
    const detail = await this.objects.detail('check', id);
    const { asOf, rows, created } = detail;
    return {
      ...(await this.start('check', asOf, created)),
      check: checkObject(rows[0], created, asOf.close_time, this.native),
      ...this.embedded(detail),
    };
  }

  /** The payment channel with the ID. Throws `payment channel not found` for a channel with no row up to the newest committed ledger. */
  async paymentChannel(id: string): Promise<PaymentChannelBody> {
    const detail = await this.objects.detail('payment_channel', id);
    const { asOf, rows, created, counts } = detail;
    return {
      ...(await this.start('payment_channel', asOf, created)),
      payment_channel: paymentChannelObject(rows[0], created, counts, asOf.close_time, this.native),
      ...this.embedded(detail),
    };
  }

  /**
   * One page of the history of an object (`csv`: the rows of the CSV, every column of the kind's events; the answer is the
   * same otherwise). The service throws the 400 `invalid marker` and the 404 of the kind.
   */
  async history(
    kind: ObjectKind,
    id: string,
    o: { descending: boolean; limit: number; marker?: string; csv: boolean },
  ): Promise<ObjectHistoryBody> {
    const found: ObjectHistory = await this.objects.history(kind, id, o);
    const events = found.rows.map((row) => objectEvent(row, this.native));
    return {
      ...(await this.start(kind, found.asOf, found.created)),
      count: events.length,
      ...(found.marker !== undefined && { marker: found.marker }),
      history: o.csv ? events.map((event) => objectEventCsvRow(event, kind)) : events,
    };
  }

  private get native(): string {
    return this.profile.nativeCurrency;
  }

  /** `result`, the `coverage` of the object (complete when `created` is indexed) and the point the answer is as of. */
  private async start(kind: ObjectKind, asOf: AsOf, created: ObjectRead | undefined): Promise<ObjectBodyHead> {
    return {
      result: 'success',
      coverage: await this.coverage.itemCoverage(FEATURE_OF[kind], created?.ledger_index),
      ledger_index: asOf.ledger_index,
      close_time: fmtTime(asOf.close_time),
    };
  }

  /** The newest `DETAIL_EVENTS` rows of a detail as events, and the marker for the rest (the read holds one more to tell). */
  private embedded(detail: ObjectDetail): EmbeddedHistory {
    const page = paginate(detail.rows, DETAIL_EVENTS, (row) => [row.ledger_index, row.tx_index]);
    return {
      history: page.rows.map((row) => objectEvent(row, this.native)),
      ...(page.marker !== undefined && { history_marker: page.marker }),
    };
  }
}
