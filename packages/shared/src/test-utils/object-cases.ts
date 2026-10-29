import { readFileSync } from 'fs';
import { join } from 'path';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { RawLedger, RawTransaction } from '../ingest/raw-ledger';

/**
 * The recorded escrow, check, payment channel and delegation cases of `test/fixtures/{xrpl,xahau}/objects` (D5, Task 1).
 * Test-only: `src/test-utils` is excluded from the build; the api imports it by relative path, as it does the validator
 * seeds. `FINDINGS.md` next to the ledgers says what each case shows and lists the names that were not found on the
 * network (`objectCase` answers `undefined` for them; the tests that need one build a synthetic transaction).
 */
export type ObjectNet = 'xrpl' | 'xahau';

/** The case names of Task 1, in order. */
export const OBJECT_CASES: Readonly<Record<ObjectNet, readonly string[]>> = {
  xrpl: [
    'escrow_create_timed',
    'escrow_create_conditional',
    'escrow_create_ticket',
    'escrow_finish_timed',
    'escrow_finish_fulfillment',
    'escrow_cancel',
    'escrow_create_token',
    'escrow_finish_token',
    'escrow_create_mpt',
    'check_create_xrp',
    'check_create_token',
    'check_cash_amount',
    'check_cash_deliver_min',
    'check_cancel_source',
    'check_cancel_third_party_expired',
    'channel_create',
    'channel_fund_expiration',
    'channel_claim',
    'channel_close_request',
    'channel_close_destination',
    'channel_renew',
    'channel_close_expired',
    'delegate_set_create',
    'delegate_set_replace',
    'delegate_set_empty',
    'delegated_payment',
    'delegated_tec',
    'delegated_batch_inner',
  ],
  xahau: [
    'escrow_create',
    'escrow_finish',
    'escrow_finish_escrow_id',
    'escrow_cancel',
    'escrow_create_token',
    'check_create',
    'check_cash',
    'channel_create',
    'channel_claim',
    'channel_create_token',
    'channel_claim_token',
  ],
};

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');

/** `…/test/fixtures/<net>/objects`. */
export function objectFixturesDir(net: ObjectNet): string {
  return join(FIXTURES, net, 'objects');
}

const sources = new Map<ObjectNet, FixtureLedgerSource>();
const sourceOf = (net: ObjectNet): FixtureLedgerSource => {
  let source = sources.get(net);
  if (!source) {
    source = FixtureLedgerSource.fromDir(objectFixturesDir(net));
    sources.set(net, source);
  }
  return source;
};

/** Every recorded ledger of the set, ascending. The caller must not change them. */
export function objectLedgers(net: ObjectNet): RawLedger[] {
  return sourceOf(net).list();
}

interface ManifestCase {
  ledger: number;
  hash: string;
  type: string;
  note: string;
}

/** The case's ledger and transaction; `undefined` for a case that `FINDINGS.md` lists as not found. */
export function objectCase(net: ObjectNet, name: string): { ledger: RawLedger; tx: RawTransaction } | undefined {
  if (!OBJECT_CASES[net].includes(name)) throw new Error(`${net}/objects has no case named "${name}"`);
  const manifest = JSON.parse(readFileSync(join(objectFixturesDir(net), 'manifest.json'), 'utf8')) as {
    cases?: Record<string, ManifestCase>;
  };
  const c = manifest.cases?.[name];
  if (!c) return undefined;
  const ledger = sourceOf(net)
    .list()
    .find((l) => l.header.ledger_index === c.ledger);
  const tx = ledger?.transactions.find((t) => t.hash === c.hash);
  if (!ledger || !tx) throw new Error(`${net}/objects ${name}: ${c.hash} is not in ledger ${c.ledger}`);
  return { ledger, tx };
}
