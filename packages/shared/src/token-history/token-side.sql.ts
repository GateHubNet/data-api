import { LP_CURRENCY } from '../util/currency-code';

/**
 * The SQL forms of the token side (spec 1) and of the order key (spec 3.4), for the build's `INSERT … SELECT`. They are the
 * rules of `token-side.ts` and `order-key.ts`, and an e2e property test pins each to its TypeScript form. Every sign test is on
 * the text, as the trust line parser writes it (plain decimal, `'0'` for zero), so no decimal range is involved.
 */

/** The text of an amount column is negative. */
const negative = (column: string): string => `startsWith(${column}, '-')`;
/** The text of a limit column is above 0. */
const abovePositiveZero = (column: string): string => `(${column} != '0' AND NOT ${negative(column)})`;

/** The columns of a `trust_line_states` row that the token side reads: `balance`, `limit_peer` and `deleted`, or their lags. */
export interface IssuedSideColumns {
  balance: string;
  limit_peer: string;
  deleted: string;
}

const STATE_COLUMNS: IssuedSideColumns = { balance: 'balance', limit_peer: 'limit_peer', deleted: 'deleted' };

/**
 * Whether a `trust_line_states` row counts for the token of its `account` (spec 1: `countsFor(balance, limit_peer)`, not deleted),
 * over the named columns (code, never input).
 */
export function issuedCountedSql(c: IssuedSideColumns = STATE_COLUMNS): string {
  return `(${c.deleted} = 0 AND (${negative(c.balance)} OR (${c.balance} = '0' AND ${abovePositiveZero(c.limit_peer)})))`;
}

/** The holder's amount of a row, over the named columns: `-balance` when the line counts, else `'0'`. */
export function issuedAmountSql(c: IssuedSideColumns = STATE_COLUMNS): string {
  return `if(${issuedCountedSql(c)} AND ${negative(c.balance)}, substring(${c.balance}, 2), '0')`;
}

/** Whether a `trust_line_states` row counts for the token of its `account`, over its own columns. */
export const ISSUED_COUNTED_SQL = issuedCountedSql();

/**
 * The SELECT expressions of the token side over the columns of `trust_line_states`: `issuer, holder, currency, counted, amount,
 * limit, frozen, authorized, escrowed` (the token `(currency, account)`; the holder's amount is `-balance` when the line counts,
 * else `'0'`). Select them from `trust_line_states` with `ISSUED_SIDE_KEEP`, which drops the LP currencies. The aliases shadow
 * the table's `limit`, so a query that selects them reads the holder's limit (`limit_peer`) by that name.
 */
export const ISSUED_SIDE_COLUMNS = [
  'account AS issuer',
  'counterparty AS holder',
  'currency',
  `toUInt8(${ISSUED_COUNTED_SQL}) AS counted`,
  `${issuedAmountSql()} AS amount`,
  'limit_peer AS `limit`',
  'freeze AS frozen',
  'authorized',
  `'0' AS escrowed`,
].join(', ');

/** The condition that keeps the rows whose currency counts for a token: an LP currency counts for nothing. */
export const ISSUED_SIDE_KEEP = `NOT match(currency, '${LP_CURRENCY.source}')`;

/**
 * The order key of an amount column (code, never input) as two SQL expressions, `exp` (`Int16`) and `mant` (`UInt64`). An
 * issued amount is decimal text, plain or with an exponent (`1250.75`, `1e-81`): its significant digits, padded to 16, are the
 * mantissa, and the exponent is that of the leading digit less 15. Zero is `(-32768, 0)`. More than 16 significant digits fail
 * the statement. An MPT amount (an integer below 2^64) is `(0, amount)`.
 */
export function orderKeySql(column: string, kind: 'issued' | 'mpt'): { exp: string; mant: string } {
  if (kind === 'mpt') return { exp: 'toInt16(0)', mant: `toUInt64(${column})` };
  const mantissa = `splitByChar('e', ${column})[1]`;
  const shift = `toInt32OrZero(replaceOne(splitByChar('e', ${column})[2], '+', ''))`;
  const whole = `splitByChar('.', ${mantissa})[1]`;
  const fraction = `splitByChar('.', ${mantissa})[2]`;
  // the significant digits, without the zeros before the first and after the last
  const digits = `trimRight(trimLeft(concat(${whole}, ${fraction}), '0'), '0')`;
  const wholeDigits = `length(trimLeft(${whole}, '0'))`;
  const fractionZeros = `(length(${fraction}) - length(trimLeft(${fraction}, '0')))`;
  // the exponent of the leading digit: in the whole part, or after the zeros that start the fraction
  const lead = `(if(${wholeDigits} > 0, ${wholeDigits} - 1, -1 - ${fractionZeros}) + ${shift})`;
  const tooLong = `throwIf(length(${digits}) > 16, 'amount has more than 16 significant digits')`;
  return {
    exp: `toInt16(if(${digits} = '', -32768, ${lead} - 15) + ${tooLong})`,
    mant: `if(${digits} = '', toUInt64(0), toUInt64(rightPad(${digits}, 16, '0')))`,
  };
}

/** The columns of an `mpt_holder_states` row that the token side reads, or their lags. */
export interface MptSideColumns {
  amount: string;
  escrowed_amount: string;
  deleted: string;
}

const MPT_STATE_COLUMNS: MptSideColumns = { amount: 'amount', escrowed_amount: 'escrowed_amount', deleted: 'deleted' };

/** Whether an `mpt_holder_states` row counts for its MPT (spec 1: the `MPToken` is not deleted). */
export function mptCountedSql(c: MptSideColumns = MPT_STATE_COLUMNS): string {
  return `(${c.deleted} = 0)`;
}

/** The holder's amount of an `mpt_holder_states` row as integer text: `amount + escrowed_amount` while it counts, else `'0'`. */
export function mptAmountSql(c: MptSideColumns = MPT_STATE_COLUMNS): string {
  return `if(${mptCountedSql(c)}, toString(toUInt64(${c.amount}) + toUInt64(${c.escrowed_amount})), '0')`;
}

/** The escrowed part of the holder's amount as integer text, `'0'` when the `MPToken` does not count. */
export function mptEscrowedSql(c: MptSideColumns = MPT_STATE_COLUMNS): string {
  return `if(${mptCountedSql(c)}, toString(${c.escrowed_amount}), '0')`;
}

/** `lsfMPTLocked` and `lsfMPTAuthorized` of an `MPToken`'s flags, as the token side's `frozen` and `authorized`. */
export const MPT_FROZEN_SQL = 'toUInt8(bitAnd(flags, 1) != 0)';
export const MPT_AUTHORIZED_SQL = 'toUInt8(bitAnd(flags, 2) != 0)';
