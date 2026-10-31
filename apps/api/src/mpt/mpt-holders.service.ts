import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { paginate } from '../common/pagination';
import { StoredMptHolder } from './mpt-objects';

/** A holder's balance, which orders the list. */
const BALANCE = 'amount + escrowed_amount';
/** The balance turned around, so that the list runs largest first in the direction of the holder (spec 7.3). A balance is at most 2^63 - 1. */
const ORDER = `9223372036854775807 - (${BALANCE})`;

/** What a page of the holders is asked for; the values are already validated. */
export interface MptHoldersQuery {
  includeZero: boolean;
  limit: number;
  /** `[balance, holder]` of the last row of the page before. */
  after?: [string, string];
}

/**
 * The holders of an issuance (spec 7.3): the newest version of each row of the issuance's prefix of `mpt_holders`, then the order of
 * their balance, which no key holds, so every page reads the issuance's rows (spec 8).
 *
 * The aliases `amount_text` and `escrowed_text` are not `amount` and `escrowed_amount`: the conditions and the order of the outer
 * SELECT want the numbers, and an alias would win over the column there (ruling C20). The marker holds the balance as text, since it
 * reaches 2^63 - 1, so the condition is written here with the text bound to a `UInt64`, and its first column bounded alone, as
 * `keysetClause` does (ruling C21).
 */
@Injectable()
export class MptHoldersService {
  constructor(private readonly ch: ClickHouseService) {}

  /** One page, largest balance first, then by holder, with the marker of the next page when there is one. */
  async page(id: string, q: MptHoldersQuery): Promise<{ rows: StoredMptHolder[]; marker?: string }> {
    const conditions = [
      'deleted = 0',
      ...(q.includeZero ? [] : [`${BALANCE} > 0`]),
      ...(q.after === undefined
        ? []
        : [
            `${ORDER} >= 9223372036854775807 - {k0:UInt64}`,
            `(${ORDER}, holder) > (9223372036854775807 - {k0:UInt64}, {k1:String})`,
          ]),
    ];
    const rows = await this.ch.query<StoredMptHolder>(
      `SELECT holder, toString(amount) AS amount_text, toString(escrowed_amount) AS escrowed_text, flags
         FROM (SELECT holder, amount, escrowed_amount, flags, deleted
                 FROM ${Table.MptHolders}
                WHERE mpt_issuance_id = {id:String}
                ORDER BY holder, version DESC
                LIMIT 1 BY holder)
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${ORDER}, holder
        LIMIT {n:UInt32}`,
      { id, n: q.limit + 1, ...(q.after && { k0: q.after[0], k1: q.after[1] }) },
    );
    return paginate(rows, q.limit, (row) => [
      (BigInt(row.amount_text) + BigInt(row.escrowed_text)).toString(),
      row.holder,
    ]);
  }
}
