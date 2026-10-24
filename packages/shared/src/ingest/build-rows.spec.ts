import BigNumber from 'bignumber.js';
import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PARSER_VERSION } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { getNetworkProfile } from '../network';
import { AmmParser } from '../parsers/amm.parser';
import { ParseContext, parseContextFor, toParserTx } from '../parsers/parser.interface';
import { PaymentParser } from '../parsers/payment.parser';
import { deepFreeze } from '../test-utils/deep-freeze';
import { buildLedgerRows, CHILD_TABLES, ChildRowsKey, LedgerParseError, LedgerRows } from './build-rows';
import { FixtureLedgerSource } from './fixture-ledger-source';
import { normalizeLedgerResponse, RawLedger } from './raw-ledger';

const PACKAGE_ROOT = join(__dirname, '..', '..');
const FIXTURES = join(PACKAGE_ROOT, 'test', 'fixtures');
/** Every schema file, in order: the ledger-derived tables are created in 001 and in later migrations (005, 007). */
const DDL = readdirSync(join(PACKAGE_ROOT, 'schema'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(PACKAGE_ROOT, 'schema', f), 'utf8'))
  .join('\n');

const XRPL: ParseContext = parseContextFor(getNetworkProfile('xrpl'));
const XAHAU: ParseContext = parseContextFor(getNetworkProfile('xahau'));

type Json = Record<string, any>;

// -- Fixture sets -----------------------------------------------------------------------------------------------

interface FixtureSet {
  name: string;
  ctx: ParseContext;
  dir: string;
  /**
   * Guards for the conservation check (c): at least this many transactions must have had their native total checked
   * and this many trustlines their two sides summed, so that exemptions or a parser regression cannot make it vacuous.
   * Set below what the fixtures give today (930/542, 1302/192, 1423/613, 193/96) to survive a re-recording.
   */
  minNativeChecked: number;
  minTrustlinesChecked: number;
}

const SETS: FixtureSet[] = [
  {
    name: 'ripple-mock (xrpl)',
    ctx: XRPL,
    dir: join(FIXTURES, 'xrpl', 'ripple-mock'),
    minNativeChecked: 900,
    minTrustlinesChecked: 500,
  },
  {
    name: 'recorded (xrpl)',
    ctx: XRPL,
    dir: join(FIXTURES, 'xrpl', 'recorded'),
    minNativeChecked: 1250,
    minTrustlinesChecked: 150,
  },
  {
    name: 'recorded AMM cases (xrpl)',
    ctx: XRPL,
    dir: join(FIXTURES, 'xrpl', 'amm'),
    minNativeChecked: 1300,
    minTrustlinesChecked: 550,
  },
  {
    name: 'recorded (xahau)',
    ctx: XAHAU,
    dir: join(FIXTURES, 'xahau', 'recorded'),
    minNativeChecked: 150,
    minTrustlinesChecked: 50,
  },
];

const RIPPLE_MOCK = SETS[0];
const AMM_SET = SETS[2];
const XAHAU_SET = SETS[3];

interface Built {
  raw: RawLedger;
  rows: LedgerRows;
}

const loaded = new Map<string, Built[]>();

/** Every ledger of a fixture set with its rows. Built once per set. */
function builtOf(set: FixtureSet): Built[] {
  let built = loaded.get(set.dir);
  if (!built) {
    built = FixtureLedgerSource.fromDir(set.dir)
      .list()
      .map((raw) => ({ raw, rows: buildLedgerRows(raw, set.ctx) }));
    loaded.set(set.dir, built);
  }
  return built;
}

function ledgerNamed(set: FixtureSet, index: number): Built {
  const found = builtOf(set).find((b) => b.raw.header.ledger_index === index);
  if (!found) throw new Error(`fixture ledger ${index} not found in ${set.dir}`);
  return found;
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value as Record<string, unknown>).every(isDeepFrozen);
}

// -- The ORDER BY keys, read from the DDL -----------------------------------------------------------------------

/** The LedgerRows property that holds the rows of each ledger-derived table. */
const ROW_KEY: ReadonlyArray<[Table, keyof LedgerRows]> = [
  [Table.Ledgers, 'ledger'],
  [Table.LedgerByHash, 'ledgerByHash'],
  [Table.Transactions, 'transactions'],
  [Table.TxByHash, 'txByHash'],
  [Table.TxByType, 'txByType'],
  [Table.AccountTransactions, 'accountTransactions'],
  [Table.AccountTxBySequence, 'accountTxBySequence'],
  [Table.Payments, 'payments'],
  [Table.PaymentsByCurrency, 'paymentsByCurrency'],
  [Table.AccountPayments, 'accountPayments'],
  [Table.Exchanges, 'exchanges'],
  [Table.AccountExchanges, 'accountExchanges'],
  [Table.BalanceChanges, 'balanceChanges'],
  [Table.AccountsCreated, 'accountsCreated'],
  [Table.AmmPoolStates, 'ammPoolStates'],
  [Table.AmmPoolTouches, 'ammPoolTouches'],
  [Table.AmmLiquidity, 'ammLiquidity'],
  [Table.AccountAmmLiquidity, 'accountAmmLiquidity'],
  [Table.AmmGovernance, 'ammGovernance'],
  [Table.AccountStates, 'accountStates'],
  [Table.PathPayments, 'pathPayments'],
];

/** The columns of a table in the order of its CREATE TABLE statement. */
function ddlColumns(table: Table): string[] {
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\n\\(\\n([\\s\\S]*?)\\n\\)\\s*\\nENGINE`).exec(DDL);
  if (!match) throw new Error(`no CREATE TABLE found for ${table} in the schema files`);
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('INDEX') && !line.startsWith('--'))
    .map((line) => line.split(/\s+/)[0]);
}

function orderByColumns(table: Table): string[] {
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\n[\\s\\S]*?\\nORDER BY \\(?([^)\\n]+)\\)?`).exec(
    DDL,
  );
  if (!match) throw new Error(`no ORDER BY found for ${table} in the schema files`);
  return match[1].split(',').map((c) => c.trim());
}

/** All the rows of one LedgerRows property across a list of ledgers. */
function collect(built: Built[], key: keyof LedgerRows): Json[] {
  return built.flatMap((b) => {
    const value = b.rows[key] as Json | Json[];
    return Array.isArray(value) ? value : [value];
  });
}

// -- Hand-built ledgers -----------------------------------------------------------------------------------------

const SENDER = 'rSenderSenderSenderSenderSenderxx';
const RECEIVER = 'rReceiverReceiverReceiverReceivxx';
const NEWBIE = 'rNewbieNewbieNewbieNewbieNewbiexx';
const TAKER = 'rTakerTakerTakerTakerTakerTakerxx';
const PROVIDER = 'rProviderProviderProviderProvidexxx';
const ISSUER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';

const usd = (value: string): Json => ({ currency: 'USD', issuer: ISSUER, value });

/**
 * A BookDirectory whose trailing 8 bytes encode `mantissa * 10^exponent` (units of TakerPays / TakerGets, native amounts
 * counted in drops): `exponent + 100` then a 7 byte mantissa.
 */
function bookDirectory(mantissa: string, exponent: number): string {
  const quality = (exponent + 100).toString(16).padStart(2, '0') + BigInt(mantissa).toString(16).padStart(14, '0');
  return `${'AB'.repeat(24)}${quality}`.toUpperCase();
}

/** 1e-6 USD per drop: one USD per XRP, so the sample offers trade 1:1. */
const QUALITY_ONE = bookDirectory('1000000000000000', -21);

const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex').toUpperCase();

function account(address: string, previous: string, final: string): Json {
  return {
    ModifiedNode: {
      LedgerEntryType: 'AccountRoot',
      FinalFields: { Account: address, Balance: final },
      PreviousFields: { Balance: previous },
    },
  };
}

/** An offer of `PROVIDER` (or `owner`) that a transaction consumed from 3 USD / 3 XRP to 1 USD / 1 XRP. */
function consumedOffer(owner: string): Json {
  return {
    ModifiedNode: {
      LedgerEntryType: 'Offer',
      FinalFields: {
        Account: owner,
        BookDirectory: QUALITY_ONE,
        Sequence: 77,
        TakerPays: usd('1'),
        TakerGets: '1000000',
      },
      PreviousFields: { TakerPays: usd('3'), TakerGets: '3000000' },
    },
  };
}

function rawTx(tx: Json, index: number, hash: string, nodes: Json[], result = 'tesSUCCESS', meta: Json = {}): Json {
  return {
    Fee: '10',
    Sequence: 1,
    ...tx,
    hash,
    metaData: { TransactionIndex: index, TransactionResult: result, AffectedNodes: nodes, ...meta },
  };
}

function ledgerOf(transactions: Json[], overrides: Json = {}): RawLedger {
  return normalizeLedgerResponse({
    ledger_index: '5000000',
    ledger_hash: 'L'.repeat(64),
    parent_hash: 'P'.repeat(64),
    account_hash: 'A'.repeat(64),
    transaction_hash: 'T'.repeat(64),
    total_coins: '99999999999000000',
    close_time: 750_000_000,
    parent_close_time: 749_999_990,
    close_time_resolution: 10,
    close_flags: 1,
    transactions,
    ...overrides,
  });
}

