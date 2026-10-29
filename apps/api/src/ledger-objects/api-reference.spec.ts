import { readFileSync } from 'node:fs';
import {
  bodyOrderOf,
  examplesOf,
  examplesProblemsOf,
  fenceProblems,
  hasOwn,
  Json,
  partOf,
  REFERENCE,
  referenceChecks,
} from '../../test/support/api-reference-check';
import { DELEGATION_IDS_CAP } from '../accounts/delegations.service';
import * as featureCoverage from '../common/feature-coverage.service';
import { COVERAGE_KEYS } from '../common/feature-coverage.service';
import { DETAIL_EVENTS, LEDGER_OBJECT_NOT_FOUND, NOT_FOUND_OF } from './ledger-objects.service';
import * as objectViews from './object-views';
import {
  AMOUNT_KEYS,
  CHECK_KEYS,
  DELEGATION_KEYS,
  DELEGATIONS_BODY_KEYS,
  DETAIL_BODY_KEYS,
  ESCROW_KEYS,
  EVENT_EXTRA_KEYS,
  EVENT_KEYS,
  HISTORY_BODY_KEYS,
  LEDGER_OBJECT_KEYS,
  OBJECT_REF_KEYS,
  PAYMENT_CHANNEL_KEYS,
  PERMISSION_KEYS,
  REMOVED_KEYS,
} from './object-views';

/*
 * The "Ledger objects" section of docs/api-reference.md names the keys of every object it documents, in order, on a line of the
 * form
 *
 *   Keys of <object>, in order: `a, b?, c`.
 *
 * (a key that may be missing from an answer can be written `b?`). This spec ties each of those lines to the constant the code
 * serves the object by: the line is the reference, the constant is the code, and neither may drift from the other. When one
 * fails, fix the reference; a constant is pinned by the specs and the e2e suites of its route, and is never changed to fit a
 * line. The examples of the section are answers of the end-to-end suites (`ledger-objects.e2e-spec.ts`,
 * `delegations.e2e-spec.ts`): their keys come in the order of the constants, which the second half of the spec checks, so that an
 * example cannot be edited out of the code's order either. The checks themselves are in `test/support/api-reference-check.ts`.
 *
 * All of the routes are documented in this one section, the two routes under `/v2/accounts` (an escrow by owner and sequence, the
 * delegations) among them: the `## Accounts` section links to them, as it links to the NFTs and the path payments. The fences of
 * the whole reference are checked as well (every code block is closed on a line of its own), because a block that swallows the
 * next heading takes the anchors under it with it.
 */

const HEADING = '## Ledger objects';

/** The three kinds that have a detail, a history and a status, in the order the reference documents them. */
const KINDS = ['escrow', 'check', 'payment_channel'] as const;
type Kind = (typeof KINDS)[number];

/** The keys of the answer of `GET /v2/ledger_objects/{id}`, which has no constant of its own: `result`, then the `ledger_object`. */
const LEDGER_OBJECT_BODY_KEYS = ['result', 'ledger_object'] as const;

/** The object as the reference names it on its line, and the constant that holds its keys. One entry for each constant of the routes. */
const OBJECTS: Record<string, readonly string[]> = {
  // every answer but the lookup of an ID: the key after `result`
  'the coverage': COVERAGE_KEYS,
  // the parts the objects share
  'an amount': AMOUNT_KEYS,
  created: OBJECT_REF_KEYS,
  updated: OBJECT_REF_KEYS,
  removed: REMOVED_KEYS,
  // the history of an escrow, a check and a payment channel
  'an event': EVENT_KEYS,
  'the extras of an escrow event': EVENT_EXTRA_KEYS.escrow,
  'the extras of a check event': EVENT_EXTRA_KEYS.check,
  'the extras of a payment channel event': EVENT_EXTRA_KEYS.payment_channel,
  // GET /v2/escrows/{id}, /v2/checks/{id}, /v2/payment_channels/{id}
  'an escrow': ESCROW_KEYS,
  'a check': CHECK_KEYS,
  'a payment channel': PAYMENT_CHANNEL_KEYS,
  // GET /v2/accounts/{address}/delegations
  'a delegation': DELEGATION_KEYS,
  'a permission': PERMISSION_KEYS,
  // GET /v2/ledger_objects/{id}
  'a ledger object': LEDGER_OBJECT_KEYS,
  // the answers
  'the escrow answer': DETAIL_BODY_KEYS.escrow,
  'the check answer': DETAIL_BODY_KEYS.check,
  'the payment channel answer': DETAIL_BODY_KEYS.payment_channel,
  'the history answer': HISTORY_BODY_KEYS,
  'the delegations answer': DELEGATIONS_BODY_KEYS,
  'the ledger object answer': LEDGER_OBJECT_BODY_KEYS,
};

