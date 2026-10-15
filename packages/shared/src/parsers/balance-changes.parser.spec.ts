import { BigNumber } from 'bignumber.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { RawLedger } from '../ingest/raw-ledger';
import { getNetworkProfile } from '../network';
import { deepFreeze } from '../test-utils/deep-freeze';
import { BalanceChangesParser, ParsedBalanceChange } from './balance-changes.parser';
import { ParseContext, parseContextFor, ParserTx, toParserTx } from './parser.interface';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');

const XRPL: ParseContext = parseContextFor(getNetworkProfile('xrpl'));
const XAHAU: ParseContext = parseContextFor(getNetworkProfile('xahau'));

type Json = Record<string, any>;

const parser = new BalanceChangesParser();

// -- builders ---------------------------------------------------------------------------------------------------------

/** A parser input, deep-frozen like the real thing so that a write anywhere in the parser throws. */
function parserTx(tx: Json, nodes: Json[], meta: Json = {}): ParserTx {
  return deepFreeze({
    hash: 'HASH',
    ledger_index: 100,
    close_time: 1_700_000_000,
    tx_index: 0,
    client: null,
    tx: { Fee: '12', ...tx },
    meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: nodes, ...meta },
  });
}

/** A native balance change on an account, in drops. */
function root(account: string, before: string, after: string, kind = 'ModifiedNode'): Json {
  return {
    [kind]: {
      LedgerEntryType: 'AccountRoot',
      FinalFields: { Account: account, Balance: after },
      PreviousFields: { Balance: before },
    },
  };
}

/** A trustline balance change. The balance is from the low account's point of view. */
function line(low: string, high: string, currency: string, before: string, after: string, kind = 'ModifiedNode'): Json {
  return {
    [kind]: {
      LedgerEntryType: 'RippleState',
      FinalFields: {
        Balance: { currency, issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: after },
        HighLimit: { issuer: high, currency, value: '0' },
        LowLimit: { issuer: low, currency, value: '0' },
      },
      PreviousFields: { Balance: { currency, issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: before } },
    },
  };
}

const iou = (currency: string, issuer: string, value: string): Json => ({ currency, issuer, value });

/** The row of an account for a node, or undefined. */
function rowOf(rows: ParsedBalanceChange[], account: string, nodeIndex?: number): ParsedBalanceChange | undefined {
  return rows.find((r) => r.account === account && (nodeIndex === undefined || r.node_index === nodeIndex));
}

// -- fixtures ---------------------------------------------------------------------------------------------------------

function ledgersOf(...parts: string[]): RawLedger[] {
  return FixtureLedgerSource.fromDir(join(FIXTURES, ...parts)).list();
}

/** Every transaction of the ledgers as a parser input. */
function txsOf(ledgers: RawLedger[]): ParserTx[] {
  return ledgers.flatMap((ledger) => ledger.transactions.map((raw) => toParserTx(raw, ledger.header, null)));
}

/** The transaction types the recorder found in a network's recorded ledgers. */
function recordedTypes(network: string): string[] {
  const manifest = JSON.parse(readFileSync(join(FIXTURES, network, 'recorded', 'manifest.json'), 'utf8')) as {
    found: Record<string, unknown>;
  };
  return Object.keys(manifest.found);
}

const byPosition = (a: { ledger_index: number; tx_index: number; row: ParsedBalanceChange }, b: typeof a) =>
  a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || a.row.node_index - b.row.node_index;

/** What the parser says about every transaction, flattened to rows with their position. */
function allRows(txs: ParserTx[], ctx: ParseContext) {
  return txs.flatMap((t) =>
    parser
      .parse(t, ctx)
      .map((row) => ({ ledger_index: t.ledger_index, tx_index: t.tx_index, close_time: t.close_time, tx: t, row })),
  );
}

// -- the reference, transcribed ---------------------------------------------------------------------------------------

/**
 * `lib/ledgerParser/balanceChanges.js` of the Ripple Data API, transcribed as faithfully as possible (it numbers the
 * nodes by writing into them, so it gets a copy). Used as an oracle: the parser must agree with it on everything the
 * reference could express. XRP only.
 */
