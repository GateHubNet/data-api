import { ParserTx } from './parser.interface';

/** The highest destination tag: the field is a UInt32. */
export const MAX_DESTINATION_TAG = 4_294_967_295;

/** A transaction's own `Destination` and `DestinationTag` (`account_tx_by_destination_tag`, spec 4). */
export interface ParsedDestinationTag {
  destination: string;
  destination_tag: number;
}

export class DestinationTagParser {
  /**
   * The destination and the destination tag of a transaction (spec 5): defined when its `Destination` is a string and its
   * `DestinationTag` an integer from 0 to `MAX_DESTINATION_TAG`. Tag 0 is a tag like any other.
   *
   * The rule reads the two fields, never a list of transaction types, so a type added later with both fields is read
   * without a code change. Every result counts, `tec` ones included, and a Batch inner transaction counts like any other.
   * A transaction without a `Destination`, or with a `DestinationTag` that is not such an integer, gives undefined and
   * never throws (a ledger the parsers cannot read halts the ingest).
   *
   * Pure: nothing in `t` is modified.
   */
  parse(t: ParserTx): ParsedDestinationTag | undefined {
    const destination: unknown = t.tx.Destination;
    const tag: unknown = t.tx.DestinationTag;
    if (typeof destination !== 'string') return undefined;
    if (typeof tag !== 'number' || !Number.isInteger(tag) || tag < 0 || tag > MAX_DESTINATION_TAG) return undefined;
    return { destination, destination_tag: tag };
  }
}
