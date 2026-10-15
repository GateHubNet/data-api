import {
  buildLedgerRows,
  FixtureLedgerSource,
  getNetworkProfile,
  NetworkName,
  parseContextFor,
  PaymentsRow,
  RawLedger,
  RawTransaction,
  TransactionsRow,
} from '@gatehub/data-api-shared';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** The ledger fixtures of the shared package, which the API tests seed ClickHouse with and check the codec against. */
const FIXTURES = join(__dirname, '..', '..', '..', '..', 'packages', 'shared', 'test', 'fixtures');
export const RIPPLE_MOCK_DIR = join(FIXTURES, 'xrpl', 'ripple-mock');
export const XRPL_RECORDED_DIR = join(FIXTURES, 'xrpl', 'recorded');
export const XAHAU_RECORDED_DIR = join(FIXTURES, 'xahau', 'recorded');

export type SeedName = 'ripple-mock' | 'xrpl-recorded' | 'xahau-recorded';

const DIRS: Record<SeedName, string> = {
  'ripple-mock': RIPPLE_MOCK_DIR,
  'xrpl-recorded': XRPL_RECORDED_DIR,
  'xahau-recorded': XAHAU_RECORDED_DIR,
};

const sources = new Map<SeedName, FixtureLedgerSource>();

/** The ledgers of a fixture set, parsed once per test file (the ledgers are frozen, so sharing them is safe). */
export function fixtureSource(seed: SeedName): FixtureLedgerSource {
  let source = sources.get(seed);
  if (!source) {
    source = FixtureLedgerSource.fromDir(DIRS[seed]);
    sources.set(seed, source);
  }
  return source;
}

/** The network a fixture set was recorded on. */
export const SEED_NETWORK: Record<SeedName, NetworkName> = {
  'ripple-mock': 'xrpl',
  'xrpl-recorded': 'xrpl',
  'xahau-recorded': 'xahau',
};

/** A transaction of a fixture ledger, with the ledger it is in and the row the syncer stores for it. */
export interface FixtureTx {
  ledger: RawLedger;
  tx: RawTransaction;
  row: TransactionsRow;
}

/** Every transaction of a fixture set, as `buildLedgerRows` stores it. */
export function fixtureTransactions(seed: SeedName): FixtureTx[] {
  const ctx = parseContextFor(getNetworkProfile(SEED_NETWORK[seed]));
  return fixtureSource(seed)
    .list()
    .flatMap((ledger) => {
      const rows = buildLedgerRows(ledger, ctx).transactions;
      return ledger.transactions.map((tx, i) => ({ ledger, tx, row: rows[i] }));
    });
}

/** A payment of a fixture ledger, as the syncer stores it in `payments`, with the ledger it is in. */
export interface FixturePayment {
  ledger: RawLedger;
  row: PaymentsRow;
}

/** Every payment of a fixture set, as `buildLedgerRows` stores it, in the order of the ledgers and of their transactions. */
export function fixturePayments(seed: SeedName): FixturePayment[] {
  const ctx = parseContextFor(getNetworkProfile(SEED_NETWORK[seed]));
  return fixtureSource(seed)
    .list()
    .flatMap((ledger) => buildLedgerRows(ledger, ctx).payments.map((row) => ({ ledger, row })));
}

/** One transaction of a fixture set by its hash. */
export function fixtureTransaction(seed: SeedName, hash: string): FixtureTx {
  const found = fixtureTransactions(seed).find((t) => t.tx.hash === hash);
  if (!found) throw new Error(`Transaction ${hash} is not in the ${seed} fixtures`);
  return found;
}

/** `TXN\0`, the hash prefix of a signed transaction. */
const TRANSACTION_ID_PREFIX = Buffer.from('54584E00', 'hex');

/**
 * The hash of a transaction from its binary form: the first half of the SHA-512 of `TXN\0` and the blob. Computed
 * here with node's crypto, so that it does not depend on the codec it is used to check.
 */
export function transactionId(blobHex: string): string {
  const digest = createHash('sha512')
    .update(Buffer.concat([TRANSACTION_ID_PREFIX, Buffer.from(blobHex, 'hex')]))
    .digest();
  return digest.subarray(0, 32).toString('hex').toUpperCase();
}

/** A transaction of a ledger in its binary form, as the API serves it with `binary=true`. */
export interface BinaryTx {
  hash: string;
  tx: string;
  meta: string;
}

/**
 * The root of the transaction tree (the ledger header's `transaction_hash`) of a ledger's binary transactions. A
 * ledger's tree holds the length-prefixed transaction and metadata blobs, so the root only matches when both blobs are
 * what the node serialized.
 */
export function transactionTreeRoot(items: BinaryTx[]): string {
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
  // The codec's internals have no public export; they are typed with the `buffer` polyfill, so everything is `any`.
  const { ShaMap } = require('ripple-binary-codec/dist/shamap') as any;
  const { Hash256 } = require('ripple-binary-codec/dist/types/hash-256') as any;
  const { HashPrefix } = require('ripple-binary-codec/dist/hash-prefixes') as any;
  const { BinarySerializer } = require('ripple-binary-codec/dist/serdes/binary-serializer') as any;
  const bytes = (hex: string) => ({ toBytesSink: (sink: any) => sink.put(Buffer.from(hex, 'hex')) });

  const map = new ShaMap();
  for (const { hash, tx, meta } of items) {
    const leaf = {
      hashPrefix: () => HashPrefix.transaction,
      toBytesSink(sink: any) {
        const serializer = new BinarySerializer(sink);
        serializer.writeLengthEncoded(bytes(tx));
        serializer.writeLengthEncoded(bytes(meta));
      },
    };
    map.addItem(Hash256.from(hash), leaf, undefined);
  }
  return map.hash().toString();
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
}
