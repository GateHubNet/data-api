import {
  AccountExchangesRow,
  AccountPaymentsRow,
  AccountsCreatedRow,
  AccountTransactionsRow,
  AccountTxBySequenceRow,
  BalanceChangesRow,
  buildLedgerRows,
  ExchangesRow,
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** The ledger fixtures of the shared package, which the API tests seed ClickHouse with and check the codec against. */
const FIXTURES = join(__dirname, '..', '..', '..', '..', 'packages', 'shared', 'test', 'fixtures');
export const RIPPLE_MOCK_DIR = join(FIXTURES, 'xrpl', 'ripple-mock');
export const XRPL_RECORDED_DIR = join(FIXTURES, 'xrpl', 'recorded');
/** Mainnet ledgers recorded around AMM transactions (swaps, deposits, withdrawals, votes, bids): see the fixtures README. */
export const XRPL_AMM_DIR = join(FIXTURES, 'xrpl', 'amm');
/** Mainnet ledgers around changes of account flags and an AccountDelete: see the fixtures README. */
export const XRPL_ACCOUNT_STATE_DIR = join(FIXTURES, 'xrpl', 'account-state');
/** Mainnet ledgers recorded around path payments and the payments that are not ones: see the fixtures README. */
export const XRPL_PATH_PAYMENTS_DIR = join(FIXTURES, 'xrpl', 'path-payments');
export const XAHAU_RECORDED_DIR = join(FIXTURES, 'xahau', 'recorded');
/** Xahau flag ledger 26570752: 22 UNLReport pseudo-transactions with `Account: ""`, and 15 Payments. */
export const XAHAU_FLAG_DIR = join(FIXTURES, 'xahau', 'flag');
export const XAHAU_FLAG_LEDGER = 26570752;

/**
 * The fixture sets the API tests seed. `xrpl-amm` is the AMM ledgers alone (16 ledgers from 93663334 on: 39 order-book
 * exchanges and 138 swaps against pools). `ripple-mock+amm` is the 54 mock ledgers of the original Ripple suite (2013 to
 * 2015) and the AMM ledgers together: the book-only history of the original next to the swaps of today, in one database.
 */
export type SeedName =
  | 'ripple-mock'
  | 'xrpl-recorded'
  | 'xrpl-amm'
  | 'ripple-mock+amm'
  | 'xrpl-account-state'
  | 'xrpl-path-payments'
  | 'xahau-recorded'
  | 'xahau-flag';

const DIRS: Record<SeedName, string[]> = {
  'ripple-mock': [RIPPLE_MOCK_DIR],
  'xrpl-recorded': [XRPL_RECORDED_DIR],
  'xrpl-amm': [XRPL_AMM_DIR],
  'ripple-mock+amm': [RIPPLE_MOCK_DIR, XRPL_AMM_DIR],
  'xrpl-account-state': [XRPL_ACCOUNT_STATE_DIR],
  'xrpl-path-payments': [XRPL_PATH_PAYMENTS_DIR],
  'xahau-recorded': [XAHAU_RECORDED_DIR],
  'xahau-flag': [XAHAU_FLAG_DIR],
};

const sources = new Map<SeedName, FixtureLedgerSource>();

/** The ledgers of a fixture set, parsed once per test file (the ledgers are frozen, so sharing them is safe). */
export function fixtureSource(seed: SeedName): FixtureLedgerSource {
  let source = sources.get(seed);
  if (!source) {
    source = new FixtureLedgerSource(DIRS[seed].flatMap((dir) => FixtureLedgerSource.fromDir(dir).list()));
    sources.set(seed, source);
  }
  return source;
}

/** The network a fixture set was recorded on. */
export const SEED_NETWORK: Record<SeedName, NetworkName> = {
  'ripple-mock': 'xrpl',
  'xrpl-recorded': 'xrpl',
  'xrpl-amm': 'xrpl',
  'ripple-mock+amm': 'xrpl',
  'xrpl-account-state': 'xrpl',
  'xrpl-path-payments': 'xrpl',
  'xahau-recorded': 'xahau',
  'xahau-flag': 'xahau',
};

/**
 * The flag ledger as the node serialized it (`ledger` with `binary: true`): the `tx_blob` and `meta` hex of every
 * transaction, by transaction hash (the hash is computed from the blob, so it does not depend on the codec under test).
 */
export function xahauFlagNodeBlobs(): Map<string, { tx: string; meta: string }> {
  const file = join(XAHAU_FLAG_DIR, `node-binary-${XAHAU_FLAG_LEDGER}.json.gz`);
  const result = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as {
    ledger: { transactions: { tx_blob: string; meta: string }[] };
  };
  return new Map(
    result.ledger.transactions.map((t) => [transactionId(t.tx_blob), { tx: t.tx_blob, meta: t.meta.toUpperCase() }]),
  );
}

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

/** An exchange of a fixture ledger, as the syncer stores it in `exchanges`, with the ledger it is in. */
export interface FixtureExchange {
  ledger: RawLedger;
  row: ExchangesRow;
}

/** Every exchange of a fixture set, as `buildLedgerRows` stores it, in the order of the ledgers and of their transactions. */
export function fixtureExchanges(seed: SeedName): FixtureExchange[] {
  const ctx = parseContextFor(getNetworkProfile(SEED_NETWORK[seed]));
  return fixtureSource(seed)
    .list()
    .flatMap((ledger) => buildLedgerRows(ledger, ctx).exchanges.map((row) => ({ ledger, row })));
}

/** An account creation of a fixture ledger, as the syncer stores it in `accounts_created`, with the ledger it is in. */
export interface FixtureAccount {
  ledger: RawLedger;
  row: AccountsCreatedRow;
}

/** Every account creation of a fixture set, as `buildLedgerRows` stores it, in the order of the ledgers and of their transactions. */
export function fixtureAccountsCreated(seed: SeedName): FixtureAccount[] {
  const ctx = parseContextFor(getNetworkProfile(SEED_NETWORK[seed]));
  return fixtureSource(seed)
    .list()
    .flatMap((ledger) => buildLedgerRows(ledger, ctx).accountsCreated.map((row) => ({ ledger, row })));
}

/** Every row of `account_transactions` a fixture set is stored as: one per account a transaction affects. */
export function fixtureAccountTransactions(seed: SeedName): AccountTransactionsRow[] {
  const ctx = parseContextFor(getNetworkProfile(SEED_NETWORK[seed]));
  return fixtureSource(seed)
    .list()
    .flatMap((ledger) => buildLedgerRows(ledger, ctx).accountTransactions);
}

/** Every row of `account_tx_by_sequence` a fixture set is stored as: one per transaction, under its sender. */
export function fixtureAccountTxBySequence(seed: SeedName): AccountTxBySequenceRow[] {
  const ctx = parseContextFor(getNetworkProfile(SEED_NETWORK[seed]));
  return fixtureSource(seed)
    .list()
    .flatMap((ledger) => buildLedgerRows(ledger, ctx).accountTxBySequence);
}

/** Every row of `account_payments` a fixture set is stored as: a `sent` and a `received` row per payment. */
export function fixtureAccountPayments(seed: SeedName): AccountPaymentsRow[] {
  const ctx = parseContextFor(getNetworkProfile(SEED_NETWORK[seed]));
  return fixtureSource(seed)
    .list()
    .flatMap((ledger) => buildLedgerRows(ledger, ctx).accountPayments);
}

/** Every row of `account_exchanges` a fixture set is stored as: a copy of the exchange per participating account. */
export function fixtureAccountExchanges(seed: SeedName): AccountExchangesRow[] {
  const ctx = parseContextFor(getNetworkProfile(SEED_NETWORK[seed]));
  return fixtureSource(seed)
    .list()
    .flatMap((ledger) => buildLedgerRows(ledger, ctx).accountExchanges);
}

/** Every row of `balance_changes` a fixture set is stored as. */
export function fixtureBalanceChanges(seed: SeedName): BalanceChangesRow[] {
  const ctx = parseContextFor(getNetworkProfile(SEED_NETWORK[seed]));
  return fixtureSource(seed)
    .list()
    .flatMap((ledger) => buildLedgerRows(ledger, ctx).balanceChanges);
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