/** Five transactions: two native payments (one creates an account), two offer crossings, a ticketed AccountSet. */
function sampleLedger(): RawLedger {
  return ledgerOf([
    // 0: payment with a client memo, source tag 0 and destination tag 42.
    rawTx(
      {
        TransactionType: 'Payment',
        Account: SENDER,
        Destination: RECEIVER,
        Amount: '10000000',
        Fee: '12',
        Sequence: 7,
        SourceTag: 0,
        DestinationTag: 42,
        Memos: [{ Memo: { MemoType: hex('client'), MemoData: hex('xumm') } }],
      },
      0,
      '0'.repeat(63) + 'A',
      [account(SENDER, '100000000', '89999988'), account(RECEIVER, '10000000', '20000000')],
      'tesSUCCESS',
      { delivered_amount: '10000000' },
    ),
    // 1: OfferCreate by TAKER crossing PROVIDER's offer.
    rawTx(
      { TransactionType: 'OfferCreate', Account: TAKER, Fee: '15', Sequence: 3, TakerPays: usd('1'), TakerGets: '1' },
      1,
      '0'.repeat(63) + 'B',
      [consumedOffer(PROVIDER)],
    ),
    // 2: OfferCreate by TAKER crossing its own offer.
    rawTx(
      { TransactionType: 'OfferCreate', Account: TAKER, Fee: '20', Sequence: 4, TakerPays: usd('1'), TakerGets: '1' },
      2,
      '0'.repeat(63) + 'C',
      [consumedOffer(TAKER)],
    ),
    // 3: ticketed AccountSet that failed with a tec code; only the fee moved.
    rawTx(
      { TransactionType: 'AccountSet', Account: SENDER, Fee: '12', Sequence: 0, TicketSequence: 9 },
      3,
      '0'.repeat(63) + 'D',
      [account(SENDER, '89999988', '89999976')],
      'tecNO_PERMISSION',
    ),
    // 4: payment that creates an account; destination tag 0, no source tag.
    rawTx(
      {
        TransactionType: 'Payment',
        Account: SENDER,
        Destination: NEWBIE,
        Amount: '25000000',
        Fee: '10',
        Sequence: 8,
        DestinationTag: 0,
      },
      4,
      '0'.repeat(63) + 'E',
      [
        account(SENDER, '89999976', '64999966'),
        {
          CreatedNode: {
            LedgerEntryType: 'AccountRoot',
            NewFields: { Account: NEWBIE, Balance: '25000000', Sequence: 1 },
          },
        },
      ],
      'tesSUCCESS',
      { delivered_amount: '25000000' },
    ),
  ]);
}

// -- Snapshots --------------------------------------------------------------------------------------------------

/** The two JSON blobs are huge and are covered by a round-trip test; the snapshot keeps their length and a digest. */
function forSnapshot(rows: LedgerRows): unknown {
  const digest = (json: string) => `<${json.length} chars, sha256 ${createHash('sha256').update(json).digest('hex')}>`;
  return {
    ...rows,
    transactions: rows.transactions.map((row) => ({
      ...row,
      tx_json: digest(row.tx_json),
      meta_json: digest(row.meta_json),
    })),
  };
}

describe('buildLedgerRows snapshots', () => {
  it('ripple-mock ledger 11118827', () => {
    const { rows } = ledgerNamed(SETS[0], 11118827);
    expect(forSnapshot(rows)).toMatchSnapshot();
  });

  it('ripple-mock ledger 11119620 (payments, exchanges and issued currencies)', () => {
    const { rows } = ledgerNamed(SETS[0], 11119620);
    expect(forSnapshot(rows)).toMatchSnapshot();
  });

  it('ripple-mock ledger 11618225 (a payment that creates an account)', () => {
    const { rows } = ledgerNamed(SETS[0], 11618225);
    expect(forSnapshot(rows)).toMatchSnapshot();
  });

  it('recorded Xahau ledger 26540188 (GenesisMint, URITokenCreateSellOffer, Payment)', () => {
    const { rows } = ledgerNamed(XAHAU_SET, 26540188);
    expect(forSnapshot(rows)).toMatchSnapshot();
  });
});

// -- Mapping rules ----------------------------------------------------------------------------------------------

