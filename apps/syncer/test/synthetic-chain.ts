import { normalizeLedgerResponse, RawLedger } from '@gatehub/data-api-shared';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The recorded ripple-mock ledger every synthetic ledger copies its transactions from (13 transactions). */
export const TEMPLATE_FILE = join(__dirname, '../../../packages/shared/test/fixtures/xrpl/ripple-mock/11119600.json');

const TEMPLATE = JSON.parse(readFileSync(TEMPLATE_FILE, 'utf8')) as Record<string, unknown>;

/** A ledger hash (64 upper-case hex digits) that depends only on the index and the salt. */
export function syntheticHash(index: number, salt = 'main'): string {
  return createHash('sha256').update(`synthetic-ledger:${salt}:${index}`).digest('hex').toUpperCase();
}

export interface SyntheticLedger {
  index: number;
  /** The ledger as a node returns it in `result.ledger` (the template's raw JSON with the rewritten fields). */
  json: Record<string, unknown>;
  /** The same ledger normalized, as a `LedgerSource` returns it. */
  raw: RawLedger;
}

export interface SyntheticChainOptions {
  /** This ledger's `parent_hash` does not match the previous ledger's hash (a fork). */
  breakAt?: number;
  /** Salt of every hash: two chains with different salts share no hash. */
  salt?: string;
}

/**
 * `count` contiguous ledgers `first` .. `first + count - 1`, all made from one recorded ripple-mock ledger (ruling R5):
 * only `ledger_index`, `ledger_hash` (and its alias `hash`) and `parent_hash` are rewritten, so that each ledger's
 * `parent_hash` is the previous ledger's hash. The transactions are the template's, unchanged.
 */
export function syntheticChain(first: number, count: number, opts: SyntheticChainOptions = {}): SyntheticLedger[] {
  const salt = opts.salt ?? 'main';
  const ledgers: SyntheticLedger[] = [];
  for (let index = first; index < first + count; index++) {
    const hash = syntheticHash(index, salt);
    const parentHash = index === opts.breakAt ? syntheticHash(index - 1, 'fork') : syntheticHash(index - 1, salt);
    const json: Record<string, unknown> = {
      ...structuredClone(TEMPLATE),
      ledger_index: String(index),
      seqNum: String(index),
      ledger_hash: hash,
      hash,
      parent_hash: parentHash,
    };
    ledgers.push({ index, json, raw: normalizeLedgerResponse(json) });
  }
  return ledgers;
}

/** `from` .. `to`, both inclusive. */
export function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
