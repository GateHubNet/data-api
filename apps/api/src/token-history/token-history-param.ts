import { mptIssuerOf } from '@gatehub/data-api-shared';
import { isValidClassicAddress } from 'ripple-address-codec';
import { badRequest } from '../common/errors';
import { parseTokenParam } from '../tokens/token-param';

/**
 * A token of the token history's routes (spec 5.0): an issued token, its currency in the ledger's form, or an MPT, its issuance ID
 * (upper case) as `currency` and the issuer the ID holds, as the change log keys both.
 */
export type AnyToken =
  | { kind: 'issued'; currency: string; issuer: string }
  | { kind: 'mpt'; currency: string; issuer: string };

/** An issuance ID, alone or with `+<issuer>`: 48 hex digits in either case. */
const MPT_PATH = /^([0-9A-Fa-f]{48})(?:\+(.*))?$/;

/**
 * The `{token}` of a path (spec 5.0). Forty-eight hex digits, any case, are an MPT; `<48hex>+<issuer>` checks the issuer, 400
 * `invalid issuer address` for one that is no classic address and `issuer does not match mpt issuance` for another account (as
 * `asset-param.ts` does for ADR-0020). Anything else is D6's `{currency}.{issuer}`, with its messages (`parseTokenParam`).
 */
export function parseAnyToken(raw: string, native: 'XRP' | 'XAH'): AnyToken {
  const mpt = MPT_PATH.exec(raw);
  if (mpt !== null) {
    const currency = mpt[1].toUpperCase();
    const issuer = mptIssuerOf(currency);
    const named = mpt[2];
    if (named !== undefined) {
      if (!isValidClassicAddress(named)) throw badRequest('invalid issuer address');
      if (named !== issuer) throw badRequest('issuer does not match mpt issuance');
    }
    return { kind: 'mpt', currency, issuer };
  }
  return { kind: 'issued', ...parseTokenParam(raw, native) };
}
