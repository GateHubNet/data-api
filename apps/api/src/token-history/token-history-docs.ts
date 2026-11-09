import { ApiParamOptions, ApiQueryOptions } from '@nestjs/swagger';

/** The `{token}` of the token history's routes (spec 5.0): D6's form, or an MPT issuance ID. */
export const ANY_TOKEN_PARAM: ApiParamOptions = {
  name: 'token',
  description:
    'An issued token, `{currency}.{issuer}` (or with `+` or `|` for the dot), as `/v2/tokens/{token}` names it; or an MPT, its ' +
    'issuance ID (48 hex digits, any case), alone or as `{issuanceId}+{issuer}`.',
};

/** The ledger an answer is as of (spec 5.0). */
export const LEDGER_QUERIES: ApiQueryOptions[] = [
  {
    name: 'ledger_index',
    required: false,
    description:
      'A ledger number (alias `ledger`), or `validated`, `closed`, `current` for the newest ledger of the token history.',
  },
  { name: 'ledger_hash', required: false, description: 'The hash of a stored ledger, 64 hex digits.' },
  {
    name: 'date',
    required: false,
    description:
      'The ledger closed at or before this time (alias `close_time`). A ledger above the token history is 400 `ledger is not in ' +
      'the token history yet`; one below its coverage `the date provided is too old`.',
  },
];

/** `exclude` (spec 5.0). */
export const EXCLUDE_QUERY: ApiQueryOptions = {
  name: 'exclude',
  required: false,
  description:
    "Up to 20 comma-separated addresses (the issuer's own wallets, say): the figures stay whole, and the answer adds `excluded` " +
    'and `without_excluded`, the figures without them. Duplicates are ignored.',
};