describe('buildLedgerRows mapping', () => {
  const raw = sampleLedger();
  const rows = buildLedgerRows(raw, XRPL);

  describe('ledger row', () => {
    it('copies the header, with unix times and total_coins as an exact string', () => {
      expect(rows.ledger).toMatchObject({
        ledger_index: 5_000_000,
        ledger_hash: 'L'.repeat(64),
        parent_hash: 'P'.repeat(64),
        account_hash: 'A'.repeat(64),
        transaction_hash: 'T'.repeat(64),
        total_coins: '99999999999000000',
        close_time: 750_000_000 + 946_684_800,
        parent_close_time: 749_999_990 + 946_684_800,
        close_time_resolution: 10,
        close_flags: 1,
        parser_version: PARSER_VERSION,
      });
      expect(rows.ledger.total_coins).toBe(raw.header.total_coins);
      expect(rows.ledgerByHash).toEqual({ ledger_hash: 'L'.repeat(64), ledger_index: 5_000_000 });
    });

    it('leaves ingested_at to the server default', () => {
      expect(rows.ledger).not.toHaveProperty('ingested_at');
    });

    it('counts transactions, types and results over all transactions', () => {
      expect(rows.ledger.tx_count).toBe(5);
      expect(rows.ledger.type_counts).toEqual({ Payment: 2, OfferCreate: 2, AccountSet: 1 });
      expect(rows.ledger.result_counts).toEqual({ tesSUCCESS: 4, tecNO_PERMISSION: 1 });
    });

    it('counts payments, exchanges (not transactions) and created accounts', () => {
      expect(rows.ledger.payments_count).toBe(2);
      expect(rows.ledger.exchanges_count).toBe(2);
      expect(rows.ledger.accounts_created).toBe(1);
      expect(rows.payments).toHaveLength(2);
      expect(rows.exchanges).toHaveLength(2);
      expect(rows.accountsCreated).toHaveLength(1);
    });

    it('sums, minimises and maximises the Fee of every transaction in drops, as strings', () => {
      // 12 + 15 + 20 + 12 + 10
      expect(rows.ledger.fee_total).toBe('69');
      expect(rows.ledger.fee_min).toBe('10');
      expect(rows.ledger.fee_max).toBe('20');
    });

    it('keeps fee sums exact above 2^53', () => {
      const big = ledgerOf([
        rawTx({ TransactionType: 'AccountSet', Account: SENDER, Fee: '9007199254740993' }, 0, 'F'.repeat(64), []),
        rawTx({ TransactionType: 'AccountSet', Account: SENDER, Fee: '9007199254740993' }, 1, 'E'.repeat(64), []),
      ]);
      const built = buildLedgerRows(big, XRPL);
      expect(built.ledger.fee_total).toBe('18014398509481986');
      expect(built.ledger.fee_min).toBe('9007199254740993');
      expect(built.ledger.fee_max).toBe('9007199254740993');
    });

    it('is all zero for a ledger without transactions, with fee_min 0 like the reference fees.js', () => {
      const empty = buildLedgerRows(ledgerOf([]), XRPL);
      expect(empty.ledger).toMatchObject({
        tx_count: 0,
        type_counts: {},
        result_counts: {},
        payments_count: 0,
        exchanges_count: 0,
        accounts_created: 0,
        fee_total: '0',
        fee_min: '0',
        fee_max: '0',
      });
      for (const [, key] of CHILD_TABLES) expect(empty[key]).toEqual([]);
    });

    it('maps a missing parent_close_time (genesis) to 0', () => {
      const genesis = buildLedgerRows(ledgerOf([], { parent_close_time: undefined, close_flags: undefined }), XRPL);
      expect(genesis.ledger.parent_close_time).toBe(0);
      expect(genesis.ledger.close_flags).toBe(0);
    });
  });

  describe('transactions, tx_by_hash, tx_by_type', () => {
    it('stores tx_json without hash or meta, and meta_json unaltered', () => {
      rows.transactions.forEach((row, i) => {
        const source = raw.transactions[i];
        expect(row.tx_json).toBe(JSON.stringify(source.tx));
        expect(row.meta_json).toBe(JSON.stringify(source.meta));
        const tx = JSON.parse(row.tx_json);
        expect(tx).not.toHaveProperty('hash');
        expect(tx).not.toHaveProperty('meta');
        expect(tx).not.toHaveProperty('metaData');
        expect(tx.TransactionType).toBe(row.tx_type);
        expect(JSON.parse(row.meta_json).TransactionResult).toBe(row.result);
      });
    });

    it('maps the scalar columns', () => {
      expect(rows.transactions[0]).toMatchObject({
        ledger_index: 5_000_000,
        tx_index: 0,
        hash: '0'.repeat(63) + 'A',
        tx_type: 'Payment',
        result: 'tesSUCCESS',
        account: SENDER,
        sequence: 7,
        fee: '12',
        close_time: 750_000_000 + 946_684_800,
      });
      expect(rows.transactions.map((r) => r.fee)).toEqual(['12', '15', '20', '12', '10']);
    });

    it('fills the lookup tables from the same transactions', () => {
      expect(rows.txByHash).toEqual(
        rows.transactions.map((r) => ({ hash: r.hash, ledger_index: 5_000_000, tx_index: r.tx_index })),
      );
      expect(rows.txByType).toEqual(
        rows.transactions.map((r) => ({
          tx_type: r.tx_type,
          ledger_index: 5_000_000,
          tx_index: r.tx_index,
          result: r.result,
        })),
      );
      expect(rows.txByType[3]).toEqual({
        tx_type: 'AccountSet',
        ledger_index: 5_000_000,
        tx_index: 3,
        result: 'tecNO_PERMISSION',
      });
    });
  });

  describe('account_transactions and account_tx_by_sequence', () => {
    it('has one row per affected account with is_initiator for the sender only', () => {
      const first = rows.accountTransactions.filter((r) => r.tx_index === 0);
      expect(first.map((r) => [r.account, r.is_initiator]).sort()).toEqual(
        [
          [RECEIVER, 0],
          [SENDER, 1],
        ].sort(),
      );
      for (const row of first) {
        expect(row).toMatchObject({
          ledger_index: 5_000_000,
          tx_type: 'Payment',
          result: 'tesSUCCESS',
          close_time: 750_000_000 + 946_684_800,
        });
      }
    });

    it('lists a failed (tec) transaction under its sender too', () => {
      expect(rows.accountTransactions.filter((r) => r.tx_index === 3)).toEqual([
        {
          account: SENDER,
          ledger_index: 5_000_000,
          tx_index: 3,
          tx_type: 'AccountSet',
          result: 'tecNO_PERMISSION',
          is_initiator: 1,
          close_time: 750_000_000 + 946_684_800,
        },
      ]);
    });

    it('has the sender only, with the transaction Sequence, and 0 for a ticketed transaction', () => {
      expect(rows.accountTxBySequence).toEqual([
        { account: SENDER, sequence: 7, ledger_index: 5_000_000, tx_index: 0 },
        { account: TAKER, sequence: 3, ledger_index: 5_000_000, tx_index: 1 },
        { account: TAKER, sequence: 4, ledger_index: 5_000_000, tx_index: 2 },
        { account: SENDER, sequence: 0, ledger_index: 5_000_000, tx_index: 3 },
        { account: SENDER, sequence: 8, ledger_index: 5_000_000, tx_index: 4 },
      ]);
    });
  });

  describe('payments, payments_by_currency, account_payments', () => {
    it('maps a native payment with the fee in drops, issuer empty and tags (0 kept)', () => {
      expect(rows.payments[0]).toEqual({
        ledger_index: 5_000_000,
        tx_index: 0,
        tx_hash: '0'.repeat(63) + 'A',
        close_time: 750_000_000 + 946_684_800,
        source: SENDER,
        destination: RECEIVER,
        currency: 'XRP',
        issuer: '',
        amount: '10',
        delivered_amount: '10',
        delivered_amount_f: 10,
        max_amount: null,
        source_currency: 'XRP',
        source_tag: 0,
        destination_tag: 42,
        invoice_id: null,
        fee: '12',
        source_balance_changes: JSON.stringify([{ counterparty: '', currency: 'XRP', value: '-10' }]),
        destination_balance_changes: JSON.stringify([{ counterparty: '', currency: 'XRP', value: '10' }]),
        client: 'xumm',
      });
    });

    it('maps an absent tag to null and a tag of 0 to 0', () => {
      expect(rows.payments[1]).toMatchObject({ tx_index: 4, source_tag: null, destination_tag: 0, client: null });
    });

    it('indexes the payment by the delivered currency and issuer, empty for native', () => {
      expect(rows.paymentsByCurrency).toEqual([
        { currency: 'XRP', issuer: '', ledger_index: 5_000_000, tx_index: 0 },
        { currency: 'XRP', issuer: '', ledger_index: 5_000_000, tx_index: 4 },
      ]);
    });

    it('has a sent row for the source and a received row for the destination', () => {
      const base = {
        ledger_index: 5_000_000,
        tx_index: 0,
        tx_hash: '0'.repeat(63) + 'A',
        close_time: 750_000_000 + 946_684_800,
        currency: 'XRP',
        issuer: '',
        delivered_amount: '10',
        delivered_amount_f: 10,
        source_tag: 0,
        destination_tag: 42,
      };
      expect(rows.accountPayments.filter((r) => r.tx_index === 0)).toEqual([
        { account: SENDER, direction: 'sent', counterparty: RECEIVER, ...base },
        { account: RECEIVER, direction: 'received', counterparty: SENDER, ...base },
      ]);
      expect(rows.accountPayments).toHaveLength(4);
    });

    // R112: a ReplacingMergeTree keeps one row per ORDER BY key, so the `sent` and the `received` row of one payment
    // must never share one. They differ in `account` unless a payment is to oneself, and then in `direction`.
    it('keys a row of account_payments by its direction too: (account, ledger_index, tx_index, direction)', () => {
      expect(orderByColumns(Table.AccountPayments)).toEqual(['account', 'ledger_index', 'tx_index', 'direction']);
    });

    describe('a payment to oneself', () => {
      const ledger = (): RawLedger =>
        ledgerOf([
          rawTx(
            { TransactionType: 'Payment', Account: SENDER, Destination: SENDER, Amount: '10000000', Fee: '12' },
            0,
            '0'.repeat(63) + 'F',
            [account(SENDER, '100000000', '99999988')],
            'tesSUCCESS',
            { delivered_amount: '10000000' },
          ),
        ]);

      it('is a conversion, not a payment: no row of payments or account_payments (the parser drops it)', () => {
        const built = buildLedgerRows(ledger(), XRPL);
        expect(built.payments).toEqual([]);
        expect(built.paymentsByCurrency).toEqual([]);
        expect(built.accountPayments).toEqual([]);
      });

      it('would still get its two rows, told apart by the key, if a parser did return it', () => {
        const parsed = jest.spyOn(PaymentParser.prototype, 'parse').mockReturnValue({
          source: SENDER,
          destination: SENDER,
          currency: 'XRP',
          amount: '10',
          delivered_amount: '10',
          source_currency: 'XRP',
          fee_drops: '12',
          source_balance_changes: [],
          destination_balance_changes: [],
        });
        try {
          const { accountPayments } = buildLedgerRows(ledger(), XRPL);
          expect(accountPayments.map((r) => [r.account, r.direction, r.counterparty])).toEqual([
            [SENDER, 'sent', SENDER],
            [SENDER, 'received', SENDER],
          ]);
          const key = (r: (typeof accountPayments)[number]): string =>
            JSON.stringify(orderByColumns(Table.AccountPayments).map((c) => (r as unknown as Json)[c]));
          expect(new Set(accountPayments.map(key)).size).toBe(2);
        } finally {
          parsed.mockRestore();
        }
      });
    });
  });

  describe('exchanges and account_exchanges', () => {
    it('maps an exchange with nullable columns as null, Float64 shadows and drop-free strings', () => {
      expect(rows.exchanges[0]).toEqual({
        base_currency: 'USD',
        base_issuer: ISSUER,
        counter_currency: 'XRP',
        counter_issuer: '',
        ledger_index: 5_000_000,
        tx_index: 1,
        node_index: 0,
        tx_hash: '0'.repeat(63) + 'B',
        close_time: 750_000_000 + 946_684_800,
        base_amount: '2',
        counter_amount: '2',
        base_amount_f: 2,
        counter_amount_f: 2,
        rate: '1',
        rate_f: 1,
        buyer: PROVIDER,
        seller: TAKER,
        taker: TAKER,
        provider: PROVIDER,
        offer_sequence: 77,
        amm_account: '',
        autobridged_currency: null,
        autobridged_issuer: null,
        tx_type: 'OfferCreate',
        client: null,
      });
    });

    it('leaves amm_account empty on every order-book row, in exchanges and in account_exchanges', () => {
      expect(rows.exchanges.length).toBeGreaterThan(0);
      for (const row of [...rows.exchanges, ...rows.accountExchanges]) expect(row.amm_account).toBe('');
    });

    it('has a row for the buyer and one for the seller, each a full copy of the exchange', () => {
      const [exchange] = rows.exchanges;
      expect(rows.accountExchanges.filter((r) => r.tx_index === 1)).toEqual([
        { account: PROVIDER, ...exchange },
        { account: TAKER, ...exchange },
      ]);
    });

    it('collapses a self-trade (buyer === seller) to one row for that account', () => {
      const own = rows.exchanges[1];
      expect(own.tx_index).toBe(2);
      expect(own.buyer).toBe(TAKER);
      expect(own.seller).toBe(TAKER);
      expect(rows.accountExchanges.filter((r) => r.tx_index === 2)).toEqual([{ account: TAKER, ...own }]);
      expect(rows.accountExchanges).toHaveLength(3);
    });

    it('keeps autobridged currency and issuer when the parser reports them', () => {
      const bridged = ledgerOf([
        rawTx(
          {
            TransactionType: 'OfferCreate',
            Account: TAKER,
            TakerPays: { currency: 'EUR', issuer: PROVIDER, value: '1' },
            TakerGets: usd('1'),
          },
          0,
          'B'.repeat(64),
          [consumedOffer(PROVIDER)],
        ),
      ]);
      const [exchange] = buildLedgerRows(bridged, XRPL).exchanges;
      expect(exchange.autobridged_currency).toBe('EUR');
      expect(exchange.autobridged_issuer).toBe(PROVIDER);
    });
  });

  describe('balance_changes', () => {
    const senderRows = rows.balanceChanges.filter((r) => r.tx_index === 0 && r.account === SENDER);

    it('has the fee row at node_index -1 and the payment row at its node, with nullable columns null', () => {
      expect(senderRows).toEqual([
        {
          account: SENDER,
          ledger_index: 5_000_000,
          tx_index: 0,
          node_index: -1,
          tx_hash: '0'.repeat(63) + 'A',
          close_time: 750_000_000 + 946_684_800,
          currency: 'XRP',
          counterparty: '',
          amount_change: '-0.000012',
          // The balance once the fee is paid and before the payment moved 10 XRP.
          final_balance: '99.999988',
          final_balance_f: 99.999988,
          change_type: 'transaction_cost',
          escrow_counterparty: null,
          escrow_balance_change: null,
          paychannel_counterparty: null,
          paychannel_fund_change: null,
          paychannel_fund_final_balance: null,
          paychannel_final_balance: null,
          paychannel_balance_change: null,
          client: 'xumm',
        },
        expect.objectContaining({
          node_index: 0,
          amount_change: '-10',
          final_balance: '89.999988',
          change_type: 'payment_source',
          client: 'xumm',
        }),
      ]);
    });

    it('has only the fee row for a failed transaction', () => {
      expect(rows.balanceChanges.filter((r) => r.tx_index === 3)).toEqual([
        expect.objectContaining({
          account: SENDER,
          node_index: -1,
          amount_change: '-0.000012',
          change_type: 'transaction_cost',
        }),
      ]);
    });
  });

  describe('accounts_created', () => {
    it('inception is the ledger close time and the genesis columns are null', () => {
      expect(rows.accountsCreated).toEqual([
        {
          account: NEWBIE,
          parent: SENDER,
          initial_balance: '25',
          ledger_index: 5_000_000,
          tx_index: 4,
          tx_hash: '0'.repeat(63) + 'E',
          inception: 750_000_000 + 946_684_800,
          genesis_balance: null,
          genesis_index: null,
        },
      ]);
    });
  });

  describe('Xahau', () => {
    it('uses XAH as the native currency and an empty issuer', () => {
      const built = buildLedgerRows(sampleLedger(), XAHAU);
      expect(built.payments.map((p) => [p.currency, p.issuer])).toEqual([
        ['XAH', ''],
        ['XAH', ''],
      ]);
      expect(built.balanceChanges.filter((r) => r.counterparty === '').every((r) => r.currency === 'XAH')).toBe(true);
    });
  });

  describe('input handling', () => {
    it('does not modify its deep-frozen input and is deterministic', () => {
      const frozen = sampleLedger();
      expect(isDeepFrozen(frozen)).toBe(true);
      const before = JSON.stringify(frozen);

      const first = buildLedgerRows(frozen, XRPL);
      const second = buildLedgerRows(frozen, XRPL);

      expect(JSON.stringify(frozen)).toBe(before);
      expect(second).toEqual(first);
    });

    it('returns output that is not frozen and shares no object with the input', () => {
      const frozen = deepFreeze(sampleLedger());
      const built = buildLedgerRows(frozen, XRPL);
      expect(Object.isFrozen(built.ledger)).toBe(false);
      expect(Object.isFrozen(built.ledger.type_counts)).toBe(false);
      expect(Object.isFrozen(built.transactions)).toBe(false);
    });

    it('rejects a transaction with no usable Fee instead of storing a bad fee', () => {
      const bad = ledgerOf([
        rawTx({ TransactionType: 'AccountSet', Account: SENDER, Fee: '1.5' }, 0, 'F'.repeat(64), []),
      ]);
      expect(() => buildLedgerRows(bad, XRPL)).toThrow(/Fee/);
    });

    it('throws a LedgerParseError that names the ledger for anything it cannot parse (ruling R96)', () => {
      const bad = ledgerOf([
        rawTx({ TransactionType: 'AccountSet', Account: SENDER, Fee: 'abc' }, 0, 'F'.repeat(64), []),
      ]);
      let thrown: unknown;
      try {
        buildLedgerRows(bad, XRPL);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(LedgerParseError);
      expect(thrown).toMatchObject({ name: 'LedgerParseError', ledgerIndex: 5000000 });
      expect((thrown as Error).message).toBe(
        `Cannot parse ledger 5000000: Ledger 5000000: transaction ${'F'.repeat(64)} has an invalid Fee "abc"`,
      );
    });

    it('treats a missing Fee as 0 (pseudo-transactions)', () => {
      const pseudo = ledgerOf([
        {
          TransactionType: 'EnableAmendment',
          Account: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
          Sequence: 0,
          hash: 'F'.repeat(64),
          metaData: { TransactionIndex: 0, TransactionResult: 'tesSUCCESS', AffectedNodes: [] },
        },
      ]);
      const built = buildLedgerRows(pseudo, XRPL);
      expect(built.transactions[0].fee).toBe('0');
      expect(built.ledger.fee_total).toBe('0');
      expect(built.ledger.fee_min).toBe('0');
    });
  });
});

// -- AMM rows ---------------------------------------------------------------------------------------------------

describe('AMM rows (parser version 2)', () => {
  const manifest = JSON.parse(readFileSync(join(AMM_SET.dir, 'manifest.json'), 'utf8')) as {
    cases: Record<string, { ledger: number; hash: string }>;
  };

  // Pools, assets and accounts of the recorded cases (as in amm.parser.spec.ts).
  const XRP_RLUSD = 'rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3';
  const RLUSD_USDC = 'rfWfhoLj3LiaBpoxus3h7pEF8jXDMtyGqb';
  const XRP_SNK = 'rGLnUKdptCVobJKEkrwxtdyGZ98Evdmqdz';
  const XRP_VOX = 'rhEypxvxNXMdMTd3GXpb6gTN1jvb4h3nef';
  const XRP_USD_BITSTAMP = 'rHUpaqUPbwzKZdzQ8ZQCme18FrgW9pB4am';
  const XRP_DVR = 'rUAEvY1XNvnkurE9RunV7u3yjh3jQsQPsG';
  const RLUSD = { currency: '524C555344000000000000000000000000000000', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' };
  const USDC = { currency: '5553444300000000000000000000000000000000', issuer: 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE' };
  const SNK = { currency: 'SNK', issuer: 'rDDYXY17rzuF44gVAAQ9MB6GRQFkvWSccm' };
  const VOX = { currency: '564F58F09F97BD00000000000000000000000000', issuer: 'rBnJZMDB9HZ6UxUoeQc7eaAQHA3Y1v6Hk3' };
  const BITSTAMP_USD = { currency: 'USD', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' };
  const DVR = { currency: 'DVR', issuer: 'rpvRJUcmqQqyCHCmYRPW9FXFAGQEcibVz9' };
  const XAH_GATEHUB = { currency: 'XAH', issuer: 'rswh1fvyLqHizBS2awu1vs6QcmwTBd9qiv' };

  /** A recorded case: the rows of its ledger, and a filter for the rows of the case's own transaction. */
  function ammCase(name: string) {
    const c = manifest.cases[name];
    const { raw, rows } = ledgerNamed(AMM_SET, c.ledger);
    const tx = rows.transactions.find((r) => r.hash === c.hash);
    if (!tx) throw new Error(`${name}: ${c.hash} is not in ledger ${c.ledger}`);
    const mine = <T extends { tx_index: number }>(list: T[]): T[] => list.filter((r) => r.tx_index === tx.tx_index);
    return {
      raw,
      rows,
      mine,
      tx,
      client: tx.tx_json.includes('"Memos"') ? undefined : null,
      at: { ledger_index: c.ledger, tx_index: tx.tx_index, tx_hash: c.hash, close_time: raw.header.close_time },
    };
  }

  describe('swaps: exchanges and account_exchanges', () => {
    it('swap_payment_xrp_iou: one exchange of the pool, the taker and the pool each get a copy', () => {
      const { rows, mine, at } = ammCase('swap_payment_xrp_iou');
      const taker = 'rMsrQGK9fZ6B2164QGLnjLMxBYSCY5xJ4W';
      const rate = new BigNumber('134').dividedBy('179.448166793').toString();
      const expected = {
        base_currency: RLUSD.currency,
        base_issuer: RLUSD.issuer,
        counter_currency: 'XRP',
        counter_issuer: '',
        ledger_index: at.ledger_index,
        tx_index: at.tx_index,
        node_index: 1,
        tx_hash: at.tx_hash,
        close_time: at.close_time,
        base_amount: '179.448166793',
        counter_amount: '134',
        base_amount_f: 179.448166793,
        counter_amount_f: 134,
        rate,
        rate_f: Number(rate),
        buyer: taker,
        seller: XRP_RLUSD,
        taker,
        provider: XRP_RLUSD,
        offer_sequence: 0,
        amm_account: XRP_RLUSD,
        autobridged_currency: null,
        autobridged_issuer: null,
        tx_type: 'Payment',
        client: null,
      };
      expect(mine(rows.exchanges)).toEqual([expected]);
      // Like a book row: the buyer first, then the seller, the pool being one of them.
      expect(mine(rows.accountExchanges)).toEqual([
        { account: taker, ...expected },
        { account: XRP_RLUSD, ...expected },
      ]);
    });

    it('swap_offercreate_xrp_iou: the pool is the buyer, so it comes first; tx_type is OfferCreate', () => {
      const { rows, mine } = ammCase('swap_offercreate_xrp_iou');
      const taker = 'rKYdJJLAgxbJcn9Ria2X5jMMiqP91r4qy';
      const [exchange] = mine(rows.exchanges);
      expect(exchange).toMatchObject({ buyer: XRP_RLUSD, seller: taker, taker, tx_type: 'OfferCreate', node_index: 3 });
      expect(mine(rows.accountExchanges).map((r) => r.account)).toEqual([XRP_RLUSD, taker]);
    });

    it('swap_iou_iou: the pool is found from its two lsfAMMNode lines alone, with the first as node_index', () => {
      const { rows, mine } = ammCase('swap_iou_iou');
      expect(mine(rows.exchanges)).toEqual([
        expect.objectContaining({
          base_currency: RLUSD.currency,
          counter_currency: USDC.currency,
          counter_issuer: USDC.issuer,
          base_amount: '22.19651885465',
          counter_amount: '22.21468168488',
          node_index: 1,
          provider: RLUSD_USDC,
          amm_account: RLUSD_USDC,
          offer_sequence: 0,
        }),
      ]);
    });

    it('offercreate_autobridged_pool_leg: autobridged currency and issuer are kept, like for a book row', () => {
      const { rows, mine } = ammCase('offercreate_autobridged_pool_leg');
      const exchange = mine(rows.exchanges).find((e) => e.amm_account !== '');
      // The book leg of the same transaction is autobridged to the far side too, through the other asset.
      expect(mine(rows.exchanges).find((e) => e.amm_account === '')).toMatchObject({
        autobridged_currency: RLUSD.currency,
        autobridged_issuer: RLUSD.issuer,
      });
      expect(exchange).toMatchObject({
        amm_account: XRP_RLUSD,
        autobridged_currency: XAH_GATEHUB.currency,
        autobridged_issuer: XAH_GATEHUB.issuer,
      });
    });

    it('payment_pool_and_book: the book exchange and the pool one side by side, told apart by amm_account and node', () => {
      const { rows, mine } = ammCase('payment_pool_and_book');
      const exchanges = mine(rows.exchanges);
      expect(exchanges.map((e) => e.amm_account)).toEqual(['', XRP_RLUSD]);
      expect(exchanges.map((e) => e.provider)).toEqual(['rKrVTQChbm1761udZt18u9Aq9onJwEyvZw', XRP_RLUSD]);
      expect(exchanges.map((e) => e.offer_sequence)).toEqual([107195225, 0]);
      expect(new Set(exchanges.map((e) => e.node_index)).size).toBe(2);
      expect(mine(rows.accountExchanges)).toHaveLength(4);
      // The ledger's exchange count counts swaps like any other exchange.
      expect(rows.ledger.exchanges_count).toBe(rows.exchanges.length);
    });

    it('payment_two_pools: one exchange per pool', () => {
      const { rows, mine } = ammCase('payment_two_pools');
      expect(mine(rows.exchanges).map((e) => e.amm_account)).toEqual([
        'rEaErQ5vEbHXThFedUrjz9YFotG5HHcxoW',
        'rs9ineLqrCzeAGS1bxsrW8x2n3bRJYAh3Q',
      ]);
    });

    it('a swap the pool makes with itself is one row for that account, like a self-trade of the order book', () => {
      const { raw, at } = ammCase('swap_payment_xrp_iou');
      const changed: RawLedger = {
        ...raw,
        transactions: raw.transactions.map((t) =>
          t.hash === at.tx_hash ? { ...t, tx: { ...t.tx, Account: XRP_RLUSD } } : t,
        ),
      };
      const rows = buildLedgerRows(changed, XRPL);
      const mine = <T extends { tx_index: number }>(list: T[]): T[] => list.filter((r) => r.tx_index === at.tx_index);
      expect(mine(rows.exchanges)).toEqual([
        expect.objectContaining({ buyer: XRP_RLUSD, seller: XRP_RLUSD, taker: XRP_RLUSD, amm_account: XRP_RLUSD }),
      ]);
      expect(mine(rows.accountExchanges).map((r) => r.account)).toEqual([XRP_RLUSD]);
    });

    it('failed AMM transactions and ledgers without AMM activity make no AMM swap', () => {
      for (const { rows } of builtOf(RIPPLE_MOCK)) {
        for (const row of [...rows.exchanges, ...rows.accountExchanges]) expect(row.amm_account).toBe('');
      }
    });
  });

  describe('amm_pool_states', () => {
    it('create: every value is there, with Float64 shadows of the exact strings', () => {
      const { rows, mine, at } = ammCase('create');
      expect(mine(rows.ammPoolStates)).toEqual([
        {
          amm_account: XRP_DVR,
          ...pick(at, ['ledger_index', 'tx_index', 'tx_hash', 'close_time']),
          tx_type: 'AMMCreate',
          base_currency: DVR.currency,
          base_issuer: DVR.issuer,
          counter_currency: 'XRP',
          counter_issuer: '',
          reserve_base: '1000000',
          reserve_counter: '500',
          lp_supply: '22360679.77499789',
          lp_currency: '036D9072B9D0C769D60E61FCC2E38D12E1C6BD27',
          reserve_base_f: 1_000_000,
          reserve_counter_f: 500,
          lp_supply_f: 22360679.77499789,
          trading_fee: 1000,
          auction_holder: 'rEh4WnsrdmE7V1XeTsWi5dM7FHH8hYuea3',
          auction_price: '0',
          auction_price_f: 0,
          auction_discounted_fee: 100,
          auction_expiration: 845235400,
          deleted: 0,
        },
      ]);
    });

    it('a swap: the reserves after it, every AMM node value null (not present in the metadata)', () => {
      const { rows, mine } = ammCase('swap_payment_xrp_iou');
      const [state] = mine(rows.ammPoolStates);
      expect(state).toMatchObject({
        amm_account: XRP_RLUSD,
        tx_type: 'Payment',
        base_currency: RLUSD.currency,
        counter_currency: 'XRP',
        reserve_base: '2447341.562339902',
        reserve_counter: '1823900.107357',
        reserve_base_f: 2447341.562339902,
        reserve_counter_f: 1823900.107357,
        deleted: 0,
      });
      for (const column of [
        'lp_supply',
        'lp_currency',
        'lp_supply_f',
        'trading_fee',
        'auction_holder',
        'auction_price',
        'auction_price_f',
        'auction_discounted_fee',
        'auction_expiration',
      ]) {
        expect(state).toHaveProperty(column, null);
      }
    });

    it('a deposit of one asset: the reserve whose node is absent is null, the AMM node values are there', () => {
      const { rows, mine } = ammCase('deposit_single_asset');
      const [state] = mine(rows.ammPoolStates);
      expect(state.reserve_base).toBeNull();
      expect(state.reserve_base_f).toBeNull();
      expect(state).toMatchObject({
        reserve_counter: '1846230.856091',
        lp_supply: '1791163807.530941',
        trading_fee: 205,
      });
    });

    it('withdraw_all_deletes_pool: deleted is 1 and the LP supply 0', () => {
      const { rows, mine } = ammCase('withdraw_all_deletes_pool');
      expect(mine(rows.ammPoolStates)).toEqual([
        expect.objectContaining({
          amm_account: XRP_SNK,
          tx_type: 'AMMWithdraw',
          base_currency: SNK.currency,
          reserve_base: '0',
          reserve_counter: '0',
          lp_supply: '0',
          lp_supply_f: 0,
          trading_fee: 250,
          deleted: 1,
        }),
      ]);
    });

    it('vote: the fee and the slot, no reserves', () => {
      const { rows, mine } = ammCase('vote');
      expect(mine(rows.ammPoolStates)).toEqual([
        expect.objectContaining({
          amm_account: XRP_VOX,
          tx_type: 'AMMVote',
          base_currency: VOX.currency,
          reserve_base: null,
          reserve_counter: null,
          reserve_base_f: null,
          reserve_counter_f: null,
          lp_supply: '7881180.64345377',
          trading_fee: 1000,
          auction_discounted_fee: 100,
          deleted: 0,
        }),
      ]);
    });
  });

  describe('amm_pool_touches', () => {
    it('is one row per state row, the same ledger, transaction and pool, in the same order', () => {
      let total = 0;
      for (const { rows } of builtOf(AMM_SET)) {
        expect(rows.ammPoolTouches).toEqual(
          rows.ammPoolStates.map(({ ledger_index, tx_index, amm_account }) => ({
            ledger_index,
            tx_index,
            amm_account,
          })),
        );
        total += rows.ammPoolTouches.length;
      }
      // the recorded ledgers hold a hundred pools' states: the index is not vacuously empty
      expect(total).toBeGreaterThan(100);
    });

    it('payment_two_pools: one touch for each of the two pools of the transaction', () => {
      const { rows, mine, at } = ammCase('payment_two_pools');
      expect(mine(rows.ammPoolTouches)).toEqual([
        { ledger_index: at.ledger_index, tx_index: at.tx_index, amm_account: 'rEaErQ5vEbHXThFedUrjz9YFotG5HHcxoW' },
        { ledger_index: at.ledger_index, tx_index: at.tx_index, amm_account: 'rs9ineLqrCzeAGS1bxsrW8x2n3bRJYAh3Q' },
      ]);
    });

    it('a pool deleted by the transaction is touched like any other', () => {
      const { rows, mine, at } = ammCase('withdraw_all_deletes_pool');
      expect(mine(rows.ammPoolTouches)).toEqual([
        { ledger_index: at.ledger_index, tx_index: at.tx_index, amm_account: XRP_SNK },
      ]);
    });

    it('a ledger without AMM activity has none', () => {
      for (const { rows } of builtOf(RIPPLE_MOCK)) expect(rows.ammPoolTouches).toEqual([]);
    });
  });

  describe('amm_liquidity and account_amm_liquidity', () => {
    it('deposit_two_asset: the signed pool amounts, the LP tokens and the mode, with shadows', () => {
      const { rows, mine, at } = ammCase('deposit_two_asset');
      const lp = 'rfzppK1YerX4U8Utr2kVvBuVPLF3m4Yu3z';
      const expected = {
        amm_account: XRP_RLUSD,
        ...pick(at, ['ledger_index', 'tx_index', 'tx_hash', 'close_time']),
        account: lp,
        initiator: lp,
        event: 'deposit',
        mode: 'two_asset',
        base_amount: '108.041216585',
        counter_amount: '82.769304',
        lp_tokens: '80142.926261',
        base_amount_f: 108.041216585,
        counter_amount_f: 82.769304,
        lp_tokens_f: 80142.926261,
      };
      expect(mine(rows.ammLiquidity)).toEqual([expected]);
      expect(mine(rows.accountAmmLiquidity)).toEqual([expected]);
    });

    it('withdraw_two_asset: negative amounts and LP tokens, out of the pool', () => {
      const { rows, mine } = ammCase('withdraw_two_asset');
      expect(mine(rows.ammLiquidity)).toEqual([
        expect.objectContaining({
          amm_account: RLUSD_USDC,
          event: 'withdraw',
          mode: 'two_asset',
          base_amount: '-4.18049701822',
          counter_amount: '-4.17981839135',
          lp_tokens: '-4.16712896228',
          base_amount_f: -4.18049701822,
          lp_tokens_f: -4.16712896228,
        }),
      ]);
    });

    it('create: an empty mode is the empty string', () => {
      const { rows, mine } = ammCase('create');
      const [row] = mine(rows.ammLiquidity);
      expect(row).toMatchObject({ event: 'create', mode: '', base_amount: '1000000', counter_amount: '500' });
      expect(mine(rows.accountAmmLiquidity)).toEqual([row]);
    });

    it('account_amm_liquidity is a copy of amm_liquidity row for row, sharing no object with it', () => {
      for (const { rows } of builtOf(AMM_SET)) {
        expect(rows.accountAmmLiquidity).toEqual(rows.ammLiquidity);
        rows.ammLiquidity.forEach((row, i) => expect(rows.accountAmmLiquidity[i]).not.toBe(row));
      }
    });

    it('a swap or a vote makes no liquidity row', () => {
      for (const name of ['swap_payment_xrp_iou', 'swap_iou_iou', 'vote', 'bid', 'lp_token_transfer']) {
        const { rows, mine } = ammCase(name);
        expect(mine(rows.ammLiquidity)).toEqual([]);
        expect(mine(rows.accountAmmLiquidity)).toEqual([]);
      }
    });
  });

  describe('amm_governance', () => {
    it('vote: the fee voted and the fee after, nothing else, no auth accounts', () => {
      const { rows, mine, at } = ammCase('vote');
      expect(mine(rows.ammGovernance)).toEqual([
        {
          amm_account: XRP_VOX,
          ...pick(at, ['ledger_index', 'tx_index', 'tx_hash', 'close_time']),
          kind: 'vote',
          account: 'rthwVkuErKQtat6Sn6X2vAeveCEWfFBnt',
          fee_voted: 1000,
          trading_fee_after: 1000,
          bid_min: null,
          bid_max: null,
          price_paid: null,
          slot_holder: null,
          slot_discounted_fee: null,
          slot_expiration: null,
          auth_accounts: [],
        },
      ]);
    });

    it('bid: the bid range, the price paid and the new slot', () => {
      const { rows, mine, at } = ammCase('bid');
      const bidder = 'r4S6hRiKREKkmMeqs8dpgyYAotGyck9g3h';
      expect(mine(rows.ammGovernance)).toEqual([
        {
          amm_account: XRP_USD_BITSTAMP,
          ...pick(at, ['ledger_index', 'tx_index', 'tx_hash', 'close_time']),
          kind: 'bid',
          account: bidder,
          fee_voted: null,
          trading_fee_after: null,
          bid_min: '294.354152174',
          bid_max: '294.354152174',
          price_paid: '294.354152174',
          slot_holder: bidder,
          slot_discounted_fee: 22,
          slot_expiration: 839322900,
          auth_accounts: [],
        },
      ]);
      expect(mine(rows.ammPoolStates)[0]).toMatchObject({
        base_currency: BITSTAMP_USD.currency,
        base_issuer: BITSTAMP_USD.issuer,
      });
    });
  });

  describe('every row has the columns of its table, in the order of the DDL', () => {
    const tables: Array<[Table, keyof LedgerRows]> = [
      [Table.Exchanges, 'exchanges'],
      [Table.AccountExchanges, 'accountExchanges'],
      [Table.AmmPoolStates, 'ammPoolStates'],
      [Table.AmmPoolTouches, 'ammPoolTouches'],
      [Table.AmmLiquidity, 'ammLiquidity'],
      [Table.AccountAmmLiquidity, 'accountAmmLiquidity'],
      [Table.AmmGovernance, 'ammGovernance'],
      [Table.AccountStates, 'accountStates'],
    ];

    it.each(tables)('%s', (table, key) => {
      const columns = ddlColumns(table);
      const rows = collect(builtOf(AMM_SET), key);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(Object.keys(row)).toEqual(columns);
    });

    it('over the recorded cases every AMM table gets rows', () => {
      for (const [, key] of CHILD_TABLES.filter(([table]) => table.includes('amm'))) {
        expect(collect(builtOf(AMM_SET), key).length).toBeGreaterThan(0);
      }
    });
  });

  describe('a ledger without AMM activity', () => {
    it('has empty AMM arrays, no unclassified pool and amm_account empty on every exchange row', () => {
      for (const { rows } of builtOf(RIPPLE_MOCK)) {
        expect(rows.ammPoolStates).toEqual([]);
        expect(rows.ammPoolTouches).toEqual([]);
        expect(rows.ammLiquidity).toEqual([]);
        expect(rows.accountAmmLiquidity).toEqual([]);
        expect(rows.ammGovernance).toEqual([]);
        expect(rows.diagnostics).toEqual({ ammUnclassified: 0 });
        for (const row of [...rows.exchanges, ...rows.accountExchanges]) expect(row.amm_account).toBe('');
      }
    });

    it('stores parser_version 4 (path payments, after the account states of 3)', () => {
      expect(PARSER_VERSION).toBe(4);
      for (const { rows } of builtOf(RIPPLE_MOCK).slice(0, 5)) expect(rows.ledger.parser_version).toBe(4);
      for (const { rows } of builtOf(AMM_SET)) expect(rows.ledger.parser_version).toBe(4);
    });
  });

  describe('diagnostics', () => {
    const ammParser = new AmmParser();

    it('ammUnclassified is the sum of what the parser could not classify, over the transactions of the ledger', () => {
      let total = 0;
      for (const { raw, rows } of builtOf(AMM_SET)) {
        const expected = raw.transactions.reduce(
          (sum, t) => sum + ammParser.parse(toParserTx(t, raw.header, null), XRPL).unclassified,
          0,
        );
        expect(rows.diagnostics).toEqual({ ammUnclassified: expected });
        total += expected;
      }
      expect(total).toBeGreaterThanOrEqual(0);
    });

    it('counts the pools of a ledger that give no row, per transaction', () => {
      // A successful OfferCreate whose only node is an lsfAMMNode line of a pool whose pair no node tells: no rows.
      const poolLine = (sequence: number): Json => ({
        ModifiedNode: {
          LedgerEntryType: 'RippleState',
          FinalFields: {
            Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: String(sequence + 1) },
            Flags: 0x01000000 | 0x00010000,
            HighLimit: { currency: 'USD', issuer: ISSUER, value: '0' },
            LowLimit: { currency: 'USD', issuer: PROVIDER, value: '0' },
          },
          PreviousFields: {
            Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: String(sequence) },
          },
        },
      });
      const offer = (index: number, hash: string) =>
        rawTx({ TransactionType: 'OfferCreate', Account: TAKER, TakerPays: usd('1'), TakerGets: '1' }, index, hash, [
          poolLine(index),
        ]);
      const rows = buildLedgerRows(ledgerOf([offer(0, 'A'.repeat(64)), offer(1, 'B'.repeat(64))]), XRPL);
      expect(rows.diagnostics).toEqual({ ammUnclassified: 2 });
      expect(rows.ammPoolStates).toEqual([]);
      expect(rows.exchanges).toEqual([]);
    });
  });
});

/** The listed properties of `object`, in that order. */
function pick<T extends object, K extends keyof T>(object: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, object[key]])) as Pick<T, K>;
}

