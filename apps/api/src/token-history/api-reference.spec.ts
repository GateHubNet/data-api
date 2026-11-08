import { readFileSync } from 'node:fs';
import {
  examplesOf,
  examplesProblemsOf,
  fenceProblems,
  hasOwn,
  partOf,
  REFERENCE,
  referenceChecks,
} from '../../test/support/api-reference-check';
import { COVERAGE_KEYS } from '../common/feature-coverage.service';
import { HOLDERS_ANSWER_KEYS } from '../tokens/token-objects';
import * as objects from './token-history-objects';
import {
  BUCKET_KEYS,
  COUNTERPARTY_KEYS,
  DISTRIBUTION_KEYS,
  DISTRIBUTION_WITHOUT_KEYS,
  FLOWS_KEYS,
  FLOWS_PERIOD_KEYS,
  FLOWS_TOTALS_KEYS,
  HOLDER_ROW_EXTRA_KEYS,
  HOLDER_ROW_TOKEN_HISTORY_KEYS,
  ISSUER_TOKEN_KEYS,
  ISSUER_TOKENS_ANSWER_KEYS,
  SNAPSHOT_KEYS,
  SNAPSHOT_ROW_KEYS,
  SUMMARY_KEYS,
  SUMMARY_TOKEN_KEYS,
  SUMMARY_WINDOW_KEYS,
  SUPPLY_ANSWER_KEYS,
  SUPPLY_ROW_KEYS,
  TOP_ENTRY_KEYS,
  WITHOUT_EXCLUDED_KEYS,
} from './token-history-objects';

/*
 * The "Token history" section of docs/api-reference.md names the keys of every object of the issuer analytics routes, in order, on a
 * line `Keys of <object>, in order: ...`, as the other sections do (see `mpt/api-reference.spec.ts`). Each line is tied to the
 * constant the code serves the object by; the constants are pinned by the routes' e2e suite (`token-history.e2e-spec.ts`), and are
 * never changed to fit a line. The examples' keys come in the order of the constants, which the second half checks.
 */

const HEADING = '## Token history';

const OBJECTS: Record<string, readonly string[]> = {
  'the issuer tokens answer': ISSUER_TOKENS_ANSWER_KEYS,
  'an issuer token': ISSUER_TOKEN_KEYS,
  'the summary answer': SUMMARY_KEYS,
  'the token': SUMMARY_TOKEN_KEYS,
  'a window': SUMMARY_WINDOW_KEYS,
  without_excluded: WITHOUT_EXCLUDED_KEYS,
  'the supply answer': SUPPLY_ANSWER_KEYS,
  'a supply row': SUPPLY_ROW_KEYS,
  'the distribution answer': DISTRIBUTION_KEYS,
  'a bucket': BUCKET_KEYS,
  'an entry of top': TOP_ENTRY_KEYS,
  'the without_excluded of the distribution': DISTRIBUTION_WITHOUT_KEYS,
  'the flows answer': FLOWS_KEYS,
  'the totals': FLOWS_TOTALS_KEYS,
  'a period': FLOWS_PERIOD_KEYS,
  'a counterparty': COUNTERPARTY_KEYS,
  'the snapshot answer': SNAPSHOT_KEYS,
  'a balance': SNAPSHOT_ROW_KEYS,
  'the keys a holder gains': HOLDER_ROW_EXTRA_KEYS,
  'a holder from the token history': HOLDER_ROW_TOKEN_HISTORY_KEYS,
};

const { sectionOf, keyLines, problemsOf } = referenceChecks(HEADING, OBJECTS);

/** The constant the object under a key is served by; a list takes the key of its elements. */
const KEYS_UNDER: Record<string, readonly string[]> = {
  coverage: COVERAGE_KEYS,
  tokens: ISSUER_TOKEN_KEYS,
  token: SUMMARY_TOKEN_KEYS,
  '24h': SUMMARY_WINDOW_KEYS,
  '7d': SUMMARY_WINDOW_KEYS,
  '30d': SUMMARY_WINDOW_KEYS,
  rows: SUPPLY_ROW_KEYS,
  buckets: BUCKET_KEYS,
  '10': TOP_ENTRY_KEYS,
  '100': TOP_ENTRY_KEYS,
  totals: FLOWS_TOTALS_KEYS,
  periods: FLOWS_PERIOD_KEYS,
  counterparties: COUNTERPARTY_KEYS,
  balances: SNAPSHOT_ROW_KEYS,
  holders: HOLDER_ROW_TOKEN_HISTORY_KEYS,
};

