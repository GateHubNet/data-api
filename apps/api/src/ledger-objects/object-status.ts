/**
 * The status of an escrow, a check and a payment channel (spec 5.2), from the fields the ledger stores and the close time
 * `t` of the answer. Pure, with no dependency, so that E10 can mirror the rules for the objects it reads from a node.
 *
 * Every time is unix seconds (a ledger field is Ripple-epoch seconds, and the caller adds the epoch). `t` is the `close_time`
 * the answer carries: rippled tests a transaction against its parent ledger's close time, which is `t` for the next ledger,
 * so the comparisons are rippled's: `FinishAfter` blocks a finish while the time is `<=` it, `CancelAfter` allows a cancel
 * once the time is `>` it, and an expiration passes when the time is `>=` it (a check) or a channel closes `>=` its
 * `CancelAfter`.
 *
 * An object that is deleted has the status its deleting event gives, whatever the time: `removedBy` is the `event` of the
 * row that deleted it (`finish`, `cancel`, `cash`, `close` or `removed`), and an unknown event is `removed`.
 */

export type EscrowStatus = 'pending' | 'can_be_finished' | 'can_be_cancelled' | 'finished' | 'cancelled' | 'removed';
export type CheckStatus = 'open' | 'expired' | 'cashed' | 'cancelled' | 'removed';
export type ChannelStatus = 'open' | 'closing' | 'closed' | 'removed';

/**
 * An escrow in the ledger is `can_be_cancelled` once `t` is after `cancelAfter`, else `pending` while `t` is up to
 * `finishAfter`, else `can_be_finished` (a conditional escrow without `finishAfter` can be finished from its creation).
 */
export function escrowStatus(
  o: { finishAfter?: number; cancelAfter?: number; removedBy?: string },
  t: number,
): EscrowStatus {
  if (o.removedBy !== undefined) {
    if (o.removedBy === 'finish') return 'finished';
    return o.removedBy === 'cancel' ? 'cancelled' : 'removed';
  }
  if (o.cancelAfter !== undefined && t > o.cancelAfter) return 'can_be_cancelled';
  if (o.finishAfter !== undefined && t <= o.finishAfter) return 'pending';
  return 'can_be_finished';
}

/** A check in the ledger is `expired` from its `expiration`, else `open`. */
export function checkStatus(o: { expiration?: number; removedBy?: string }, t: number): CheckStatus {
  if (o.removedBy !== undefined) {
    if (o.removedBy === 'cash') return 'cashed';
    return o.removedBy === 'cancel' ? 'cancelled' : 'removed';
  }
  return o.expiration !== undefined && t >= o.expiration ? 'expired' : 'open';
}

/** A channel in the ledger is `closing` once it has an `expiration` (set whatever the time), or from `cancelAfter`, else `open`. */
export function channelStatus(
  o: { expiration?: number; cancelAfter?: number; removedBy?: string },
  t: number,
): ChannelStatus {
  if (o.removedBy !== undefined) return o.removedBy === 'close' ? 'closed' : 'removed';
  if (o.expiration !== undefined) return 'closing';
  return o.cancelAfter !== undefined && t >= o.cancelAfter ? 'closing' : 'open';
}