describe('CHILD_TABLES', () => {
  it('lists every ledger-derived table except ledgers and ledger_by_hash, once: the 12 of the Ripple v2 data, the 5 AMM ones, the account states and the path payments', () => {
    const tables = CHILD_TABLES.map(([table]) => table);
    expect(new Set(tables).size).toBe(tables.length);
    expect([...tables].sort()).toEqual(
      [
        Table.Transactions,
        Table.TxByHash,
        Table.TxByType,
        Table.AccountTransactions,
        Table.AccountTxBySequence,
        Table.Payments,
        Table.PaymentsByCurrency,
        Table.AccountPayments,
        Table.Exchanges,
        Table.AccountExchanges,
        Table.BalanceChanges,
        Table.AccountsCreated,
        Table.AmmPoolStates,
        Table.AmmPoolTouches,
        Table.AmmLiquidity,
        Table.AccountAmmLiquidity,
        Table.AmmGovernance,
        Table.AccountStates,
        Table.PathPayments,
      ].sort(),
    );
  });

  it('points each table at the LedgerRows property that holds its rows', () => {
    const expected = new Map(ROW_KEY);
    for (const [table, key] of CHILD_TABLES) expect(expected.get(table)).toBe(key);
    const covered = new Set(CHILD_TABLES.map(([, key]) => key as string));
    // `diagnostics` is not rows: it is no child table and never inserted.
    expect(Object.keys(buildLedgerRows(sampleLedger(), XRPL)).sort()).toEqual(
      [...covered, 'ledger', 'ledgerByHash', 'diagnostics'].sort(),
    );
  });

  it('holds arrays of rows for every child property', () => {
    const built = buildLedgerRows(sampleLedger(), XRPL);
    for (const [, key] of CHILD_TABLES) expect(Array.isArray(built[key])).toBe(true);
  });

  it('does not take the diagnostics for a child property', () => {
    // Compile time: ChildRowsKey leaves out `diagnostics`, as it leaves out `ledger` and `ledgerByHash`.
    // @ts-expect-error 'diagnostics' is not a ChildRowsKey
    const key: ChildRowsKey = 'diagnostics';
    expect(CHILD_TABLES.map(([, k]) => k as string)).not.toContain(key);
  });
});

