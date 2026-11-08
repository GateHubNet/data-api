import BigNumber from 'bignumber.js';
import { EXACT_SCALE, exactAmountOfText } from '../query/decimal';

/**
 * The flows of a transaction for a token (spec 1). `net` is the sum of the transaction's changes of the token. A `Clawback` or
 * `AMMClawback` is clawed back by `max(-net, 0)`; any other transaction is redeemed by it (a transfer fee is redeemed supply).
 * Either is issued by `max(net, 0)`, and transfers `Σ max(change, 0) − max(net, 0)` from holder to holder. So over any range
 * `supply_end − supply_start = issued − redeemed − clawed_back`, exactly. A change whose before-state is not known is in no
 * flow, only in `unknown_before`.
 */

/** A change's amounts: the holder's amount before and after, and whether the before-state is known. */
export interface ChangeAmounts {
  before: string;
  after: string;
  beforeKnown: boolean;
}

/** The flows of a transaction, or of a sum of transactions. The amounts are exact decimal text, 0 or above. */
export interface Flows {
  issued: string;
  redeemed: string;
  clawed_back: string;
  transferred: string;
  /** 1 when the transaction transferred anything (`transferred` above 0). */
  transfers: 0 | 1;
  unknown_before: number;
}

const ZERO = new BigNumber(0);
const text = (n: BigNumber): string => (n.isZero() ? '0' : n.toFixed());

/** The flows of one transaction's changes of one token (spec 1). `clawback` is whether it is a `Clawback` or `AMMClawback`. */
export function flowsOfTransaction(changes: ChangeAmounts[], clawback: boolean): Flows {
  let net = ZERO;
  let gain = ZERO;
  let unknown = 0;
  for (const c of changes) {
    if (!c.beforeKnown) {
      unknown++;
      continue;
    }
    const delta = new BigNumber(c.after).minus(c.before);
    net = net.plus(delta);
    if (delta.isGreaterThan(0)) gain = gain.plus(delta);
  }
  const up = BigNumber.max(net, 0);
  const down = BigNumber.max(net.negated(), 0);
  const transferred = gain.minus(up);
  return {
    issued: text(up),
    redeemed: clawback ? '0' : text(down),
    clawed_back: clawback ? text(down) : '0',
    transferred: text(transferred),
    transfers: transferred.isGreaterThan(0) ? 1 : 0,
    unknown_before: unknown,
  };
}

const DECIMAL_ZERO = `toDecimal256(0, ${EXACT_SCALE})`;

/**
 * The flows of every transaction, by spec 1, over the rows of `token_changes`, which the caller names in a `WITH token_changes AS
 * (…)` clause: rows of `token_holder_changes` (every column), deduplicated and bounded by the caller. One row per `(issuer,
 * currency, ledger_index, tx_index)`, with `close_time`, `clawback`, `changes`, `unknown_before`, and `net`, `issued`, `redeemed`,
 * `clawed_back`, `transferred` as `Decimal256(30)` and `transfers` (`UInt8`). The decimals are exact only when `unfit` is 0: a
 * transaction with an amount the decimal cannot hold has `unfit > 0`, and the caller sums its changes again in BigNumber
 * (`flowsOfTransaction`).
 */
export const FLOWS_BY_TX_SQL = `
SELECT issuer, currency, ledger_index, tx_index,
       any(close_time) AS close_time,
       max(clawback) AS clawback,
       toUInt32(count()) AS changes,
       toUInt32(countIf(before_known = 0)) AS unknown_before,
       toUInt32(countIf(before_known = 1 AND (isNull(d_after) OR isNull(d_before)))) AS unfit,
       ifNull(sumIf(d_after - d_before, before_known = 1), ${DECIMAL_ZERO}) AS net,
       ifNull(sumIf(greatest(d_after - d_before, ${DECIMAL_ZERO}), before_known = 1), ${DECIMAL_ZERO}) AS gain,
       greatest(net, ${DECIMAL_ZERO}) AS issued,
       if(clawback = 1, ${DECIMAL_ZERO}, greatest(-net, ${DECIMAL_ZERO})) AS redeemed,
       if(clawback = 1, greatest(-net, ${DECIMAL_ZERO}), ${DECIMAL_ZERO}) AS clawed_back,
       gain - greatest(net, ${DECIMAL_ZERO}) AS transferred,
       toUInt8(transferred > ${DECIMAL_ZERO}) AS transfers
  FROM (SELECT *, ${exactAmountOfText('amount_before')} AS d_before, ${exactAmountOfText('amount_after')} AS d_after
          FROM token_changes)
 GROUP BY issuer, currency, ledger_index, tx_index`;