/** The objects that stand for one constant: the place of a fact in the ledger history is `created` and `updated` both. */
const SHARED_CONSTANTS = [['created', 'updated']];

const { sectionOf, keyLines, problemsOf, lineOf: lineIn } = referenceChecks(HEADING, OBJECTS);

// -- the examples ----------------------------------------------------------------------------------------------------------

/** The constant the object under a key is served by; a list takes the key of its elements. The events are told by `eventsOf`. */
const KEYS_UNDER: Record<string, readonly string[]> = {
  coverage: COVERAGE_KEYS,
  escrow: ESCROW_KEYS,
  check: CHECK_KEYS,
  payment_channel: PAYMENT_CHANNEL_KEYS,
  delegations: DELEGATION_KEYS,
  permissions: PERMISSION_KEYS,
  ledger_object: LEDGER_OBJECT_KEYS,
  created: OBJECT_REF_KEYS,
  updated: OBJECT_REF_KEYS,
  removed: REMOVED_KEYS,
  // an amount, wherever the code writes one
  amount: AMOUNT_KEYS,
  send_max: AMOUNT_KEYS,
  delivered: AMOUNT_KEYS,
  balance: AMOUNT_KEYS,
  amount_change: AMOUNT_KEYS,
  balance_change: AMOUNT_KEYS,
};

/** The keys of an event of a kind: the keys of every event, then what the kind adds. */
const eventsOf = (kind: Kind): readonly string[] => [...EVENT_KEYS, ...EVENT_EXTRA_KEYS[kind]];

/**
 * The answers of the routes: each ends with the list or the object that tells it from the others. A detail answer that has
 * 50 events or fewer has no `history_marker`, so each of the three has a variant that ends with its `history`.
 */
const BODIES: readonly (readonly string[])[] = [
  ...KINDS.flatMap((kind) => [DETAIL_BODY_KEYS[kind], DETAIL_BODY_KEYS[kind].slice(0, -1)]),
  HISTORY_BODY_KEYS,
  DELEGATIONS_BODY_KEYS,
  LEDGER_OBJECT_BODY_KEYS,
];

/** The answers every one of which the examples show at least once (the detail answers as they are with up to 50 events). */
const SHOWN: readonly (readonly string[])[] = [
  ...KINDS.map((kind) => DETAIL_BODY_KEYS[kind].slice(0, -1)),
  HISTORY_BODY_KEYS,
  DELEGATIONS_BODY_KEYS,
  LEDGER_OBJECT_BODY_KEYS,
];

/** The transaction types of the events of each kind. */
const KIND_OF_TX_TYPE: Record<string, Kind> = {
  EscrowCreate: 'escrow',
  EscrowFinish: 'escrow',
  EscrowCancel: 'escrow',
  CheckCreate: 'check',
  CheckCash: 'check',
  CheckCancel: 'check',
  PaymentChannelCreate: 'payment_channel',
  PaymentChannelFund: 'payment_channel',
  PaymentChannelClaim: 'payment_channel',
};

/**
 * The kind of object an answer is about, which tells the keys of its events: the object it holds, else, for a history, the
 * transaction type of its first event. Undefined when the answer has no event of a kind (a delegations answer, a history of none).
 */