function reference(tx: ParserTx): Json[] {
  const t: Json = { ...structuredClone(tx.tx), metaData: structuredClone(tx.meta) };
  const list: Json[] = [];
  const escrows: Json = {};
  const paychan: Json = {};
  const ADJUST = 1000000.0;

  function findType(data: Json): string | null {
    if (t.TransactionType === 'OfferCreate' && Number(data.final_balance) < 0) return 'intermediary';
    else if (t.TransactionType === 'OfferCreate') return 'exchange';
    else if (t.TransactionType === 'Payment') {
      if (t.Account === t.Destination && Number(data.final_balance) < 0) return 'intermediary';
      else if (t.Account === t.Destination) return 'exchange';
      else if (data.account === t.Destination && t.Amount.currency && t.Amount.currency === data.currency)
        return 'payment_destination';
      else if (data.account === t.Destination && !t.Amount.currency && data.currency === 'XRP')
        return 'payment_destination';
      else if (data.account === t.Account && t.SendMax && t.SendMax.currency && t.SendMax.currency === data.currency)
        return 'payment_source';
      else if (data.account === t.Account && t.SendMax && data.currency === 'XRP') return 'payment_source';
      else if (data.account === t.Account && t.Amount.currency && t.Amount.currency === data.currency)
        return 'payment_source';
      else if (data.account === t.Account && !t.Amount.currency && data.currency === 'XRP') return 'payment_source';
      else if (Number(data.final_balance) < 0) return 'intermediary';
      else return 'exchange';
    }
    return null;
  }

  function parseAccountRoot(node: Json) {
    let account, balance, previous;
    if (node.FinalFields && node.PreviousFields && node.FinalFields.Balance && node.PreviousFields.Balance) {
      balance = new BigNumber(node.FinalFields.Balance);
      previous = new BigNumber(node.PreviousFields.Balance);
      account = node.FinalFields.Account;
    } else if (node.NewFields) {
      balance = new BigNumber(node.NewFields.Balance);
      previous = new BigNumber(0);
      account = node.NewFields.Account;
    } else return;

    const change = balance.minus(previous);
    let amount;
    if (t.Account === account) {
      const fee = new BigNumber(t.Fee).negated();
      amount = change.minus(fee);
      list.push({
        account,
        currency: 'XRP',
        change: fee.dividedBy(ADJUST).toString(),
        final_balance: balance.minus(amount).dividedBy(ADJUST).toString(),
        node_index: -1,
        type: 'fee',
      });
    } else amount = change;

    if (!amount.isZero()) {
      const data: Json = {
        account,
        currency: 'XRP',
        change: amount.dividedBy(ADJUST).toString(),
        final_balance: balance.dividedBy(ADJUST).toString(),
        node_index: node.nodeIndex,
      };
      data.type = findType(data);
      list.push(data);
    }
  }

  function parseRippleState(node: Json) {
    let balance, previous, change, currency, highParty, lowParty;
    if (t.TransactionType !== 'Payment' && t.TransactionType !== 'OfferCreate') return;
    else if (node.NewFields && node.NewFields.Balance.value === '0') return;
    else if (node.NewFields) {
      currency = node.NewFields.Balance.currency;
      highParty = node.NewFields.HighLimit.issuer;
      lowParty = node.NewFields.LowLimit.issuer;
      balance = new BigNumber(node.NewFields.Balance.value);
      change = new BigNumber(node.NewFields.Balance.value);
    } else if (node.PreviousFields && node.PreviousFields.Balance) {
      currency = node.FinalFields.Balance.currency;
      highParty = node.FinalFields.HighLimit.issuer;
      lowParty = node.FinalFields.LowLimit.issuer;
      previous = new BigNumber(node.PreviousFields.Balance.value);
      balance = new BigNumber(node.FinalFields.Balance.value);
      change = balance.minus(previous);
    } else return;

    let data: Json = {
      account: lowParty,
      counterparty: highParty,
      currency,
      change: change.toString(),
      final_balance: balance.toString(),
      node_index: node.nodeIndex,
    };
    data.type = findType(data);
    list.push(data);
    data = {
      account: highParty,
      counterparty: lowParty,
      currency,
      change: change.negated().toString(),
      final_balance: balance.negated().toString(),
      node_index: node.nodeIndex,
    };
    data.type = findType(data);
    list.push(data);
  }

  if (t.metaData.TransactionResult.indexOf('tec') !== 0 && t.metaData.TransactionResult !== 'tesSUCCESS') return list;

  t.metaData.AffectedNodes.forEach((affNode: Json, i: number) => {
    const node = affNode.ModifiedNode || affNode.CreatedNode || affNode.DeletedNode;
    if (!node) return;
    node.nodeIndex = i;
    if (node.LedgerEntryType === 'AccountRoot') parseAccountRoot(node);
    else if (node.LedgerEntryType === 'RippleState') parseRippleState(node);
    if (node.LedgerEntryType === 'Escrow') {
      const fields = node.NewFields || node.FinalFields;
      escrows[fields.Account] = fields;
      escrows[fields.Destination] = fields;
    }
    if (node.LedgerEntryType === 'PayChannel') {
      const fields = node.NewFields || node.FinalFields;
      paychan[fields.Account] = fields;
      paychan[fields.Destination] = fields;
    }
  });

  list.forEach((d) => {
    if (escrows[d.account] && d.type === null) {
      const e = escrows[d.account];
      const amount = new BigNumber(e.Amount).dividedBy(ADJUST);
      d.escrow_counterparty = e.Destination;
      if (t.TransactionType === 'EscrowCreate') {
        d.type = 'escrow_create';
        d.escrow_balance_change = amount.toString();
      } else if (t.TransactionType === 'EscrowCancel') {
        d.type = 'escrow_cancel';
        d.escrow_balance_change = new BigNumber(0).minus(amount).toString();
      } else if (t.TransactionType === 'EscrowFinish') {
        d.type = 'escrow_finish';
        d.escrow_balance_change = new BigNumber(0).minus(amount).toString();
      }
    }
    if (paychan[d.account] && d.type === null) {
      const e = paychan[d.account];
      if (d.account === e.Account) {
        d.type = 'paychannel_fund';
        d.paychannel_counterparty = e.Destination;
        d.paychannel_fund_change = new BigNumber(0).minus(d.change).toString();
        d.paychannel_fund_final_balance = new BigNumber(e.Amount || 0).dividedBy(ADJUST).toString();
        d.paychannel_final_balance = new BigNumber(e.Balance || 0).dividedBy(ADJUST).toString();
      } else {
        d.type = 'paychannel_payout';
        d.paychannel_counterparty = e.Account;
        d.paychannel_balance_change = new BigNumber(0).minus(d.change).toString();
        d.paychannel_fund_final_balance = new BigNumber(e.Amount || 0).dividedBy(ADJUST).toString();
        d.paychannel_final_balance = new BigNumber(e.Balance || 0).dividedBy(ADJUST).toString();
      }
    }
  });
  return list;
}

/** A reference row in the shape of the parser's output. */
function asParsed(d: Json): Json {
  const row: Json = {
    account: d.account,
    counterparty: d.counterparty ?? '',
    currency: d.currency,
    amount_change: d.change,
    final_balance: d.final_balance,
    node_index: d.node_index,
    change_type: d.type === 'fee' ? 'transaction_cost' : (d.type ?? ''),
  };
  for (const key of [
    'escrow_counterparty',
    'escrow_balance_change',
    'paychannel_counterparty',
    'paychannel_fund_change',
    'paychannel_fund_final_balance',
    'paychannel_final_balance',
    'paychannel_balance_change',
  ]) {
    if (d[key] !== undefined) row[key] = d[key];
  }
  return row;
}

// -- the tests --------------------------------------------------------------------------------------------------------

