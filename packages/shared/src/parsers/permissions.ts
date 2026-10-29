import { NetworkProfile } from '../network/network-profile';

/** A granular permission: it lets the delegate send only the part of a transaction type that its name says. */
export interface GranularPermission {
  name: string;
  value: number;
  /** The type of transaction the permission narrows. */
  transactionType: string;
}

/**
 * The 12 granular permissions of xrpl.org's "Permission Values" (read 2026-10-29, FINDINGS (7) of
 * `test/fixtures/xrpl/objects`), by value. The definitions do not carry them, so the table is kept by hand. Note the
 * spelling `AccountEmailHashSet`.
 */
export const GRANULAR_PERMISSIONS: readonly GranularPermission[] = [
  { name: 'TrustlineAuthorize', value: 65537, transactionType: 'TrustSet' },
  { name: 'TrustlineFreeze', value: 65538, transactionType: 'TrustSet' },
  { name: 'TrustlineUnfreeze', value: 65539, transactionType: 'TrustSet' },
  { name: 'AccountDomainSet', value: 65540, transactionType: 'AccountSet' },
  { name: 'AccountEmailHashSet', value: 65541, transactionType: 'AccountSet' },
  { name: 'AccountMessageKeySet', value: 65542, transactionType: 'AccountSet' },
  { name: 'AccountTransferRateSet', value: 65543, transactionType: 'AccountSet' },
  { name: 'AccountTickSizeSet', value: 65544, transactionType: 'AccountSet' },
  { name: 'PaymentMint', value: 65545, transactionType: 'Payment' },
  { name: 'PaymentBurn', value: 65546, transactionType: 'Payment' },
  { name: 'MPTokenIssuanceLock', value: 65547, transactionType: 'MPTokenIssuanceSet' },
  { name: 'MPTokenIssuanceUnlock', value: 65548, transactionType: 'MPTokenIssuanceSet' },
];

/** A delegated permission as the API answers it. */
export interface Permission {
  /** The transaction type or granular permission name, or the number of a value that is neither. */
  permission: string;
  kind: 'transaction' | 'granular' | 'unknown';
  /** The type a granular permission narrows. */
  transaction_type?: string;
}

/**
 * A `PermissionValue` (the node writes the name of a transaction type it knows, else the number) as a `Permission`.
 * A granular name or value is `granular`; a number, or a string of digits, that is a transaction type's code plus 1 is
 * that `transaction`; any other number is `unknown` and is its own `permission`; any other string is the name of a
 * `transaction`. Value 0 (full permissions) is no transaction type: the definitions' `Invalid` has code -1, and it is
 * not a permission. Anything that is neither a number nor a string is `unknown`, written as `String(value)`.
 */
export function permissionOf(value: unknown, transactionTypes: Readonly<Record<string, number>>): Permission {
  const text = typeof value === 'string' ? value : undefined;
  const number =
    typeof value === 'number' ? value : text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined;

  const granular = GRANULAR_PERMISSIONS.find((p) => p.name === text || p.value === number);
  if (granular) return { permission: granular.name, kind: 'granular', transaction_type: granular.transactionType };

  if (number !== undefined) {
    if (text !== undefined && !Number.isSafeInteger(number)) return { permission: text, kind: 'unknown' };
    const name = Object.keys(transactionTypes).find((type) => number >= 1 && transactionTypes[type] === number - 1);
    return name !== undefined
      ? { permission: name, kind: 'transaction' }
      : { permission: String(number), kind: 'unknown' };
  }
  if (text !== undefined) return { permission: text, kind: 'transaction' };
  return { permission: String(value), kind: 'unknown' };
}

/**
 * The `TRANSACTION_TYPES` (name to code) of the profile's definitions (`definitionsFallback()`, the file recorded from
 * a node of the network); empty when the profile has none.
 */
export function transactionTypesOf(profile: NetworkProfile): Readonly<Record<string, number>> {
  const types = profile.definitionsFallback()?.TRANSACTION_TYPES;
  return typeof types === 'object' && types !== null ? (types as Record<string, number>) : {};
}
