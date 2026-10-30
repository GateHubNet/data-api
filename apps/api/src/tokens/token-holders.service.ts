import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { decodeMarker, encodeMarker, KeysetKey } from '../common/pagination';
import { HolderRow, holderRow } from './token-objects';
import type { TokenRef } from './token-param';
import type { LiveTokens } from './tokens.service';

/**
 * The holders of one token (spec 5.3): the token's lines with a balance above 0, by balance descending, then holder, each with its
 * place (`rank`) and its share of the supply.
 */

/** `[balance_f, holder]` of a holder: the key of the order of the holders. */
export type HolderKey = [number, string];

/**
 * The columns of the marker. `balance_f` is the Float64 the order is made on, not the exact `balance` text: two balances that
 * are different texts and the same double (`9007199254740992` and `9007199254740993`) are a tie of the order, broken by holder.
 */
const HOLDER_KEYS: KeysetKey[] = [
  { column: 'balance_f', type: 'Float64' },
  { column: 'holder', type: 'String' },
];

/** The marker of a page: the base64url JSON of the `balance_f` and the holder of its last row. */
export function encodeHoldersMarker(balance: number, holder: string): string {
  return encodeMarker([balance, holder]);
}

/**
 * The key of a marker, or `undefined` for the first page. Anything that is not a marker of this list answers 400 `invalid marker`
 * (`decodeMarker`): text that is not base64url, JSON that is not a pair, a balance that is not a finite number, a holder that is
 * not text.
 */
export function decodeHoldersMarker(marker: string | undefined): HolderKey | undefined {
  const values = decodeMarker(marker, HOLDER_KEYS);
  return values === undefined ? undefined : [values[0] as number, values[1] as string];
}

/** A holder as ClickHouse returns it (the `UInt8` flags are numbers, `rank` a `UInt32`). */
interface StoredHolder {
  holder: string;
  balance: string;
  balance_f: number;
  limit: string;
  frozen: number;
  authorized: number;
  rank: number;
}

@Injectable()
export class TokenHoldersService {
  constructor(private readonly ch: ClickHouseService) {}

  /**
   * One page of the holders of `ref` in the live generation, after `after` (the key of the last row of the page before). `supply`
   * is the token's (its row's), which the shares are of. A marker is `undefined` on the last page.
   *
   * The read is the token's prefix of `token_lines` in the generation's partition: every version of its lines, the newest of each
   * holder (`ORDER BY holder, version DESC LIMIT 1 BY holder`), and only then `deleted = 0` and a balance above 0. The ranks are
   * worked out over all of them (`row_number()`), before the marker narrows the rows, so a page far into the list has the
   * ranks of the whole list. One row more than the page was asked for tells that there is a next page.
   */
  async page(
    live: LiveTokens,
    ref: TokenRef,
    o: { supply: string; limit: number; after?: HolderKey },
  ): Promise<{ rows: HolderRow[]; marker?: string }> {
    const after = o.after;
    const stored = await this.ch.query<StoredHolder>(
      `SELECT holder, balance, balance_f, \`limit\`, frozen, authorized, rank
         FROM (SELECT holder, balance, balance_f, \`limit\`, frozen, authorized,
                      toUInt32(row_number() OVER (ORDER BY balance_f DESC, holder ASC)) AS rank
                 FROM (SELECT holder, balance, balance_f, \`limit\`, frozen, authorized, deleted
                         FROM ${Table.TokenLines}
                        WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
                        ORDER BY holder, version DESC
                        LIMIT 1 BY holder)
                WHERE deleted = 0 AND balance_f > 0)
        ${after ? 'WHERE balance_f < {b:Float64} OR (balance_f = {b:Float64} AND holder > {h:String})' : ''}
        ORDER BY balance_f DESC, holder ASC
        LIMIT {fetch:UInt32}`,
      {
        g: live.generation,
        issuer: ref.issuer,
        currency: ref.currency,
        fetch: o.limit + 1,
        ...(after && { b: after[0], h: after[1] }),
      },
    );
    const page = stored.slice(0, o.limit);
    const last = page[page.length - 1];
    return {
      rows: page.map((h) => holderRow(h, o.supply)),
      ...(stored.length > o.limit && { marker: encodeHoldersMarker(last.balance_f, last.holder) }),
    };
  }
}