const BODIES: readonly (readonly string[])[] = [
  ISSUER_TOKENS_ANSWER_KEYS,
  SUMMARY_KEYS,
  SUPPLY_ANSWER_KEYS,
  DISTRIBUTION_KEYS,
  FLOWS_KEYS,
  SNAPSHOT_KEYS,
  HOLDERS_ANSWER_KEYS,
];

const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('the "Token history" section of docs/api-reference.md', () => {
  const markdown = readFileSync(REFERENCE, 'utf8');

  it('the reference lists the keys of every token history object in order', () => {
    expect(problemsOf(markdown)).toEqual([]);
    const names = keyLines(markdown).map((line) => line.object);
    expect(names.filter((name) => !hasOwn(OBJECTS, name))).toEqual([]);
  });

  it('is checked against every *_KEYS constant of the objects: none is left out of the map', () => {
    const exported = Object.entries(objects).filter(([name]) => name.endsWith('_KEYS'));
    const mapped = new Set<unknown>(Object.values(OBJECTS));
    expect(exported.filter(([, value]) => !mapped.has(value)).map(([name]) => name)).toEqual([]);
    expect(mapped.size).toBe(Object.keys(OBJECTS).length);
  });

  it('writes its examples with the keys in the order the code serves them', () => {
    const examples = examplesOf(sectionOf(markdown));
    expect(examples.length).toBeGreaterThanOrEqual(6);
    expect(examplesProblemsOf(examples, BODIES, KEYS_UNDER)).toEqual([]);
  });

  it('closes every code block of its section on a line of its own', () => {
    expect(fenceProblems(sectionOf(markdown))).toEqual([]);
  });

  it('documents the six routes, each under a heading of its own, and the /holders changes', () => {
    const section = sectionOf(markdown);
    for (const route of [
      'GET /v2/issuers/{issuer}/tokens',
      'GET /v2/tokens/{token}/summary',
      'GET /v2/tokens/{token}/supply',
      'GET /v2/tokens/{token}/flows',
      'GET /v2/tokens/{token}/distribution',
      'GET /v2/tokens/{token}/snapshot',
    ]) {
      expect([route, section.includes(`\n### \`${route}\`\n`)]).toEqual([route, true]);
    }
    const holders = partOf(markdown, '### `GET /v2/tokens/{currency}.{issuer}/holders`');
    expect(flat(holders)).toContain('(#token-history)');
    expect(flat(holders)).toContain('`first_ledger`');
  });

  it('links the routes from the Compatibility list of extras, with ADR-0021 and Amendment 12', () => {
    const compatibility = flat(partOf(markdown, '### Compatibility'));
    expect(compatibility).toContain('(#token-history)');
    expect(compatibility).toContain('[ADR-0021](adr/0021-token-history-in-clickhouse.md)');
    expect(compatibility).toMatch(/Amendment 12, items 118 to \d+/);
  });

  it('writes the messages of the routes as the code answers them', () => {
    const section = flat(sectionOf(markdown));
    for (const message of [
      'ledger is not in the token history yet',
      'token history is not built yet',
      'too many addresses to exclude',
      'window too large for interval ledger',
      'window too large',
      'a ledger is required',
      'invalid interval - use: day, hour, ledger',
      'invalid interval - use: day, hour, month',
      'the date provided is too old',
      'issuer does not match mpt issuance',
      'invalid marker',
      'token not found',
    ]) {
      expect([message, section.includes(`\`${message}\``)]).toEqual([message, true]);
    }
    expect(section).toContain('**Differences from data.ripple.com**: none');
  });
});
