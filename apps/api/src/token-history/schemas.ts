/**
 * The JSON Schemas of the token history's answers (spec 5, 10): one per route, every object with its `required` keys and
 * `additionalProperties: false`, so that the e2e checks (Ajv) catch a key too many as well as one missing, and `@ApiOkResponse`
 * documents the same shape. Amounts are decimal text, never a number; times are `YYYY-MM-DDTHH:mm:ssZ`.
 */

type Schema = Record<string, unknown>;

/** A non-negative amount as text: `1250000.5`, `0`, never a number. */
export const AMOUNT: Schema = { type: 'string', pattern: '^\\d+(\\.\\d+)?(e[-+]?\\d+)?$' };
/** A signed amount (`net`). */
export const SIGNED_AMOUNT: Schema = { type: 'string', pattern: '^-?\\d+(\\.\\d+)?(e[-+]?\\d+)?$' };
const TIME: Schema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$' };
const LEDGER: Schema = { type: 'integer', minimum: 0 };
const COUNT: Schema = { type: 'integer', minimum: 0 };
const ADDRESS: Schema = { type: 'string', pattern: '^r[1-9A-HJ-NP-Za-km-z]{24,34}$' };
const SHARE: Schema = { type: 'string', pattern: '^\\d+\\.\\d{6}$' };
const MARKER: Schema = { type: 'string', minLength: 1 };
const BOOLEAN: Schema = { type: 'boolean' };
const TEXT: Schema = { type: 'string' };
const KIND: Schema = { type: 'string', enum: ['issued', 'mpt'] };
const SUCCESS: Schema = { type: 'string', enum: ['success'] };

/** An object of exactly these keys, all required but the `optional` ones. */
function object(properties: Record<string, Schema>, optional: readonly string[] = []): Schema {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties).filter((k) => !optional.includes(k)),
    additionalProperties: false,
  };
}
const array = (items: Schema): Schema => ({ type: 'array', items });

const COVERAGE = object({ from_ledger_index: LEDGER, complete: BOOLEAN }, ['from_ledger_index']);
const ENVELOPE = { result: SUCCESS, coverage: COVERAGE, ledger_index: LEDGER, close_time: TIME };
const TOKEN = object({ currency: TEXT, issuer: ADDRESS, kind: KIND, code: TEXT }, ['code']);
const WITHOUT_EXCLUDED = object({ supply: AMOUNT, holders: COUNT, trust_lines: COUNT });
const EXCLUDED = array(ADDRESS);

export const ISSUER_TOKENS_SCHEMA = object(
  {
    ...ENVELOPE,
    count: COUNT,
    marker: MARKER,
    tokens: array(
      object(
        {
          currency: TEXT,
          code: TEXT,
          kind: KIND,
          supply: AMOUNT,
          holders: COUNT,
          trust_lines: COUNT,
          first_ledger: LEDGER,
          last_ledger: LEDGER,
        },
        ['code'],
      ),
    ),
  },
  ['marker'],
);

const FLOW_KEYS = {
  issued: AMOUNT,
  redeemed: AMOUNT,
  clawed_back: AMOUNT,
  transferred: AMOUNT,
  transfers: COUNT,
};
const DEX_KEYS = { exchanged: AMOUNT, trades: COUNT, exchanged_through: TIME };
const DEX_OPTIONAL = ['exchanged', 'trades', 'exchanged_through'] as const;

const SUMMARY_WINDOW = object(
  { start: TIME, end: TIME, ...FLOW_KEYS, changes: COUNT, unknown_before: COUNT, ...DEX_KEYS },
  DEX_OPTIONAL,
);

export const SUMMARY_SCHEMA = object(
  {
    ...ENVELOPE,
    token: TOKEN,
    supply: AMOUNT,
    holders: COUNT,
    trust_lines: COUNT,
    without_excluded: WITHOUT_EXCLUDED,
    excluded: EXCLUDED,
    first_ledger: LEDGER,
    first_time: TIME,
    last_ledger: LEDGER,
    last_time: TIME,
    windows: object({ '24h': SUMMARY_WINDOW, '7d': SUMMARY_WINDOW, '30d': SUMMARY_WINDOW }),
  },
  ['without_excluded', 'excluded', 'first_ledger', 'first_time', 'last_ledger', 'last_time'],
);