function kindOf(example: Json): Kind | undefined {
  if (example === null || typeof example !== 'object' || Array.isArray(example)) return undefined;
  const found = KINDS.find((kind) => hasOwn(example, kind));
  if (found !== undefined) return found;
  const events = example.history;
  if (!Array.isArray(events) || events.length === 0) return undefined;
  const first = events[0];
  const txType = first !== null && typeof first === 'object' && !Array.isArray(first) ? first.tx_type : undefined;
  return typeof txType === 'string' ? KIND_OF_TX_TYPE[txType] : undefined;
}

/** What is wrong with the keys of the examples: the keys of the answers and of everything in them, the events of each kind in theirs. */
function allProblems(examples: Json[]): string[] {
  return examples.flatMap((example, i) => {
    const kind = kindOf(example);
    const under = kind === undefined ? KEYS_UNDER : { ...KEYS_UNDER, history: eventsOf(kind) };
    return examplesProblemsOf([example], BODIES, under).map((problem) =>
      problem.replace(/^example 1/, `example ${i + 1}`),
    );
  });
}

describe('the "Ledger objects" section of docs/api-reference.md', () => {
  const markdown = readFileSync(REFERENCE, 'utf8');

  it.each(Object.entries(OBJECTS))('writes the keys of %s as the code serves them', (object, constant) => {
    const own = keyLines(markdown).filter((line) => line.object === object);
    expect(own).toHaveLength(1);
    expect(own[0].keys).toEqual([...constant]);
  });

  it('has no line for an object the map does not name, and none twice', () => {
    const names = keyLines(markdown).map((line) => line.object);
    expect(names.filter((name) => !hasOwn(OBJECTS, name))).toEqual([]);
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
    expect(names).toHaveLength(Object.keys(OBJECTS).length);
  });

  it('is checked against every *_KEYS constant of the object views and the coverage: none is left out of the map', () => {
    // the constants that hold one list for each kind are taken apart: EVENT_EXTRA_KEYS.escrow, DETAIL_BODY_KEYS.check, ...
    const exported = [objectViews, featureCoverage].flatMap((module) =>
      Object.entries(module)
        .filter(([name]) => name.endsWith('_KEYS'))
        .flatMap(([name, value]): [string, unknown][] =>
          Array.isArray(value)
            ? [[name, value]]
            : Object.entries(value as Record<string, unknown>).map(([kind, keys]): [string, unknown] => [
                `${name}.${kind}`,
                keys,
              ]),
        ),
    );
    expect(exported.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'ESCROW_KEYS',
        'CHECK_KEYS',
        'PAYMENT_CHANNEL_KEYS',
        'EVENT_KEYS',
        'EVENT_EXTRA_KEYS.escrow',
        'EVENT_EXTRA_KEYS.check',
        'EVENT_EXTRA_KEYS.payment_channel',
        'OBJECT_REF_KEYS',
        'REMOVED_KEYS',
        'AMOUNT_KEYS',
        'DELEGATION_KEYS',
        'PERMISSION_KEYS',
        'LEDGER_OBJECT_KEYS',
        'DETAIL_BODY_KEYS.escrow',
        'DETAIL_BODY_KEYS.check',
        'DETAIL_BODY_KEYS.payment_channel',
        'HISTORY_BODY_KEYS',
        'DELEGATIONS_BODY_KEYS',
        'COVERAGE_KEYS',
      ]),
    );
    const mapped = new Set<unknown>(Object.values(OBJECTS));
    expect(exported.filter(([, value]) => !mapped.has(value)).map(([name]) => name)).toEqual([]);
    // and no constant stands for two objects, but the one that is `created` and `updated`
    const sharing = [...mapped]
      .map((constant) => Object.keys(OBJECTS).filter((object) => OBJECTS[object] === constant))
      .filter((objects) => objects.length > 1);
    expect(sharing).toEqual(SHARED_CONSTANTS);
  });

  it('has no problem', () => {
    expect(problemsOf(markdown)).toEqual([]);
  });

  it('closes every code block of the reference on a line of its own', () => {
    expect(fenceProblems(markdown)).toEqual([]);
  });

  it('documents the nine routes, each under a heading of its own, and links the two account routes from Accounts', () => {
    const section = sectionOf(markdown);
    for (const route of [
      'GET /v2/escrows/{escrow_id}',
      'GET /v2/escrows/{escrow_id}/history',
      'GET /v2/accounts/{address}/escrows/{sequence}',
      'GET /v2/checks/{check_id}',
      'GET /v2/checks/{check_id}/history',
      'GET /v2/payment_channels/{channel_id}',
      'GET /v2/payment_channels/{channel_id}/history',
      'GET /v2/accounts/{address}/delegations',
      'GET /v2/ledger_objects/{object_id}',
    ]) {
      expect([route, section.includes(`\n### \`${route}\`\n`)]).toEqual([route, true]);
    }
    const accounts = partOf(markdown, '## Accounts');
    expect(accounts).toContain('(#get-v2accountsaddressescrowssequence)');
    expect(accounts).toContain('(#get-v2accountsaddressdelegations)');
  });

  it('writes the messages of the routes as the code answers them, and the limits', () => {
    const section = sectionOf(markdown);
    for (const message of [
      'invalid escrow id',
      NOT_FOUND_OF.escrow,
      'unable to retrieve escrow',
      'unable to retrieve escrow history',
      'invalid check id',
      NOT_FOUND_OF.check,
      'unable to retrieve check',
      'unable to retrieve check history',
      'invalid channel id',
      NOT_FOUND_OF.payment_channel,
      'unable to retrieve payment channel',
      'unable to retrieve payment channel history',
      'invalid marker',
      'invalid ripple address',
      'invalid sequence number',
      'invalid direction',
      'unable to retrieve delegations',
      'invalid ledger object id',
      LEDGER_OBJECT_NOT_FOUND,
      'unable to retrieve ledger object',
    ]) {
      expect([message, section.includes(`\`${message}\``)]).toEqual([message, true]);
    }
    expect(section).toContain(`newest ${DETAIL_EVENTS} events`);
    expect(section).toContain(`${DELEGATION_IDS_CAP.toLocaleString('en-US')} or fewer`);
  });

  it('names the statuses an object can have, as the code works them out', () => {
    const section = sectionOf(markdown);
    for (const status of [
      'pending',
      'can_be_finished',
      'can_be_cancelled',
      'finished',
      'cancelled',
      'removed',
      'open',
      'expired',
      'cashed',
      'closing',
      'closed',
    ]) {
      expect([status, section.includes(`\`${status}\``)]).toEqual([status, true]);
    }
  });

  describe('its examples', () => {
    const examples = (): Json[] => examplesOf(sectionOf(markdown));

    it('are answers of the routes with their keys in the order of the code', () => {
      expect(allProblems(examples())).toEqual([]);
    });

    it('include an answer of every kind: a detail of each object, a history, the delegations and the lookup of an ID', () => {
      const all = examples();
      const bodies = all.map((example) => bodyOrderOf(example, BODIES));
      for (const body of SHOWN) expect(bodies).toContainEqual(body);
      // a history of an escrow and one of a payment channel, which are told by their events
      const histories = all.filter((example) => bodyOrderOf(example, BODIES) === HISTORY_BODY_KEYS).map(kindOf);
      expect(histories).toEqual(expect.arrayContaining(['escrow', 'payment_channel']));
    });

    it('include every state the reference tells apart: each status of the three objects it shows, a removed object, both coverages, Xahau', () => {
      const text = JSON.stringify(examples());
      for (const status of ['can_be_cancelled', 'finished', 'expired', 'cashed', 'open', 'closing']) {
        expect([status, text.includes(`"status":"${status}"`)]).toEqual([status, true]);
      }
      expect(text).toContain('"removed":{');
      expect(text).toContain('"complete":true');
      expect(text).toContain('"complete":false');
      expect(text).toContain('"delegations":[]');
      expect(text).toContain('"object_type":"Delegate"');
      expect(text).toContain('"deleted":true');
      // an amount of a token that is not the native currency, with its issuer
      expect(text).toMatch(/"amount":\{"currency":"[A-Z0-9]+","issuer":"r[1-9A-HJ-NP-Za-km-z]+","value":"[0-9.]+"\}/);
    });

    it('finds an example whose keys swapped places, and one that no answer has the keys of', () => {
      const detail = examples().find((example) => hasOwn(example as object, 'escrow')) as {
        coverage: Json;
        escrow: Json;
        history: Json;
      };
      expect(detail).toBeDefined();
      const swapped = { result: 'success', escrow: detail.escrow, coverage: detail.coverage, history: detail.history };
      expect(allProblems([swapped])).toEqual([
        expect.stringMatching(/^example 1: result, escrow, coverage, history is not in the order/),
      ]);
      expect(bodyOrderOf({ result: 'success', rows: [], extra: 1 }, BODIES)).toBeUndefined();
      expect(allProblems([{ result: 'success', rows: [], extra: 1 }])).toEqual([
        'example 1: no answer of the routes has the keys result, rows, extra',
      ]);
    });

    it('finds the keys of an event in another order than the code writes them, and a key of another kind', () => {
      const created = {
        event: 'create',
        ledger_index: 1,
        time: 't',
        tx_hash: 'H',
        tx_type: 'EscrowCreate',
        account: 'rA',
        result: 'tesSUCCESS',
        amount: { currency: 'XRP', value: '1' },
      };
      const answer = (event: Json): Json => ({
        result: 'success',
        coverage: { from_ledger_index: 1, complete: true },
        ledger_index: 2,
        close_time: 't',
        count: 1,
        history: [event],
      });
      expect(allProblems([answer(created)])).toEqual([]);
      const { time, ledger_index: ledgerIndex, ...rest } = created;
      expect(allProblems([answer({ time, ledger_index: ledgerIndex, ...rest })])).toEqual([
        expect.stringMatching(/^example 1\.history\[0\]: time, ledger_index, event, .* is not in the order/),
      ]);
      // the `delivered` of a check is no key of an escrow event, and the `expiration` of an escrow is none either
      expect(allProblems([answer({ ...created, delivered: { currency: 'XRP', value: '1' } })])).toEqual([
        expect.stringMatching(/^example 1\.history\[0\]: .* delivered is not in the order/),
      ]);
    });
  });

  describe('the check itself', () => {
    const lineOf = (object: string): string => lineIn(markdown, object);

    it('finds a line whose keys swapped places', () => {
      const line = lineOf('a permission');
      const swapped = line.replace('`permission, kind,', '`kind, permission,');
      expect(swapped).not.toBe(line);
      expect(problemsOf(markdown.replace(line, swapped))).toEqual([expect.stringMatching(/^drifted: a permission /)]);
    });

    it('finds a line with a key added, and one with a key gone', () => {
      const line = lineOf('a ledger object');
      expect(problemsOf(markdown.replace(line, line.replace(/\.$/, ', extra.')))).toEqual([
        expect.stringMatching(/^drifted: a ledger object /),
      ]);
      expect(problemsOf(markdown.replace(line, line.replace(/, ledger_index`\.$/, '`.')))).toEqual([
        expect.stringMatching(/^drifted: a ledger object /),
      ]);
    });

    it('finds a line that is missing, and one that is written twice', () => {
      const line = lineOf('removed');
      expect(problemsOf(markdown.replace(`${line}\n`, ''))).toEqual(['missing: no line for removed']);
      expect(problemsOf(markdown.replace(line, `${line}\n\n${line}`))).toEqual(['twice: 2 lines for removed']);
    });

    it('finds a line for an object nothing owns, and a line renamed', () => {
      const line = lineOf('a delegation');
      expect(
        problemsOf(markdown.replace(line, line.replace('Keys of a delegation,', 'Keys of the delegation,'))),
      ).toEqual(['missing: no line for a delegation', expect.stringMatching(/^unknown: a line for "the delegation"/)]);
    });

    it('reads an optional key written `key?` as the key', () => {
      const line = lineOf('an escrow');
      expect(problemsOf(markdown.replace(line, line.replace('`escrow_id,', '`escrow_id?,')))).toEqual([]);
    });

    it('does not read a line of another section', () => {
      expect(() => keyLines(markdown.replace('\n## Ledger objects\n', '\n## Other\n'))).toThrow(
        'has no "## Ledger objects" heading',
      );
      const outside = markdown.replace('\n## Stats\n', '\n## Stats\n\nKeys of a ghost, in order: `a, b`.\n');
      expect(outside).not.toBe(markdown);
      expect(problemsOf(outside)).toEqual([]);
    });

    describe('of the code blocks', () => {
      it('passes closed blocks, with a language or without, and tilde fences', () => {
        const text = '# T\n\n```json\n{ "a": 1 }\n```\n\ntext\n\n```\nplain\n```\n\n~~~\nx\n~~~\n';
        expect(fenceProblems(text)).toEqual([]);
      });

      it('finds a block that is never closed', () => {
        expect(fenceProblems('## A\n\n```json\n{ "a": 1 }\n\n## B\n')).toEqual([
          'line 3: the block opened here is never closed',
        ]);
      });

      it('finds a closing fence glued to the last line of the block', () => {
        const text = '## A\n\n```text\n"a","b"\n"1","2"```\n\n## B\n\nsome text\n\n```json\n{}\n```\n';
        expect(fenceProblems(text)).toEqual([
          'line 5: a fence at the end of a line of the block opened at line 3 (it closes nothing, put it on a line of its own)',
          // and the block swallowed the next block's opening fence: the lines after it are out of step
          'line 11: a fence opens inside the block opened at line 3 (the block above it was not closed)',
        ]);
      });

      it('finds two glued fences, which an even count of fence lines would let pass', () => {
        const text = '```text\n"1","2"```\n\nA\n\n```text\n"3","4"```\n\nB\n';
        expect(text.split('\n').filter((line) => line.startsWith('```'))).toHaveLength(2);
        expect(fenceProblems(text)).toEqual([
          'line 2: a fence at the end of a line of the block opened at line 1 (it closes nothing, put it on a line of its own)',
          'line 6: a fence opens inside the block opened at line 1 (the block above it was not closed)',
          'line 7: a fence at the end of a line of the block opened at line 1 (it closes nothing, put it on a line of its own)',
          'line 1: the block opened here is never closed',
        ]);
      });

      it('finds a fence that opens inside a block, which a missing closing fence before it leaves open', () => {
        expect(fenceProblems('```json\n{}\n\n```bash\nls\n```\n')).toEqual([
          'line 4: a fence opens inside the block opened at line 1 (the block above it was not closed)',
        ]);
      });

      it('closes a block only with a fence as long as the one that opened it, of the same character', () => {
        expect(fenceProblems('````\n```\nnot a close\n```\n````\n')).toEqual([]);
        expect(fenceProblems('```\n~~~\n```\n')).toEqual([]);
        expect(fenceProblems('````\ntext\n```\n')).toEqual(['line 1: the block opened here is never closed']);
      });

      it('takes a fence with up to three spaces before it', () => {
        expect(fenceProblems('   ```json\n{}\n   ```\n')).toEqual([]);
        expect(fenceProblems('   ```json\n{}\n')).toEqual(['line 1: the block opened here is never closed']);
      });

      it('takes inline code that holds three backticks outside a block as text', () => {
        expect(fenceProblems('A `` ``` `` fence is three backticks.\n')).toEqual([]);
      });

      it('finds nothing in the reference of the repository', () => {
        expect(fenceProblems(markdown)).toEqual([]);
        // and sees the one a closing fence glued to a row would leave in it
        const glued = markdown.replace(
          /\n```\n\nErrors, in the order they are checked: 400 `invalid escrow id`, `invalid marker`/,
          '```\n\nErrors, in the order they are checked: 400 `invalid escrow id`, `invalid marker`',
        );
        expect(glued).not.toBe(markdown);
        expect(fenceProblems(glued)).not.toEqual([]);
      });
    });
  });
});
