import { normalizeLedgerResponse, RawLedger, RIPPLE_EPOCH_MS } from '@gatehub/data-api-shared';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** The recorded ripple-mock ledger every synthetic ledger copies its transactions from (13 transactions). */
export const TEMPLATE_FILE = join(__dirname, '../../../packages/shared/test/fixtures/xrpl/ripple-mock/11119600.json');

const TEMPLATE = JSON.parse(readFileSync(TEMPLATE_FILE, 'utf8')) as Record<string, unknown>;

/**
 * Recorded mainnet AMM ledgers: 107612573 (an AMMCreate and 7 swaps against pools) and 107644916 (an AMMVote and 3
 * swaps), so that a ledger made of both has rows for all five AMM tables.
 */
export const AMM_TEMPLATE_FILES = ['107612573', '107644916'].map((index) =>
  join(__dirname, `../../../packages/shared/test/fixtures/xrpl/amm/${index}.json.gz`),
);

/**
 * The recorded mainnet ledger 107886233: 10 NFTokenMints (one with an offer, one on a page that splits) and 3
 * NFTokenCreateOffers among its 102 transactions, so that a ledger made of it has rows in all five NFT tables.
 */
export const NFT_TEMPLATE_FILE = join(__dirname, '../../../packages/shared/test/fixtures/xrpl/nft/107886233.json.gz');

/** The recorded NFTokenCreateOffer (a sell offer of 19.98 XRP) of `NFT_TEMPLATE_FILE` that `nftTemplate` copies. */
const NFT_SELL_OFFER_HASH = 'BB9BE0C948CB66FB19AD53AA77C6C4FA664D825AA3B7C3CA2397DC2D091B5BD9';

type Json = Record<string, any>;

/**
 * The template of a chain with AMM activity: the transactions of the recorded AMM ledgers in `AMM_TEMPLATE_FILES` (the
 * header is the first one's), plus `unclassified` transactions that each touch a pool the AMM parser cannot classify (a
 * successful OfferCreate whose only node is a pool's lsfAMMNode trust line, so that its pair is unknown: no rows, +1 on
 * `syncer_amm_unclassified_total`). The recorded transactions alone have none.
 */
export function ammTemplate(unclassified = 0): Record<string, unknown> {
  const [first, ...others] = AMM_TEMPLATE_FILES.map(
    (file) => JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')).ledger as Json,
  );
  const transactions: Json[] = [...first.transactions];
  for (const ledger of others) {
    for (const tx of ledger.transactions as Json[]) {
      transactions.push({ ...tx, metaData: { ...tx.metaData, TransactionIndex: transactions.length } });
    }
  }
  const pool = 'rUnclassifiedPoolAccountxxxxxxxxx';
  const issuer = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
  for (let k = 0; k < unclassified; k++) {
    transactions.push({
      Account: 'rUnclassifiedTakerAccountxxxxxxxx',
      TransactionType: 'OfferCreate',
      Fee: '10',
      Sequence: 1 + k,
      TakerPays: { currency: 'USD', issuer, value: '1' },
      TakerGets: '1',
      hash: `C${k.toString(16).toUpperCase()}`.padEnd(64, 'C'),
      metaData: {
        TransactionIndex: transactions.length,
        TransactionResult: 'tesSUCCESS',
        AffectedNodes: [
          {
            ModifiedNode: {
              LedgerEntryType: 'RippleState',
              FinalFields: {
                Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: '2' },
                Flags: 0x01000000 | 0x00010000,
                HighLimit: { currency: 'USD', issuer, value: '0' },
                LowLimit: { currency: 'USD', issuer: pool, value: '0' },
              },
              PreviousFields: { Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: '1' } },
            },
          },
        ],
      },
    });
  }
  return { ...first, transactions };
}

/**
 * The template of a chain with NFT activity: the transactions of the recorded ledger in `NFT_TEMPLATE_FILE`, plus `skipped`
 * transactions `synthetic-mpt-offer-<k>` that each create a sell offer priced with an MPT amount, which the NFT parser
 * drops and counts (no row, +1 on `syncer_nft_skipped_total`; no NFT offer on mainnet is priced so). They are the recorded
 * sell offer with its amount replaced, with a hash and an index of their own. The recorded transactions alone skip nothing.
 */