export const SUPPLY_SCHEMA = object(
  {
    ...ENVELOPE,
    interval: { type: 'string', enum: ['day', 'hour', 'ledger'] },
    excluded: EXCLUDED,
    count: COUNT,
    marker: MARKER,
    rows: array(
      object(
        {
          time: TIME,
          ledger_index: LEDGER,
          supply: AMOUNT,
          holders: COUNT,
          trust_lines: COUNT,
          issued: AMOUNT,
          redeemed: AMOUNT,
          clawed_back: AMOUNT,
          net: SIGNED_AMOUNT,
          unknown_before: COUNT,
          without_excluded: WITHOUT_EXCLUDED,
        },
        ['without_excluded'],
      ),
    ),
  },
  ['excluded', 'marker'],
);

const BUCKET = object({ min: AMOUNT, max: AMOUNT, holders: COUNT, balance: AMOUNT });
const TOP_ENTRY = object({ balance: AMOUNT, share: SHARE });
const TOP = object({ '10': TOP_ENTRY, '100': TOP_ENTRY });

export const DISTRIBUTION_SCHEMA = object(
  {
    ...ENVELOPE,
    supply: AMOUNT,
    holders: COUNT,
    buckets: array(BUCKET),
    top: TOP,
    excluded: EXCLUDED,
    without_excluded: object({
      supply: AMOUNT,
      holders: COUNT,
      trust_lines: COUNT,
      buckets: array(BUCKET),
      top: TOP,
    }),
  },
  ['excluded', 'without_excluded'],
);

const FLOWS_TOTALS = object({ ...FLOW_KEYS, unknown_before: COUNT, ...DEX_KEYS }, DEX_OPTIONAL);
const FLOWS_PERIOD = object({ start: TIME, ...FLOW_KEYS, unknown_before: COUNT, ...DEX_KEYS }, DEX_OPTIONAL);

export const FLOWS_SCHEMA = object({
  ...ENVELOPE,
  start: TIME,
  end: TIME,
  interval: { type: 'string', enum: ['day', 'hour', 'month'] },
  totals: FLOWS_TOTALS,
  periods: array(FLOWS_PERIOD),
  counterparties: array(
    object({ account: ADDRESS, received: AMOUNT, sent: AMOUNT, net: SIGNED_AMOUNT, changes: COUNT }),
  ),
});

export const SNAPSHOT_SCHEMA = object(
  {
    ...ENVELOPE,
    ledger_hash: { type: 'string', pattern: '^[0-9A-F]{64}$' },
    token: TOKEN,
    supply: AMOUNT,
    holders: COUNT,
    trust_lines: COUNT,
    digest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    without_excluded: WITHOUT_EXCLUDED,
    excluded: EXCLUDED,
    count: COUNT,
    marker: MARKER,
    balances: array(
      object(
        { holder: ADDRESS, balance: AMOUNT, escrowed: AMOUNT, limit: TEXT, frozen: BOOLEAN, authorized: BOOLEAN },
        ['escrowed'],
      ),
    ),
  },
  ['without_excluded', 'excluded', 'marker'],
);

/** D6's `/holders`, as it answers once a generation is live: D6's keys, then `first_ledger`, `last_ledger` and an MPT's `escrowed`. */
export const HOLDERS_SCHEMA = object(
  {
    ...ENVELOPE,
    supply: AMOUNT,
    count: COUNT,
    marker: MARKER,
    holders: array(
      object(
        {
          rank: { type: 'integer', minimum: 1 },
          holder: ADDRESS,
          balance: AMOUNT,
          share: SHARE,
          limit: TEXT,
          frozen: BOOLEAN,
          authorized: BOOLEAN,
          first_ledger: LEDGER,
          last_ledger: LEDGER,
          escrowed: AMOUNT,
        },
        ['first_ledger', 'last_ledger', 'escrowed'],
      ),
    ),
  },
  ['marker'],
);
