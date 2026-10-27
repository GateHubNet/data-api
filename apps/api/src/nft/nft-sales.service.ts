import {
  Asset,
  ClickHouseService,
  convertedSalePrices,
  DailyRates,
  NftEventsRow,
  readDistinctPage,
  saleKey,
  Table,
} from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { FeatureCoverageService } from '../common/feature-coverage.service';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { columnsOf, decodeMarker, keysetClause, paginate } from '../common/pagination';
import { SalesAnswer } from './nft-collections.service';
import { toNftSaleObject } from './nft-objects';
import { EVENT_COLUMNS, NFT_EVENT_POSITION } from './nfts.service';

/** The window and the page of the sales of the network. The values are already validated. */
export interface NetworkSalesQuery {
  /** Inclusive; without it from the first ledger. */
  start?: Date;
  /** Exclusive; without it to the newest ledger. */
  endExclusive?: Date;
  /** Only the sales priced in this asset (the native currency has no issuer); without it every sale. */
  asset?: Asset;
  descending: boolean;
  limit: number;
  /** As the client got it from the last page; `decodeMarker` checks it. */
  marker?: string;
}

/**
 * `GET /v2/nft_sales` (spec section 5.11): the sales of the network from `nft_sales`, which is ordered by
 * `(ledger_index, tx_index, event_index)`, as `NftSale` objects with their converted price (`convertedSalePrices`, the one
 * conversion of a price). The answer states `coverage('nfts')`, the feature's own.
 *
 * The page is a range of the table's primary key, the ledgers that closed in the window (committed ones only: the range ends
 * at the newest `ledgers` row), read in the order of the key a page at a time by `readDistinctPage`. The bound is the window's
 * ledger range, whatever the filter: the asset of `currency` is a condition of the read that is capped, as the kind of event is
 * in a history, because a filter applied to the rows of a page would leave a page short or empty while there is a next one. A
 * currency that few sales are priced in is found by reading through the window until the page is full, so the cost of its page
 * grows with the sales of the window that are not in it, up to the whole window; the sales of all currencies, and the page of
 * a window, are a few granules (`paged-reads.e2e-spec.ts`).
 */
@Injectable()
export class NftSalesService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
    private readonly coverage: FeatureCoverageService,
    private readonly rates: DailyRates,
  ) {}

  /** One page of the sales in the order asked for. */
  async list(q: NetworkSalesQuery): Promise<SalesAnswer> {
    // before any query: a marker that is none of ours is the client's mistake
    const after = decodeMarker(q.marker, NFT_EVENT_POSITION);
    const coverage = await this.coverage.coverage('nfts');

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { coverage, sales: [] };

    // the key is the table's whole order, so the keyset bounds the first column of it on its own and the read starts at the marker
    const cursor = keysetClause(NFT_EVENT_POSITION, q.descending, after);
    const rows = await readDistinctPage<NftEventsRow>(this.ch, {
      columns: EVENT_COLUMNS,
      table: Table.NftSales,
      where: [
        'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
        ...(q.asset !== undefined ? ['currency = {currency:String}', 'amount_issuer = {amount_issuer:String}'] : []),
        ...(cursor.clause !== '' ? [cursor.clause] : []),
      ],
      orderBy: columnsOf(NFT_EVENT_POSITION),
      unique: columnsOf(NFT_EVENT_POSITION),
      descending: q.descending,
      params: {
        min: range.min,
        max: range.max,
        ...(q.asset !== undefined && { currency: q.asset.currency, amount_issuer: q.asset.issuer ?? '' }),
        ...cursor.params,
      },
      limit: q.limit + 1,
    });
    const page = paginate(rows, q.limit, (r) => [r.ledger_index, r.tx_index, r.event_index]);
    const converted = await convertedSalePrices(this.ch, this.rates, page.rows);
    return {
      coverage,
      sales: page.rows.map((r) => toNftSaleObject(r, converted.get(saleKey(r)))),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }
}