// -- Invariants over all fixtures -------------------------------------------------------------------------------

/** Row fields that hold an exact decimal amount (a String column). */
const AMOUNT_FIELDS = new Set([
  'amount',
  'delivered_amount',
  'max_amount',
  'base_amount',
  'counter_amount',
  'rate',
  'amount_change',
  'final_balance',
  'initial_balance',
  'genesis_balance',
  'escrow_balance_change',
  'paychannel_fund_change',
  'paychannel_fund_final_balance',
  'paychannel_final_balance',
  'paychannel_balance_change',
  'reserve_base',
  'reserve_counter',
  'lp_supply',
  'auction_price',
  'lp_tokens',
  'bid_min',
  'bid_max',
  'price_paid',
]);

/** Row fields that hold drops as an unsigned integer string. */
const DROPS_FIELDS = new Set(['fee', 'fee_total', 'fee_min', 'fee_max', 'total_coins']);

describe.each(SETS)('invariants over $name', (set) => {
  const built = () => builtOf(set);

  it('loads fixtures, and every input ledger is deep-frozen (e)', () => {
    expect(built().length).toBeGreaterThan(0);
    for (const { raw } of built()) expect(isDeepFrozen(raw)).toBe(true);
  });

  it('is deterministic and leaves the input unchanged (e)', () => {
    for (const { raw, rows } of built().slice(0, 12)) {
      const before = JSON.stringify(raw);
      expect(buildLedgerRows(raw, set.ctx)).toEqual(rows);
      expect(JSON.stringify(raw)).toBe(before);
    }
  });

  describe('(a) the ORDER BY key of every table is unique', () => {
    it.each(ROW_KEY)('%s', (table, key) => {
      const columns = orderByColumns(table);
      expect(columns.length).toBeGreaterThan(0);

      const rows = collect(built(), key);
      const seen = new Set<string>();
      for (const row of rows) {
        for (const column of columns) expect(row[column]).toBeDefined();
        const id = JSON.stringify(columns.map((c) => row[c]));
        if (seen.has(id)) throw new Error(`${table}: duplicate key ${id}`);
        seen.add(id);
      }
      expect(seen.size).toBe(rows.length);
    });
  });

  it('never produces an undefined value or a non-finite number (JSON would drop or null them)', () => {
    const problems: string[] = [];
    for (const [, key] of ROW_KEY) {
      for (const row of collect(built(), key)) {
        for (const [field, value] of Object.entries(row)) {
          if (value === undefined) problems.push(`${key}.${field} is undefined`);
          if (typeof value === 'number' && !Number.isFinite(value)) problems.push(`${key}.${field} is ${value}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('(b) every amount field is an exact string that parses as a finite BigNumber', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const [, key] of ROW_KEY) {
      for (const row of collect(built(), key)) {
        for (const [field, value] of Object.entries(row)) {
          if (value === null) continue;
          if (AMOUNT_FIELDS.has(field)) {
            if (typeof value !== 'string' || !new BigNumber(value).isFinite())
              problems.push(`${key}.${field}=${value}`);
            checked++;
          } else if (DROPS_FIELDS.has(field)) {
            if (typeof value !== 'string' || !/^\d+$/.test(value)) problems.push(`${key}.${field}=${value}`);
            checked++;
          } else if (field.endsWith('_f')) {
            // The Float64 shadow is Number() of its string.
            if (!Object.is(value, Number(row[field.slice(0, -2)]))) problems.push(`${key}.${field}=${value}`);
            checked++;
          }
        }
        if (key === 'payments') {
          for (const side of [row.source_balance_changes, row.destination_balance_changes]) {
            for (const change of JSON.parse(side) as Json[]) {
              if (typeof change.value !== 'string' || !new BigNumber(change.value).isFinite()) {
                problems.push(`payments balance change ${JSON.stringify(change)}`);
              }
              checked++;
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(1000);
  });

  it('(d) the ledger summary agrees with the rows', () => {
    for (const { raw, rows } of built()) {
      expect(rows.ledger.tx_count).toBe(rows.transactions.length);
      expect(rows.transactions).toHaveLength(raw.transactions.length);
      expect(rows.txByHash).toHaveLength(rows.transactions.length);
      expect(rows.txByType).toHaveLength(rows.transactions.length);
      expect(rows.accountTxBySequence).toHaveLength(rows.transactions.length);
      expect(rows.ledger.payments_count).toBe(rows.payments.length);
      expect(rows.paymentsByCurrency).toHaveLength(rows.payments.length);
      expect(rows.accountPayments).toHaveLength(rows.payments.length * 2);
      expect(rows.ledger.exchanges_count).toBe(rows.exchanges.length);
      expect(rows.ledger.accounts_created).toBe(rows.accountsCreated.length);
      expect(rows.ledger.parser_version).toBe(PARSER_VERSION);

      const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
      expect(sum(rows.ledger.type_counts)).toBe(rows.ledger.tx_count);
      expect(sum(rows.ledger.result_counts)).toBe(rows.ledger.tx_count);

      const fees = rows.transactions.map((r) => BigInt(r.fee));
      expect(rows.ledger.fee_total).toBe(fees.reduce((a, b) => a + b, 0n).toString());
      expect(rows.ledger.fee_max).toBe(fees.reduce((a, b) => (b > a ? b : a), 0n).toString());
      expect(rows.ledger.fee_min).toBe(fees.length ? fees.reduce((a, b) => (b < a ? b : a)).toString() : '0');
    }
  });

  it('every row of a transaction carries the ledger close time, index and the transaction hash', () => {
    for (const { raw, rows } of built()) {
      const hashes = new Map(rows.transactions.map((r) => [r.tx_index, r.hash]));
      for (const [, key] of CHILD_TABLES) {
        for (const row of rows[key] as Json[]) {
          expect(row.ledger_index).toBe(raw.header.ledger_index);
          if ('close_time' in row) expect(row.close_time).toBe(raw.header.close_time);
          if ('inception' in row) expect(row.inception).toBe(raw.header.close_time);
          if ('tx_hash' in row) expect(row.tx_hash).toBe(hashes.get(row.tx_index));
        }
      }
    }
  });

  it('native rows have an empty issuer and counterparty, issued rows do not', () => {
    for (const { rows } of built()) {
      for (const row of [...rows.payments, ...rows.accountPayments]) {
        if (row.currency === set.ctx.nativeCurrency) expect(row.issuer).toBe('');
      }
      for (const row of rows.balanceChanges) {
        if (row.currency === set.ctx.nativeCurrency && row.counterparty === '') continue;
        expect(row.counterparty).not.toBe('');
      }
      for (const row of rows.exchanges) {
        if (row.base_issuer === '') expect(row.base_currency).toBe(set.ctx.nativeCurrency);
        if (row.counter_issuer === '') expect(row.counter_currency).toBe(set.ctx.nativeCurrency);
      }
    }
  });

  describe('(c) conservation (rulings R4, R4b)', () => {
    /** Escrow and PayChannel move native currency into objects that are not AccountRoots. */
    const movesNativeIntoObjects = (type: string) => type.startsWith('Escrow') || type.startsWith('PaymentChannel');

    /** Xahau: rewards, genesis mints and imports mint XAH, and hooks may emit and rebate. */
    const xahauExempt = (tx: Json, meta: Json) =>
      ['ClaimReward', 'GenesisMint', 'Import'].includes(tx.TransactionType) ||
      tx.EmitDetails !== undefined ||
      meta.EmitDetails !== undefined ||
      meta.HookExecutions !== undefined;

    const exempt = (tx: Json, meta: Json): boolean =>
      movesNativeIntoObjects(tx.TransactionType) || (set.ctx.nativeCurrency === 'XAH' && xahauExempt(tx, meta));

    it('sums to zero per issued currency and trustline, and to -Fee for the native currency', () => {
      let nativeChecked = 0;
      let nativeExempt = 0;
      let lines = 0;
      let txs = 0;

      for (const { raw, rows } of built()) {
        const byTx = new Map<number, typeof rows.balanceChanges>();
        for (const row of rows.balanceChanges) byTx.set(row.tx_index, [...(byTx.get(row.tx_index) ?? []), row]);

        for (const t of raw.transactions) {
          txs++;
          const index = t.meta.TransactionIndex as number;
          const changes = byTx.get(index) ?? [];

          // Issued currencies: both sides of every trustline cancel.
          const sums = new Map<string, BigNumber>();
          for (const row of changes) {
            if (row.counterparty === '') continue;
            const pair = [row.account, row.counterparty].sort().join('|');
            const id = `${row.currency}|${pair}`;
            sums.set(id, (sums.get(id) ?? new BigNumber(0)).plus(row.amount_change));
          }
          for (const [id, sum] of sums) expect([t.hash, id, sum.toString()]).toEqual([t.hash, id, '0']);
          lines += sums.size;

          // Native currency: the fee is burned, nothing else is created or destroyed.
          if (exempt(t.tx, t.meta)) {
            nativeExempt++;
            continue;
          }
          const native = changes.filter((r) => r.counterparty === '' && r.currency === set.ctx.nativeCurrency);
          const total = native.reduce((acc, r) => acc.plus(r.amount_change), new BigNumber(0));
          const fee = new BigNumber(t.tx.Fee as string).dividedBy(1_000_000).negated();
          expect([t.hash, t.tx.TransactionType, total.toString()]).toEqual([
            t.hash,
            t.tx.TransactionType,
            fee.toString(),
          ]);
          nativeChecked++;
        }
      }

      // The check must really have run: not skipped by exemptions, not vacuous.
      expect(nativeChecked + nativeExempt).toBe(txs);
      expect(nativeChecked).toBeGreaterThanOrEqual(set.minNativeChecked);
      expect(lines).toBeGreaterThanOrEqual(set.minTrustlinesChecked);
    });
  });
});

describe('ripple-mock ground truth', () => {
  it('finds 182 payments over the 54 mock ledgers', () => {
    const built = builtOf(SETS[0]);
    expect(built).toHaveLength(54);
    expect(built.reduce((sum, b) => sum + b.rows.payments.length, 0)).toBe(182);
    expect(built.reduce((sum, b) => sum + b.rows.ledger.payments_count, 0)).toBe(182);
  });

  it('counts exchanges, not transactions, in exchanges_count (158 consumed offers)', () => {
    const built = builtOf(SETS[0]);
    expect(built.reduce((sum, b) => sum + b.rows.ledger.exchanges_count, 0)).toBe(158);
    expect(built.reduce((sum, b) => sum + b.rows.exchanges.length, 0)).toBe(158);
  });
});

// -- An empty Account (ruling R95) ------------------------------------------------------------------------------

/** The zero AccountID, which XRPL pseudo-transactions carry as their Account. */
const ZERO_ACCOUNT = 'rrrrrrrrrrrrrrrrrrrrrhoLvTp';

describe('a transaction whose Account is "" (Xahau UNLReport; ruling R95)', () => {
  /** Xahau flag ledger 26570752: 22 UNLReport pseudo-transactions (Account "") and 15 Payments. */
  const flag = (): RawLedger => {
    const [ledger] = FixtureLedgerSource.fromDir(join(FIXTURES, 'xahau', 'flag')).list();
    return ledger;
  };

  it('builds the rows of a recorded flag ledger: 22 UNLReport and 15 Payment', () => {
    const raw = flag();
    expect(raw.header.ledger_index).toBe(26570752);
    expect(raw.header.ledger_index % 256).toBe(0);
    const rows = buildLedgerRows(raw, XAHAU);
    expect(rows.ledger.tx_count).toBe(37);
    expect(rows.ledger.type_counts).toEqual({ UNLReport: 22, Payment: 15 });
    expect(rows.payments).toHaveLength(15);
  });

  it('stores the zero account in the sender columns and the node JSON (Account "") in tx_json', () => {
    const raw = flag();
    const rows = buildLedgerRows(raw, XAHAU);
    const reports = rows.transactions.filter((r) => r.tx_type === 'UNLReport');
    expect(reports).toHaveLength(22);
    for (const row of reports) {
      expect(row.account).toBe(ZERO_ACCOUNT);
      expect(row.sequence).toBe(0);
      expect(row.fee).toBe('0');
      expect(JSON.parse(row.tx_json).Account).toBe('');
    }
    const report = reports[0];
    const original = raw.transactions.find((t) => t.hash === report.hash);
    expect(report.tx_json).toBe(JSON.stringify(original?.tx));
    expect(rows.accountTxBySequence.filter((r) => r.account === ZERO_ACCOUNT)).toHaveLength(22);
    // The validators the report names in its metadata are not the sender: nothing is listed under ''.
    expect([...rows.accountTransactions, ...rows.accountTxBySequence].some((r) => r.account === '')).toBe(false);
  });

  it('matches the golden rows of the flag ledger', () => {
    expect(forSnapshot(buildLedgerRows(flag(), XAHAU))).toMatchSnapshot();
  });

  it('treats an empty Account the same way whatever the transaction type (a pseudo-transaction of any kind)', () => {
    const ledger = ledgerOf([
      {
        TransactionType: 'EmitFailure',
        Account: '',
        Fee: '0',
        Sequence: 0,
        SigningPubKey: '',
        hash: 'E'.repeat(64),
        metaData: { TransactionIndex: 0, TransactionResult: 'tesSUCCESS', AffectedNodes: [] },
      },
    ]);
    const rows = buildLedgerRows(ledger, XAHAU);
    expect(rows.transactions[0].account).toBe(ZERO_ACCOUNT);
    expect(JSON.parse(rows.transactions[0].tx_json).Account).toBe('');
    expect(rows.accountTxBySequence).toEqual([
      { account: ZERO_ACCOUNT, sequence: 0, ledger_index: 5000000, tx_index: 0 },
    ]);
  });

  it('still rejects a transaction that has no Account at all, or one that is not a string', () => {
    const missing = ledgerOf([
      {
        TransactionType: 'AccountSet',
        Fee: '10',
        Sequence: 1,
        hash: 'A'.repeat(64),
        metaData: { TransactionIndex: 0, TransactionResult: 'tesSUCCESS', AffectedNodes: [] },
      },
    ]);
    expect(() => buildLedgerRows(missing, XAHAU)).toThrow(/has no Account/);
    const numeric = ledgerOf([
      {
        TransactionType: 'AccountSet',
        Account: 7,
        Fee: '10',
        Sequence: 1,
        hash: 'B'.repeat(64),
        metaData: { TransactionIndex: 0, TransactionResult: 'tesSUCCESS', AffectedNodes: [] },
      },
    ]);
    expect(() => buildLedgerRows(numeric, XAHAU)).toThrow(/has no Account/);
  });
});