export function nftTemplate(skipped = 0): Record<string, unknown> {
  const ledger = JSON.parse(gunzipSync(readFileSync(NFT_TEMPLATE_FILE)).toString('utf8')).ledger as Json;
  const transactions: Json[] = [...ledger.transactions];
  const recorded = transactions.find((tx) => tx.hash === NFT_SELL_OFFER_HASH);
  if (!recorded) throw new Error(`transaction ${NFT_SELL_OFFER_HASH} is not in ${NFT_TEMPLATE_FILE}`);
  const amount = { mpt_issuance_id: '0000012FFD9EE5DA93AC614B4DB94D7E0FCE415CA51BED47', value: '100' };
  for (let k = 0; k < skipped; k++) {
    const copy = structuredClone(recorded);
    copy.Amount = amount;
    copy.hash = `D${k.toString(16).toUpperCase()}`.padEnd(64, 'D');
    copy.metaData.TransactionIndex = transactions.length;
    for (const node of copy.metaData.AffectedNodes as Json[]) {
      if (node.CreatedNode?.LedgerEntryType === 'NFTokenOffer') node.CreatedNode.NewFields.Amount = amount;
    }
    transactions.push(copy);
  }
  return { ...ledger, transactions };
}

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
  /** The ledger the transactions are copied from. Default: the ripple-mock ledger of `TEMPLATE_FILE`. */
  template?: Record<string, unknown>;
  /** This ledger's `parent_hash` does not match the previous ledger's hash (a fork). */
  breakAt?: number;
  /** Salt of every hash: two chains with different salts share no hash. */
  salt?: string;
  /** This ledger's first transaction has a `Fee` the parser rejects (`buildLedgerRows` throws on it). */
  malformedAt?: number;
  /**
   * When ledger `index` closed, in unix seconds. It is written as the ledger's `close_time` and, for the next ledger, as its
   * `parent_close_time`, both in Ripple time (seconds since 2000-01-01) as a node reports them. Without it every ledger keeps
   * the template's close time and no `parent_close_time`.
   */
  closeTime?: (index: number) => number;
}

const RIPPLE_EPOCH_SECONDS = RIPPLE_EPOCH_MS / 1000;

/**
 * `count` contiguous ledgers `first` .. `first + count - 1`, all made from one recorded ripple-mock ledger (ruling R5):
 * only `ledger_index`, `ledger_hash` (and its alias `hash`) and `parent_hash` are rewritten, so that each ledger's
 * `parent_hash` is the previous ledger's hash. The transactions are the template's, unchanged.
 */
export function syntheticChain(first: number, count: number, opts: SyntheticChainOptions = {}): SyntheticLedger[] {
  const salt = opts.salt ?? 'main';
  const template = opts.template ?? TEMPLATE;
  const ledgers: SyntheticLedger[] = [];
  for (let index = first; index < first + count; index++) {
    const hash = syntheticHash(index, salt);
    const parentHash = index === opts.breakAt ? syntheticHash(index - 1, 'fork') : syntheticHash(index - 1, salt);
    const json: Record<string, unknown> = {
      ...structuredClone(template),
      ledger_index: String(index),
      seqNum: String(index),
      ledger_hash: hash,
      hash,
      parent_hash: parentHash,
    };
    if (opts.closeTime !== undefined) {
      json.close_time = opts.closeTime(index) - RIPPLE_EPOCH_SECONDS;
      json.parent_close_time = opts.closeTime(index - 1) - RIPPLE_EPOCH_SECONDS;
    }
    if (index === opts.malformedAt) {
      const [first, ...rest] = json.transactions as Record<string, unknown>[];
      json.transactions = [{ ...first, Fee: 'not a number' }, ...rest];
    }
    ledgers.push({ index, json, raw: normalizeLedgerResponse(json) });
  }
  return ledgers;
}

/** `from` .. `to`, both inclusive. */
export function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
