import { createHash } from 'crypto';
import { decodeAccountID } from 'ripple-address-codec';

/** The ledger-object space key of an `Escrow` (`'u'`, `ltESCROW`): the first two bytes of every escrow's keylet hash. */
export const ESCROW_SPACE = 0x0075;

/**
 * The ID of a ledger object: SHA-512Half (the first 32 bytes of SHA-512) of the space key as a big-endian UInt16 followed
 * by `body`, as 64 upper-case hex digits. Throws a `RangeError` unless `space` fits a UInt16.
 */
export function ledgerObjectSpace(space: number, body: Uint8Array): string {
  const key = Buffer.alloc(2);
  key.writeUInt16BE(space);
  return createHash('sha512').update(key).update(body).digest().subarray(0, 32).toString('hex').toUpperCase();
}

/**
 * An escrow's ledger object ID: the space, the owner's AccountID and the big-endian UInt32 sequence of the `EscrowCreate`
 * (its `Sequence`, or its `TicketSequence` when `Sequence` is 0). Throws on an address that is not a classic one (an
 * X-address included) and on a sequence that is not a UInt32.
 */
export function escrowId(owner: string, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) {
    throw new RangeError(`an escrow sequence must be a UInt32: ${String(sequence)}`);
  }
  const seq = Buffer.alloc(4);
  seq.writeUInt32BE(sequence);
  return ledgerObjectSpace(ESCROW_SPACE, Buffer.concat([Buffer.from(decodeAccountID(owner)), seq]));
}
