import { schemaErrors } from '../../test/support/ajv';
import {
  DISTRIBUTION_SCHEMA,
  FLOWS_SCHEMA,
  HOLDERS_SCHEMA,
  ISSUER_TOKENS_SCHEMA,
  SNAPSHOT_SCHEMA,
  SUMMARY_SCHEMA,
  SUPPLY_SCHEMA,
} from './schemas';
import { SAMPLES } from './token-history-samples';

type Body = Record<string, unknown>;
const clone = (o: object): Body => JSON.parse(JSON.stringify(o)) as Body;

/** Sets the value at a path of a copy (`a.0.b`). */
function withValue(body: object, path: string, value: unknown): Body {
  const copy = clone(body);
  const keys = path.split('.');
  let at: Record<string, unknown> = copy;
  for (const k of keys.slice(0, -1)) at = at[k] as Record<string, unknown>;
  at[keys[keys.length - 1]] = value;
  return copy;
}

/** Each route's schema, a valid answer, the path of an amount in it, and the path of a nested object of it. */
const ROUTES: [string, object, object, string, string][] = [
  ['issuer tokens', ISSUER_TOKENS_SCHEMA, SAMPLES.issuerTokens, 'tokens.0.supply', 'tokens.0'],
  ['summary', SUMMARY_SCHEMA, SAMPLES.summary, 'windows.24h.issued', 'windows.24h'],
  ['supply', SUPPLY_SCHEMA, SAMPLES.supply, 'rows.0.supply', 'rows.0.without_excluded'],
  ['flows', FLOWS_SCHEMA, SAMPLES.flows, 'counterparties.0.received', 'totals'],
  ['distribution', DISTRIBUTION_SCHEMA, SAMPLES.distribution, 'top.10.balance', 'buckets.0'],
  ['snapshot', SNAPSHOT_SCHEMA, SAMPLES.snapshot, 'balances.0.balance', 'token'],
  ['holders', HOLDERS_SCHEMA, SAMPLES.holders, 'holders.0.balance', 'holders.0'],
];

describe('the token history schemas', () => {
  it.each(ROUTES)('the %s sample validates', (_name, schema, sample) => {
    expect(schemaErrors(sample, schema)).toEqual([]);
  });

  it('every schema rejects a number amount and an extra key', () => {
    for (const [name, schema, sample, amount, nested] of ROUTES) {
      expect({ name, amount: schemaErrors(withValue(sample, amount, 1.5), schema).length > 0 }).toEqual({
        name,
        amount: true,
      });
      expect({ name, top: schemaErrors({ ...sample, extra: 1 }, schema).length > 0 }).toEqual({ name, top: true });
      expect({ name, nested: schemaErrors(withValue(sample, `${nested}.extra`, 1), schema).length > 0 }).toEqual({
        name,
        nested: true,
      });
    }
  });

  it('a signed amount is allowed in net only, and a missing required key is refused', () => {
    expect(schemaErrors(withValue(SAMPLES.supply, 'rows.0.net', '-5'), SUPPLY_SCHEMA)).toEqual([]);
    expect(schemaErrors(withValue(SAMPLES.supply, 'rows.0.supply', '-5'), SUPPLY_SCHEMA).length).toBeGreaterThan(0);
    const { digest: _digest, ...noDigest } = SAMPLES.snapshot;
    expect(schemaErrors(noDigest, SNAPSHOT_SCHEMA).length).toBeGreaterThan(0);
  });
});
