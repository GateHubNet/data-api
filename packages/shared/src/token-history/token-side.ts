import BigNumber from 'bignumber.js';
import { countsFor } from '../aggregate/token-rules';
import { isLpCurrency } from '../util/currency-code';

/**
 * The token side of a state row (spec 1): what one `trust_line_states` row or one `mpt_holder_states` row says of a token. The
 * build's SQL (`token-side.sql.ts`) is the same rule over the stored columns, and a property test pins the two together. Pure.
 */

/** A holder's state in a token, after a change. */
export interface TokenSide {
  issuer: string;
  /** An issued token's currency as the ledger writes it, or an MPT's issuance ID. */
  currency: string;
  holder: string;
  /** The holder's amount, exact decimal text (an MPT: integer units, escrowed included), `'0'` when the line does not count. */
  amount: string;
  /** Whether the line (or `MPToken`) counts for the token: it is one of the token's trust lines. */
  counted: boolean;
  /** The holder's limit, `''` for an MPT. */
  limit: string;
  /** The issuer side's freeze flag, an MPT holder's `lsfMPTLocked`. */
  frozen: boolean;
  /** The issuer side's auth flag, an MPT holder's `lsfMPTAuthorized`. */
  authorized: boolean;
  /** The escrowed part of `amount`: `'0'` for an issued token. */
  escrowed: string;
}

/** The columns of a `trust_line_states` row that the token side reads. The flags are `UInt8`s, or booleans. */
export interface IssuedStateRow {
  account: string;
  counterparty: string;
  currency: string;
  balance: string;
  limit_peer: string;
  freeze: number | boolean;
  authorized: number | boolean;
  deleted: number | boolean;
}

/** The columns of an `mpt_holder_states` row that the token side reads. The amounts are `UInt64`s, as text or numbers. */
export interface MptStateRow {
  holder: string;
  mpt_issuance_id: string;
  amount: string | number;
  escrowed_amount: string | number;
  flags: number;
  deleted: number | boolean;
}

/** `lsfMPTLocked` of an `MPToken`. */
export const LSF_MPT_TOKEN_LOCKED = 0x0001;
/** `lsfMPTAuthorized` of an `MPToken`. */
export const LSF_MPT_TOKEN_AUTHORIZED = 0x0002;

const on = (flag: number | boolean): boolean => flag === true || flag === 1;

/**
 * The token `(currency, account)` of a `trust_line_states` row (spec 1): the holder is `counterparty`, the issuer-side balance
 * `balance` and the holder's limit `limit_peer`. The line counts when `countsFor(balance, limit_peer)` holds and the row is not
 * deleted, and the holder's amount is then `-balance`. `frozen` and `authorized` are the issuer side's flags. `null` for an LP
 * currency, which counts for nothing. This is the second entry of `orientations()` for the row read as the low side.
 */
export function issuedSideOf(row: IssuedStateRow): TokenSide | null {
  if (isLpCurrency(row.currency)) return null;
  const counted = !on(row.deleted) && countsFor(row.balance, row.limit_peer);
  const balance = new BigNumber(row.balance);
  return {
    issuer: row.account,
    currency: row.currency,
    holder: row.counterparty,
    amount: counted && !balance.isZero() ? balance.negated().toFixed() : '0',
    counted,
    limit: row.limit_peer,
    frozen: on(row.freeze),
    authorized: on(row.authorized),
    escrowed: '0',
  };
}

/**
 * The MPT `(issuance ID, issuer)` of an `mpt_holder_states` row (spec 1): the holder's amount is `amount + escrowed_amount` in
 * integer units (ADR-0020's balance), and the entry counts while it is not deleted. `frozen` is `lsfMPTLocked`, `authorized`
 * `lsfMPTAuthorized`, and `limit` is `''`.
 */
export function mptSideOf(row: MptStateRow, issuer: string): TokenSide {
  const counted = !on(row.deleted);
  const escrowed = BigInt(String(row.escrowed_amount));
  return {
    issuer,
    currency: row.mpt_issuance_id,
    holder: row.holder,
    amount: counted ? (BigInt(String(row.amount)) + escrowed).toString() : '0',
    counted,
    limit: '',
    frozen: (row.flags & LSF_MPT_TOKEN_LOCKED) !== 0,
    authorized: (row.flags & LSF_MPT_TOKEN_AUTHORIZED) !== 0,
    escrowed: counted ? escrowed.toString() : '0',
  };
}