describe('BalanceChangesParser', () => {
  describe('native balance changes', () => {
    const payment = {
      TransactionType: 'Payment',
      Account: 'rSender',
      Destination: 'rDest',
      Amount: '1000000',
    };
    const nodes = [root('rSender', '100000000', '98999988'), root('rDest', '5000000', '6000000')];

    it('returns the fee row and the payment legs of a simple native payment', () => {
      expect(parser.parse(parserTx(payment, nodes), XRPL)).toStrictEqual([
        {
          account: 'rSender',
          counterparty: '',
          currency: 'XRP',
          amount_change: '-0.000012',
          // The balance after the fee and before the 1 XRP that was sent.
          final_balance: '99.999988',
          node_index: -1,
          change_type: 'transaction_cost',
        },
        {
          account: 'rSender',
          counterparty: '',
          currency: 'XRP',
          amount_change: '-1',
          final_balance: '98.999988',
          node_index: 0,
          change_type: 'payment_source',
        },
        {
          account: 'rDest',
          counterparty: '',
          currency: 'XRP',
          amount_change: '1',
          final_balance: '6',
          node_index: 1,
          change_type: 'payment_destination',
        },
      ]);
    });

    it('names the native currency after the network', () => {
      const rows = parser.parse(parserTx(payment, nodes), XAHAU);

      expect(rows.map((r) => r.currency)).toEqual(['XAH', 'XAH', 'XAH']);
      expect(rows.every((r) => r.counterparty === '')).toBe(true);
      expect(rows.map((r) => r.amount_change)).toEqual(['-0.000012', '-1', '1']);
    });

    it('keeps amounts exact: one drop, and balances beyond 2^53 drops', () => {
      const rows = parser.parse(
        parserTx({ ...payment, Fee: '1', Amount: '1' }, [
          root('rSender', '9007199254740993', '9007199254740991'),
          root('rDest', '1', '2'),
        ]),
        XRPL,
      );

      expect(rows.map((r) => [r.node_index, r.amount_change, r.final_balance])).toEqual([
        [-1, '-0.000001', '9007199254.740992'],
        [0, '-0.000001', '9007199254.740991'],
        [1, '0.000001', '0.000002'],
      ]);
    });

    it('emits no second row for an account that only paid the fee', () => {
      const rows = parser.parse(
        parserTx({ TransactionType: 'AccountSet', Account: 'rSender' }, [root('rSender', '100000000', '99999988')]),
        XRPL,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ node_index: -1, change_type: 'transaction_cost', amount_change: '-0.000012' });
    });

    it('records a created account as a change from nothing', () => {
      const rows = parser.parse(
        parserTx({ ...payment, Destination: 'rNew', Amount: '20000000' }, [
          root('rSender', '100000000', '79999988'),
          { CreatedNode: { LedgerEntryType: 'AccountRoot', NewFields: { Account: 'rNew', Balance: '20000000' } } },
        ]),
        XRPL,
      );

      expect(rowOf(rows, 'rNew')).toStrictEqual({
        account: 'rNew',
        counterparty: '',
        currency: 'XRP',
        amount_change: '20',
        final_balance: '20',
        node_index: 1,
        change_type: 'payment_destination',
      });
    });

    it('records a deleted account: the fee, then the rest leaving it (AccountDelete)', () => {
      const rows = parser.parse(
        parserTx({ TransactionType: 'AccountDelete', Account: 'rGone', Destination: 'rHeir', Fee: '200000' }, [
          {
            DeletedNode: {
              LedgerEntryType: 'AccountRoot',
              FinalFields: { Account: 'rGone', Balance: '0' },
              PreviousFields: { Balance: '1328260' },
            },
          },
          root('rHeir', '3717480', '4845740'),
        ]),
        XRPL,
      );

      expect(rows.map((r) => [r.account, r.node_index, r.amount_change, r.final_balance, r.change_type])).toEqual([
        ['rGone', -1, '-0.2', '1.12826', 'transaction_cost'],
        ['rGone', 0, '-1.12826', '0', ''],
        ['rHeir', 1, '1.12826', '4.84574', ''],
      ]);
    });

    it('does not record a fee of 0 and still records the rest (Batch inner transactions pay nothing)', () => {
      const rows = parser.parse(
        parserTx({ TransactionType: 'Payment', Account: 'rSender', Destination: 'rSender', Amount: '5', Fee: '0' }, [
          root('rSender', '100', '105'),
        ]),
        XRPL,
      );

      expect(rows).toStrictEqual([
        {
          account: 'rSender',
          counterparty: '',
          currency: 'XRP',
          amount_change: '0.000005',
          final_balance: '0.000105',
          node_index: 0,
          change_type: 'exchange',
        },
      ]);
    });

    it('treats a missing Fee as 0, and a created account without a Balance as no change (AMM pseudo-account)', () => {
      const rows = parser.parse(
        parserTx({ TransactionType: 'AMMCreate', Account: 'rCreator', Fee: undefined }, [
          root('rCreator', '100000000', '90000000'),
          {
            CreatedNode: {
              LedgerEntryType: 'AccountRoot',
              NewFields: { Account: 'rAmm', AMMID: 'ABCD', Flags: 26214400, Sequence: 100 },
            },
          },
        ]),
        XRPL,
      );

      expect(rows.map((r) => [r.account, r.amount_change])).toEqual([['rCreator', '-10']]);
    });

    it('records the XRP an AMM pseudo-account is created with', () => {
      const rows = parser.parse(
        parserTx({ TransactionType: 'AMMCreate', Account: 'rCreator', Fee: '200000' }, [
          root('rCreator', '100000000', '89800000'),
          {
            CreatedNode: {
              LedgerEntryType: 'AccountRoot',
              NewFields: { Account: 'rAmm', AMMID: 'ABCD', Balance: '10000000', Flags: 26214400 },
            },
          },
        ]),
        XRPL,
      );

      expect(rowOf(rows, 'rAmm')).toMatchObject({ amount_change: '10', final_balance: '10', change_type: '' });
      const sum = rows.reduce((total, r) => total.plus(r.amount_change), new BigNumber(0));
      expect(sum.toString()).toBe('-0.2');
    });
  });

  describe('trustline balance changes', () => {
    it('classifies a RippleState source leg as payment_source via comparison (regression: the old code used assignment)', () => {
      const rows = parser.parse(
        parserTx(
          { TransactionType: 'Payment', Account: 'rSender', Destination: 'rDest', Amount: iou('USD', 'rGate', '10') },
          [line('rGate', 'rSender', 'USD', '15', '5')],
        ),
        XRPL,
      );

      // The high party is the sender: that leg is payment_source, and the low party keeps its own account.
      expect(rows).toStrictEqual([
        {
          account: 'rGate',
          counterparty: 'rSender',
          currency: 'USD',
          amount_change: '-10',
          final_balance: '5',
          node_index: 0,
          change_type: 'exchange',
        },
        {
          account: 'rSender',
          counterparty: 'rGate',
          currency: 'USD',
          amount_change: '10',
          final_balance: '-5',
          node_index: 0,
          change_type: 'payment_source',
        },
      ]);
    });

    it('RippleState changes are emitted for non-Payment types', () => {
      const rows = parser.parse(
        parserTx(
          { TransactionType: 'CheckCash', Account: 'rCasher', CheckID: 'ABCD', Amount: iou('USD', 'rGate', '7.5') },
          [root('rCasher', '50000000', '49999988'), line('rCasher', 'rGate', 'USD', '1', '8.5')],
        ),
        XRPL,
      );

      expect(
        rows.map((r) => [
          r.account,
          r.counterparty,
          r.currency,
          r.amount_change,
          r.final_balance,
          r.node_index,
          r.change_type,
        ]),
      ).toEqual([
        ['rCasher', '', 'XRP', '-0.000012', '49.999988', -1, 'transaction_cost'],
        ['rCasher', 'rGate', 'USD', '7.5', '8.5', 1, ''],
        ['rGate', 'rCasher', 'USD', '-7.5', '-8.5', 1, ''],
      ]);
    });

    it('emits a trustline created with a balance, and skips one created empty', () => {
      const created = (value: string): Json => ({
        CreatedNode: {
          LedgerEntryType: 'RippleState',
          NewFields: {
            Balance: { currency: 'EUR', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value },
            HighLimit: { issuer: 'rHigh', currency: 'EUR', value: '0' },
            LowLimit: { issuer: 'rLow', currency: 'EUR', value: '100' },
          },
        },
      });
      const tx = { TransactionType: 'OfferCreate', Account: 'rLow' };

      expect(parser.parse(parserTx(tx, [created('0')]), XRPL)).toEqual([]);
      expect(
        parser.parse(parserTx(tx, [created('2.5')]), XRPL).map((r) => [r.account, r.amount_change, r.final_balance]),
      ).toEqual([
        ['rLow', '2.5', '2.5'],
        ['rHigh', '-2.5', '-2.5'],
      ]);
    });

    it('ignores a trustline whose balance did not change, and any other ledger entry', () => {
      const limitOnly: Json = {
        ModifiedNode: {
          LedgerEntryType: 'RippleState',
          FinalFields: {
            Balance: { currency: 'USD', value: '3' },
            HighLimit: { issuer: 'rHigh', currency: 'USD', value: '9' },
            LowLimit: { issuer: 'rLow', currency: 'USD', value: '0' },
          },
          PreviousFields: { HighLimit: { issuer: 'rHigh', currency: 'USD', value: '0' } },
        },
      };
      const other: Json = { ModifiedNode: { LedgerEntryType: 'DirectoryNode', FinalFields: {}, PreviousFields: {} } };

      expect(
        parser.parse(parserTx({ TransactionType: 'TrustSet', Account: 'rHigh' }, [limitOnly, other]), XRPL),
      ).toEqual([]);
    });

    it('a trustline settled to zero shows 0 on both sides, never -0', () => {
      const rows = parser.parse(
        parserTx({ TransactionType: 'OfferCreate', Account: 'rLow' }, [
          line('rLow', 'rHigh', 'USD', '5', '0', 'DeletedNode'),
        ]),
        XRPL,
      );

      expect(rows.map((r) => [r.account, r.amount_change, r.final_balance])).toEqual([
        ['rLow', '-5', '0'],
        ['rHigh', '5', '0'],
      ]);
    });

    it('keeps tiny trustline amounts exact', () => {
      const rows = parser.parse(
        parserTx({ TransactionType: 'OfferCreate', Account: 'rLow' }, [
          line('rLow', 'rHigh', 'USD', '0.1', '0.1000000000000001'),
        ]),
        XRPL,
      );

      expect(rows[0].amount_change).toBe('1e-16');
      expect(rows[0].final_balance).toBe('0.1000000000000001');
      expect(rows[1].amount_change).toBe('-1e-16');
    });
  });

  describe('change_type', () => {
    /** The type of the row of `account` for a single change on it, or on a trustline of `currency`. */
    function typeFor(
      tx: Json,
      account: string,
      node: 'native' | 'line',
      balance: [string, string] = ['10', '11'],
    ): string {
      const [before, after] = balance;
      // The trustline sits between a gateway (low) and `account` (high), so the account's own balance is negated.
      const nodes =
        node === 'native'
          ? [root(account, `${before}000000`, `${after}000000`)]
          : [line('rGateway', account, tx.lineCurrency ?? 'USD', before, after)];
      const { lineCurrency, ...rest } = tx;
      const rows = parser.parse(parserTx({ Fee: '0', ...rest }, nodes), XRPL);
      const row = rows.find((r) => r.account === account);
      if (!row) throw new Error(`no row for ${account}`);
      return row.change_type;
    }

    const payment = { TransactionType: 'Payment', Account: 'rSrc', Destination: 'rDst', Amount: '1000000' };
    const usdPayment = { ...payment, Amount: iou('USD', 'rGateway', '1') };

    it.each([
      [
        'OfferCreate native',
        { TransactionType: 'OfferCreate', Account: 'rSrc' },
        'rX',
        'native',
        ['10', '11'],
        'exchange',
      ],
      [
        'OfferCreate line, negative final balance',
        { TransactionType: 'OfferCreate', Account: 'rSrc' },
        'rX',
        'line',
        ['2', '3'],
        'intermediary',
      ],
      ['Payment to self, positive', { ...payment, Destination: 'rSrc' }, 'rSrc', 'native', ['10', '11'], 'exchange'],
      ['Payment to self, negative', { ...payment, Destination: 'rSrc' }, 'rSrc', 'line', ['2', '3'], 'intermediary'],
      ['Payment destination, native amount', payment, 'rDst', 'native', ['10', '11'], 'payment_destination'],
      ['Payment destination, issued amount', usdPayment, 'rDst', 'line', ['2', '3'], 'payment_destination'],
      ['Payment source, native amount', payment, 'rSrc', 'native', ['11', '10'], 'payment_source'],
      ['Payment source, issued amount', usdPayment, 'rSrc', 'line', ['3', '2'], 'payment_source'],
      [
        'Payment source, SendMax currency',
        { ...usdPayment, SendMax: iou('EUR', 'rGateway', '1'), lineCurrency: 'EUR' },
        'rSrc',
        'line',
        ['3', '2'],
        'payment_source',
      ],
      [
        'Payment source, native balance while SendMax is issued',
        { ...usdPayment, SendMax: iou('EUR', 'rGateway', '1') },
        'rSrc',
        'native',
        ['11', '10'],
        'payment_source',
      ],
      [
        'Payment source, issued amount other than SendMax',
        { ...usdPayment, SendMax: iou('EUR', 'rGateway', '1') },
        'rSrc',
        'line',
        ['3', '2'],
        'payment_source',
      ],
      ['Payment bystander, positive balance', payment, 'rMid', 'native', ['10', '11'], 'exchange'],
      ['Payment bystander, negative balance', usdPayment, 'rMid', 'line', ['2', '3'], 'intermediary'],
      ['Payment destination with another currency, positive', usdPayment, 'rDst', 'native', ['10', '11'], 'exchange'],
      ['CheckCash', { TransactionType: 'CheckCash', Account: 'rSrc' }, 'rSrc', 'native', ['10', '11'], ''],
      ['AMMDeposit line', { TransactionType: 'AMMDeposit', Account: 'rSrc' }, 'rSrc', 'line', ['3', '2'], ''],
      ['ClaimReward', { TransactionType: 'ClaimReward', Account: 'rSrc' }, 'rSrc', 'native', ['10', '11'], ''],
      ['GenesisMint', { TransactionType: 'GenesisMint', Account: 'rGenesis' }, 'rMinted', 'native', ['10', '11'], ''],
      [
        'EscrowFinish without an escrow node',
        { TransactionType: 'EscrowFinish', Account: 'rSrc' },
        'rSrc',
        'native',
        ['10', '11'],
        '',
      ],
    ] as const)('%s', (_name, tx, account, node, balance, expected) => {
      expect(typeFor(tx as Json, account, node, [...balance] as [string, string])).toBe(expected);
    });

    it('a native balance of a Payment whose Amount is an issued currency named like the native one is not a destination', () => {
      // On Xahau an issued currency may be called XAH; only the AccountRoot row is native.
      const tx = { ...payment, Amount: iou('XAH', 'rIssuer', '1') };
      const rows = parser.parse(parserTx(tx, [root('rDst', '10000000', '11000000')]), XAHAU);

      expect(rows).toHaveLength(1);
      expect(rows[0].currency).toBe('XAH');
      expect(rows[0].change_type).toBe('exchange');
    });

    it('a trustline in a currency called like the native one is not native', () => {
      const tx = { ...payment, Amount: '1000000' };
      const rows = parser.parse(parserTx(tx, [line('rGateway', 'rDst', 'XAH', '-2', '-3')]), XRPL);

      expect(rows.find((r) => r.account === 'rDst')).toMatchObject({ currency: 'XAH', change_type: 'exchange' });
    });
  });

  describe('results', () => {
    const tx = { TransactionType: 'Payment', Account: 'rSender', Destination: 'rDest', Amount: '1000000' };
    const nodes = [root('rSender', '100000000', '99999988')];

    it.each(['tecPATH_DRY', 'tecUNFUNDED_OFFER', 'tecNO_DST_INSUF_XRP'])('%s is parsed: the fee was paid', (result) => {
      const rows = parser.parse(parserTx(tx, nodes, { TransactionResult: result }), XRPL);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ change_type: 'transaction_cost', amount_change: '-0.000012' });
    });

    it.each(['tefPAST_SEQ', 'terQUEUED', 'telINSUF_FEE_P', 'temBAD_FEE', 'tesSUCCES', 'nonsense'])(
      '%s is not parsed',
      (result) => {
        expect(parser.parse(parserTx(tx, nodes, { TransactionResult: result }), XRPL)).toEqual([]);
      },
    );

    it('returns nothing for a transaction without a result, or without nodes', () => {
      expect(parser.parse(parserTx(tx, nodes, { TransactionResult: undefined }), XRPL)).toEqual([]);
      expect(parser.parse(parserTx(tx, undefined as unknown as Json[]), XRPL)).toEqual([]);
      expect(parser.parse(parserTx(tx, []), XRPL)).toEqual([]);
    });
  });

  describe('escrows', () => {
    it('escrow_create sets escrow_balance_change: EscrowCreate A8272533… in ledger 29136413', () => {
      const ledger = ledgersOf('xrpl', 'ripple-mock').find((l) => l.header.ledger_index === 29136413)!;
      const create = txsOf([ledger]).find(
        (t) => t.hash === 'A827253314026A3D27A7AD8047C6A29D092BC161AF11E5B752EFD2C0E79FF2F1',
      )!;

      expect(parser.parse(create, XRPL)).toStrictEqual([
        {
          account: 'rGhDCgik9CwiNpcNnYHkEHcMgw2dkLgtNB',
          counterparty: '',
          currency: 'XRP',
          amount_change: '-0.000012',
          final_balance: '267161.132744',
          node_index: -1,
          change_type: 'transaction_cost',
        },
        {
          account: 'rGhDCgik9CwiNpcNnYHkEHcMgw2dkLgtNB',
          counterparty: '',
          currency: 'XRP',
          amount_change: '-100',
          final_balance: '267061.132744',
          node_index: 0,
          change_type: 'escrow_create',
          escrow_counterparty: 'rGhDCgik9CwiNpcNnYHkEHcMgw2dkLgtNB',
          escrow_balance_change: '100',
        },
      ]);
    });

    const escrow = { Account: 'rOwner', Destination: 'rDest', Amount: '100000000' };

    it('escrow_finish: the destination is paid and the escrow loses its amount', () => {
      const rows = parser.parse(
        parserTx({ TransactionType: 'EscrowFinish', Account: 'rFinisher', Owner: 'rOwner', OfferSequence: 5 }, [
          root('rFinisher', '50000000', '49999988'),
          root('rDest', '7000000', '107000000'),
          { DeletedNode: { LedgerEntryType: 'Escrow', FinalFields: escrow } },
        ]),
        XRPL,
      );

      expect(rowOf(rows, 'rFinisher')).toMatchObject({ node_index: -1, change_type: 'transaction_cost' });
      expect(rowOf(rows, 'rDest')).toStrictEqual({
        account: 'rDest',
        counterparty: '',
        currency: 'XRP',
        amount_change: '100',
        final_balance: '107',
        node_index: 1,
        change_type: 'escrow_finish',
        escrow_counterparty: 'rDest',
        escrow_balance_change: '-100',
      });
    });

    it('escrow_cancel: the owner gets the funds back', () => {
      const rows = parser.parse(
        parserTx({ TransactionType: 'EscrowCancel', Account: 'rOwner', Owner: 'rOwner', OfferSequence: 5 }, [
          root('rOwner', '50000000', '149999988'),
          { DeletedNode: { LedgerEntryType: 'Escrow', FinalFields: escrow } },
        ]),
        XRPL,
      );

      expect(rows.map((r) => [r.node_index, r.amount_change, r.change_type, r.escrow_balance_change])).toEqual([
        [-1, '-0.000012', 'transaction_cost', undefined],
        [0, '100', 'escrow_cancel', '-100'],
      ]);
      expect(rows[1].escrow_counterparty).toBe('rDest');
    });

    it('an escrow of an issued currency reports its value, not drops', () => {
      const amount = iou('USD', 'rGate', '25.5');
      const rows = parser.parse(
        parserTx({ TransactionType: 'EscrowCreate', Account: 'rOwner', Destination: 'rDest', Amount: amount }, [
          root('rOwner', '50000000', '49999988'),
          line('rGate', 'rOwner', 'USD', '-30', '-4.5'),
          {
            CreatedNode: {
              LedgerEntryType: 'Escrow',
              NewFields: { Account: 'rOwner', Destination: 'rDest', Amount: amount },
            },
          },
        ]),
        XRPL,
      );

      expect(rowOf(rows, 'rOwner', 1)).toMatchObject({
        currency: 'USD',
        counterparty: 'rGate',
        change_type: 'escrow_create',
        escrow_counterparty: 'rDest',
        escrow_balance_change: '25.5',
      });
      // The gateway is not a party to the escrow.
      expect(rowOf(rows, 'rGate', 1)?.change_type).toBe('');
    });

    it('an escrow type is not replaced by a payment channel type', () => {
      const rows = parser.parse(
        parserTx({ TransactionType: 'EscrowCreate', Account: 'rOwner', Destination: 'rDest', Amount: '100000000' }, [
          root('rOwner', '500000000', '399999988'),
          {
            CreatedNode: {
              LedgerEntryType: 'Escrow',
              NewFields: { Account: 'rOwner', Destination: 'rDest', Amount: '100000000' },
            },
          },
          {
            ModifiedNode: {
              LedgerEntryType: 'PayChannel',
              FinalFields: { Account: 'rOwner', Destination: 'rDest', Amount: '1' },
            },
          },
        ]),
        XRPL,
      );

      expect(rowOf(rows, 'rOwner', 0)).toMatchObject({ change_type: 'escrow_create', escrow_balance_change: '100' });
      expect(rowOf(rows, 'rOwner', 0)?.paychannel_counterparty).toBeUndefined();
    });

    it('leaves the fee row alone and does not type a row of a Payment', () => {
      const rows = parser.parse(
        parserTx({ TransactionType: 'Payment', Account: 'rOwner', Destination: 'rDest', Amount: '5000000' }, [
          root('rOwner', '50000000', '44999988'),
          root('rDest', '7000000', '12000000'),
          { ModifiedNode: { LedgerEntryType: 'Escrow', FinalFields: escrow } },
        ]),
        XRPL,
      );

      expect(rows.map((r) => r.change_type)).toEqual(['transaction_cost', 'payment_source', 'payment_destination']);
      expect(rows.every((r) => r.escrow_counterparty === undefined)).toBe(true);
    });
  });

  describe('payment channels', () => {
    it('paychannel_payout: PaymentChannelClaim 358D8E70… in ledger 29709909 pays the destination', () => {
      const ledger = ledgersOf('xrpl', 'ripple-mock').find((l) => l.header.ledger_index === 29709909)!;
      const claim = txsOf([ledger]).find(
        (t) => t.hash === '358D8E70A26CA436B62A4807B785772C1F32886058C12BB362E130AF2C41EC09',
      )!;

      expect(parser.parse(claim, XRPL)).toStrictEqual([
        {
          account: 'rnNzy3iPc7gPEAJbAdXwxY1UTBamBqTYhR',
          counterparty: '',
          currency: 'XRP',
          amount_change: '-0.000012',
          final_balance: '13754.898908',
          node_index: -1,
          change_type: 'transaction_cost',
        },
        {
          account: 'rnNzy3iPc7gPEAJbAdXwxY1UTBamBqTYhR',
          counterparty: '',
          currency: 'XRP',
          amount_change: '0.223509',
          final_balance: '13755.122417',
          node_index: 1,
          change_type: 'paychannel_payout',
          paychannel_counterparty: 'rMwWvk2A87HeaDQ4yPNqptk1NdgHBAZV9d',
          paychannel_balance_change: '-0.223509',
          paychannel_fund_final_balance: '30',
          paychannel_final_balance: '8.806247',
        },
      ]);
    });

    const channel = { Account: 'rSrc', Destination: 'rDst', Amount: '30000000', Balance: '5000000' };

    it('paychannel_fund: the funder pays into the channel', () => {
      const rows = parser.parse(
        parserTx({ TransactionType: 'PaymentChannelFund', Account: 'rSrc', Channel: 'AB', Amount: '10000000' }, [
          {
            ModifiedNode: {
              LedgerEntryType: 'PayChannel',
              FinalFields: channel,
              PreviousFields: { Amount: '20000000' },
            },
          },
          root('rSrc', '100000000', '89999988'),
        ]),
        XRPL,
      );

      expect(rowOf(rows, 'rSrc', 1)).toStrictEqual({
        account: 'rSrc',
        counterparty: '',
        currency: 'XRP',
        amount_change: '-10',
        final_balance: '89.999988',
        node_index: 1,
        change_type: 'paychannel_fund',
        paychannel_counterparty: 'rDst',
        paychannel_fund_change: '10',
        paychannel_fund_final_balance: '30',
        paychannel_final_balance: '5',
      });
    });

    it('a channel without a Balance has balance 0 (PaymentChannelCreate)', () => {
      const rows = parser.parse(
        parserTx(
          { TransactionType: 'PaymentChannelCreate', Account: 'rSrc', Destination: 'rDst', Amount: '30000000' },
          [
            root('rSrc', '100000000', '69999988'),
            {
              CreatedNode: {
                LedgerEntryType: 'PayChannel',
                NewFields: { Account: 'rSrc', Destination: 'rDst', Amount: '30000000' },
              },
            },
          ],
        ),
        XRPL,
      );

      expect(rowOf(rows, 'rSrc', 0)).toMatchObject({
        change_type: 'paychannel_fund',
        paychannel_fund_change: '30',
        paychannel_fund_final_balance: '30',
        paychannel_final_balance: '0',
      });
    });
  });

  describe('purity', () => {
    it('does not mutate frozen input', () => {
      const t = parserTx(
        {
          TransactionType: 'Payment',
          Account: 'rSender',
          Destination: 'rDest',
          Amount: iou('USD', 'rGate', '10'),
          SendMax: '5',
        },
        [
          root('rSender', '100000000', '98999988'),
          line('rGate', 'rSender', 'USD', '15', '5'),
          {
            ModifiedNode: {
              LedgerEntryType: 'Escrow',
              FinalFields: { Account: 'rSender', Destination: 'rDest', Amount: '1' },
            },
          },
        ],
      );
      const before = JSON.stringify(t);

      expect(() => parser.parse(t, XRPL)).not.toThrow();
      expect(JSON.stringify(t)).toBe(before);
      // Parsing it twice gives the same answer: nothing is cached on the input.
      expect(parser.parse(t, XRPL)).toEqual(parser.parse(t, XRPL));
    });

    it('does not mutate the frozen fixture ledgers, and its rows hold only strings and numbers', () => {
      const run = (txs: ParserTx[], ctx: ParseContext) => {
        for (const t of txs) {
          const before = JSON.stringify(t.meta);
          const rows = parser.parse(t, ctx);
          expect(JSON.stringify(t.meta)).toBe(before);
          for (const row of rows) for (const value of Object.values(row)) expect(typeof value).not.toBe('object');
        }
      };

      run([...txsOf(ledgersOf('xrpl', 'ripple-mock')), ...txsOf(ledgersOf('xrpl', 'recorded'))], XRPL);
      run(txsOf(ledgersOf('xahau', 'recorded')), XAHAU);
    });
  });

  describe('ripple-mock ledgers', () => {
    const ledgers = ledgersOf('xrpl', 'ripple-mock');
    const txs = txsOf(ledgers);
    const rows = allRows(txs, XRPL);

    it('agrees with the reference on every row it could express', () => {
      expect(txs).toHaveLength(933);

      let compared = 0;
      for (const t of txs) {
        const expected = reference(t).map(asParsed);
        const reducedTypes = t.tx.TransactionType !== 'Payment' && t.tx.TransactionType !== 'OfferCreate';
        // The reference never looked at trustlines of other transaction types; the parser does.
        const actual = parser.parse(t, XRPL).filter((r) => !(reducedTypes && r.counterparty !== ''));

        expect(actual).toStrictEqual(expected);
        compared += expected.length;
      }
      expect(compared).toBeGreaterThan(1500);
    });

    it('emits trustline rows for other types only when a balance moved', () => {
      const others = rows.filter(
        ({ tx, row }) => !['Payment', 'OfferCreate'].includes(tx.tx.TransactionType) && row.counterparty !== '',
      );

      for (const { row } of others) {
        expect(row.change_type).toBe('');
        expect(new BigNumber(row.amount_change).isZero()).toBe(false);
      }
    });

    it('gives each row of a transaction its own key', () => {
      for (const t of txs) {
        const keys = parser.parse(t, XRPL).map((r) => `${r.account}|${r.node_index}|${r.currency}|${r.counterparty}`);
        expect(new Set(keys).size).toBe(keys.length);
      }
    });

    // Ripple's test.account.balanceChanges.js, over the same 54 ledgers.
    describe('Ripple golden: test.account.balanceChanges.js', () => {
      const of = (account: string) => rows.filter(({ row }) => row.account === account).sort(byPosition);

      it('rGhDCgik9CwiNpcNnYHkEHcMgw2dkLgtNB has 2 changes: its fee, then the escrow it created', () => {
        const changes = of('rGhDCgik9CwiNpcNnYHkEHcMgw2dkLgtNB');

        expect(changes).toHaveLength(2);
        expect(changes[0].row.change_type).toBe('transaction_cost');
        expect(changes[1].row.change_type).toBe('escrow_create');
        expect(changes[1].row.escrow_balance_change).toBe('100');
        expect(changes[1].row.escrow_counterparty).toBe('rGhDCgik9CwiNpcNnYHkEHcMgw2dkLgtNB');
      });

      it('rpjZUBy92h6worVCYERZcVCzgzgmHb17Dx: the second change is at ledger 11119603, tx 4, node 1 (the page-2 marker)', () => {
        const changes = of('rpjZUBy92h6worVCYERZcVCzgzgmHb17Dx');

        expect(changes.length).toBeGreaterThan(2);
        expect(changes[1]).toMatchObject({ ledger_index: 11119603, tx_index: 4 });
        expect(changes[1].row.node_index).toBe(1);
        // Marker time 20150114182720.
        expect(new Date(changes[1].close_time * 1000).toISOString()).toBe('2015-01-14T18:27:20.000Z');
      });

      it('rpjZUBy92h6worVCYERZcVCzgzgmHb17Dx has XRP changes between 18:00 and 18:30', () => {
        const from = Date.UTC(2015, 0, 14, 18, 0, 0) / 1000;
        const to = Date.UTC(2015, 0, 14, 18, 30, 0) / 1000;

        const inWindow = of('rpjZUBy92h6worVCYERZcVCzgzgmHb17Dx').filter(
          ({ close_time, row }) => close_time > from && close_time < to && row.currency === 'XRP',
        );

        expect(inWindow.length).toBeGreaterThan(0);
      });

      it('rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg has BTC changes against Bitstamp and XRP transaction costs', () => {
        const changes = of('rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg');
        const btc = changes.filter(
          ({ row }) => row.currency === 'BTC' && row.counterparty === 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B',
        );
        const costs = changes.filter(({ row }) => row.change_type === 'transaction_cost');

        expect(btc.length).toBeGreaterThan(0);
        expect(costs.length).toBeGreaterThan(0);
        for (const { row } of costs) {
          expect(row.currency).toBe('XRP');
          expect(row.node_index).toBe(-1);
        }
      });

      it('rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q has changes', () => {
        expect(of('rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q').length).toBeGreaterThan(0);
      });
    });
  });

  describe('conservation', () => {
    // XRP also moves into objects that are not accounts: escrows, channels.
    const holdsXrp = /^(Escrow|PaymentChannel)/;

    function checkConservation(txs: ParserTx[], ctx: ParseContext, nativeToo: (t: ParserTx) => boolean) {
      let checked = 0;
      for (const t of txs) {
        const rows = parser.parse(t, ctx);
        const issued = new Map<string, BigNumber>();
        let native = new BigNumber(0);
        for (const r of rows) {
          if (r.counterparty === '') native = native.plus(r.amount_change);
          else {
            const [a, b] = [r.account, r.counterparty].sort();
            const key = `${r.currency}|${a}|${b}`;
            issued.set(key, (issued.get(key) ?? new BigNumber(0)).plus(r.amount_change));
          }
        }
        for (const [key, sum] of issued) expect([t.hash, key, sum.toString()]).toEqual([t.hash, key, '0']);
        if (nativeToo(t) && !holdsXrp.test(t.tx.TransactionType)) {
          const fee = new BigNumber(t.tx.Fee ?? '0').dividedBy(1e6);
          expect([t.hash, native.toString()]).toEqual([t.hash, fee.negated().toString()]);
          checked++;
        }
      }
      return checked;
    }

    it('on the XRP Ledger every issued change has its mirror, and the native changes add up to minus the fee', () => {
      const checked =
        checkConservation(txsOf(ledgersOf('xrpl', 'ripple-mock')), XRPL, () => true) +
        checkConservation(txsOf(ledgersOf('xrpl', 'recorded')), XRPL, () => true);

      expect(checked).toBeGreaterThan(2000);
    });

    it('on Xahau every issued change has its mirror, and ordinary transactions burn exactly the fee', () => {
      // Hooks mint (GenesisMint), spend (Cron, Invoke, emitted transactions) and import XAH.
      const ordinary = (t: ParserTx) =>
        ['Payment', 'AccountSet', 'URITokenMint', 'URITokenBurn', 'ClaimReward'].includes(t.tx.TransactionType) &&
        t.tx.EmitDetails === undefined;
      const checked = checkConservation(txsOf(ledgersOf('xahau', 'recorded')), XAHAU, ordinary);

      expect(checked).toBeGreaterThan(0);
    });
  });

  describe('recorded xrpl ledgers', () => {
    const found = recordedTypes('xrpl');
    const txs = txsOf(ledgersOf('xrpl', 'recorded'));

    it('agrees with the reference on every native row and every Payment or OfferCreate row', () => {
      for (const t of txs) {
        const reducedTypes = t.tx.TransactionType !== 'Payment' && t.tx.TransactionType !== 'OfferCreate';
        const actual = parser.parse(t, XRPL).filter((r) => !(reducedTypes && r.counterparty !== ''));
        const expected = reference(t)
          .map(asParsed)
          // The reference has no zero fees (Batch inner transactions pay none) and no AMMs: it writes a NaN change
          // for a pseudo-account without a Balance.
          .filter(
            (r) => r.amount_change !== 'NaN' && !(r.change_type === 'transaction_cost' && r.amount_change === '0'),
          );

        expect(actual).toStrictEqual(expected);
      }
    });

    (found.includes('CheckCash') ? it : it.skip)('CheckCash: the XRP moving between the accounts is untyped', () => {
      const cash = txs.find((t) => t.tx.TransactionType === 'CheckCash' && t.meta.TransactionResult === 'tesSUCCESS')!;
      const rows = parser.parse(cash, XRPL);

      expect(rows.length).toBeGreaterThan(1);
      expect(rows.filter((r) => r.change_type !== 'transaction_cost').map((r) => r.change_type)).toEqual(
        rows.filter((r) => r.change_type !== 'transaction_cost').map(() => ''),
      );
    });

    it.each(['AMMCreate', 'AMMDeposit', 'AMMWithdraw'])('%s: its trustline changes are emitted, untyped', (type) => {
      if (!found.includes(type)) return;
      const trustlines = txs
        .filter((t) => t.tx.TransactionType === type && t.meta.TransactionResult === 'tesSUCCESS')
        .flatMap((t) => parser.parse(t, XRPL).filter((r) => r.counterparty !== ''));

      expect(trustlines.length).toBeGreaterThan(0);
      expect(trustlines.every((r) => r.change_type === '')).toBe(true);
    });

    (found.includes('AMMCreate') ? it : it.skip)('AMMCreate: the creator pays the fee and gets LP tokens', () => {
      const create = txs.find((t) => t.tx.TransactionType === 'AMMCreate')!;
      const rows = parser.parse(create, XRPL);

      expect(rowOf(rows, create.tx.Account, -1)).toMatchObject({
        change_type: 'transaction_cost',
        amount_change: '-0.2',
      });
      // The LP token line, created with a balance, is one of the trustline rows.
      expect(rows.filter((r) => r.counterparty !== '' && /^[0-9A-F]{40}$/.test(r.currency)).length).toBe(2);
    });

    (found.includes('AccountDelete') ? it : it.skip)(
      'AccountDelete: everything that was left goes to the destination',
      () => {
        const del = txs.find((t) => t.tx.TransactionType === 'AccountDelete')!;
        const rows = parser.parse(del, XRPL);

        expect(rows.map((r) => [r.account, r.node_index, r.amount_change, r.final_balance])).toEqual([
          ['r3CgerzsDtZhh3ejvDjZJUKqXqRVWQcnNC', -1, '-0.2', '1.12826'],
          ['r3CgerzsDtZhh3ejvDjZJUKqXqRVWQcnNC', 0, '-1.12826', '0'],
          ['rGCxaHPdFpkwZUxv7rCPCU8uLaavTiBqPq', 1, '1.12826', '4.84574'],
        ]);
      },
    );

    it('records a Batch inner transaction by its effects only', () => {
      const inner = txs.find(
        (t) => t.tx.TransactionType === 'Payment' && t.tx.Fee === '0' && t.meta.TransactionResult === 'tesSUCCESS',
      )!;
      const rows = parser.parse(inner, XRPL);

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((r) => r.change_type === 'transaction_cost')).toBe(false);
    });
  });

  describe('recorded xahau ledgers', () => {
    const found = recordedTypes('xahau');
    const txs = txsOf(ledgersOf('xahau', 'recorded'));

    it('names the native currency XAH on every native row and never XRP', () => {
      const rows = allRows(txs, XAHAU);

      expect(rows.length).toBeGreaterThan(0);
      for (const { row } of rows) {
        expect(row.currency).not.toBe('XRP');
        if (row.counterparty === '') expect(row.currency).toBe('XAH');
      }
    });

    // A ClaimReward is a request: the reward itself is minted by the GenesisMint the reward hook emits for it in the
    // next ledger, so the ClaimReward transaction only ever shows the fee.
    (found.includes('ClaimReward') && found.includes('GenesisMint') ? it : it.skip)(
      'every ClaimReward pays its fee, and the GenesisMint it caused credits its Account with XAH',
      () => {
        const claims = txs.filter((t) => t.tx.TransactionType === 'ClaimReward');
        expect(claims.length).toBeGreaterThan(0);

        for (const claim of claims) {
          const own = parser.parse(claim, XAHAU);
          expect(own).toHaveLength(1);
          expect(own[0]).toMatchObject({ account: claim.tx.Account, currency: 'XAH', change_type: 'transaction_cost' });

          const mint = txs.find(
            (t) => t.tx.TransactionType === 'GenesisMint' && t.tx.EmitDetails?.EmitParentTxnID === claim.hash,
          );
          expect(mint).toBeDefined();
          const rewarded = parser.parse(mint!, XAHAU).filter((r) => r.account === claim.tx.Account);
          expect(rewarded).toHaveLength(1);
          expect(rewarded[0]).toMatchObject({ currency: 'XAH', counterparty: '', change_type: '' });
          expect(new BigNumber(rewarded[0].amount_change).gt(0)).toBe(true);
        }
      },
    );

    (found.includes('GenesisMint') ? it : it.skip)(
      'GenesisMint credits every destination exactly its Amount, untyped',
      () => {
        const mint = txs.find((t) => t.tx.TransactionType === 'GenesisMint')!;
        const rows = parser.parse(mint, XAHAU);
        const minted = (mint.tx.GenesisMints as { GenesisMint: { Amount: string; Destination: string } }[]).map((m) => [
          m.GenesisMint.Destination,
          new BigNumber(m.GenesisMint.Amount).dividedBy(1e6).toString(),
        ]);

        expect(rows.map((r) => [r.account, r.amount_change]).sort()).toEqual(minted.sort());
        expect(rows.every((r) => r.change_type === '' && r.currency === 'XAH')).toBe(true);
      },
    );

    (found.includes('Remit') ? it : it.skip)('Remit moves native and issued amounts, untyped', () => {
      const remit = txs.find((t) => t.tx.TransactionType === 'Remit')!;
      const rows = parser.parse(remit, XAHAU);
      const native = rows.filter((r) => r.counterparty === '');
      const issued = rows.filter((r) => r.counterparty !== '');

      // The sender pays 5063 drops of fee and sends 116634 drops; the receiver gets them.
      expect(
        native.map((r) => [
          r.account,
          r.node_index === -1 ? 'fee' : 'node',
          r.amount_change,
          r.final_balance,
          r.change_type,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ['rDripFkNyrKz7XUEWKCa18aTeGQ9mi7afj', 'fee', '-0.005063', '13460.503246', 'transaction_cost'],
          ['rDripFkNyrKz7XUEWKCa18aTeGQ9mi7afj', 'node', '-0.116634', '13460.386612', ''],
          ['rE8CnkPE7KY3MFurBUSEZdm8aFrehqUsWy', 'node', '0.116634', '81.146444', ''],
        ]),
      );
      expect(native).toHaveLength(3);
      // Three issued currencies, each moved on two trustlines: a row for each side.
      expect(issued.map((r) => r.currency).sort()).toEqual([
        'EVR',
        'EVR',
        'EVR',
        'EVR',
        'RVN',
        'RVN',
        'RVN',
        'RVN',
        'XXX',
        'XXX',
        'XXX',
        'XXX',
      ]);
      expect(issued.every((r) => r.change_type === '')).toBe(true);
    });

    it('agrees with the reference on every native row of the transactions it understands', () => {
      for (const t of txs) {
        const type = t.tx.TransactionType;
        if (type !== 'Payment' && type !== 'AccountSet') continue;
        const expected = reference(t).map((d) =>
          asParsed({ ...d, currency: d.currency === 'XRP' ? 'XAH' : d.currency }),
        );
        const actual = parser.parse(t, XAHAU);

        expect(actual).toStrictEqual(expected);
      }
    });
  });
});
