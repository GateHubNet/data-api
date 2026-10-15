import { deepFreeze } from '../test-utils/deep-freeze';
import { FromClientParser } from './from-client.parser';
import { ParserTx } from './parser.interface';

type Json = Record<string, any>;

const parser = new FromClientParser();

const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex').toUpperCase();
const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const memo = (type: string, data?: string, format?: string): Json => ({
  Memo: {
    MemoType: type,
    ...(data === undefined ? {} : { MemoData: data }),
    ...(format === undefined ? {} : { MemoFormat: format }),
  },
});

function parserTx(tx: Json): ParserTx {
  return deepFreeze({
    hash: 'HASH',
    ledger_index: 100,
    close_time: 1_700_000_000,
    tx_index: 0,
    client: null,
    tx: { TransactionType: 'Payment', Account: 'rSender', ...tx },
    meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: [] },
  });
}

describe('FromClientParser', () => {
  it('reads the client from a hex-encoded client memo', () => {
    expect(parser.parse(parserTx({ Memos: [memo(hex('client'), hex('GateHub Wallet'))] }))).toBe('GateHub Wallet');
  });

  it('reads the memo type case-insensitively', () => {
    expect(parser.parse(parserTx({ Memos: [memo(hex('Client'), hex('ripple-lib'))] }))).toBe('ripple-lib');
  });

  it('reads a base64-encoded client memo', () => {
    // "client" is also valid base64 when padded; the memo type is read as base64 only if it is not hex.
    expect(parser.parse(parserTx({ Memos: [memo(base64('client'), base64('Some Wallet'))] }))).toBe('Some Wallet');
  });

  it('falls back to the memo format when there is no data', () => {
    expect(parser.parse(parserTx({ Memos: [memo(hex('client'), undefined, hex('by-format'))] }))).toBe('by-format');
  });

  it('takes the first client memo, skipping memos of other types', () => {
    const tx = {
      Memos: [
        memo(hex('description'), hex('not me')),
        memo(hex('client'), hex('first')),
        memo(hex('client'), hex('second')),
      ],
    };

    expect(parser.parse(parserTx(tx))).toBe('first');
  });

  it('cuts the client to 100 characters', () => {
    const long = 'x'.repeat(150);

    expect(parser.parse(parserTx({ Memos: [memo(hex('client'), hex(long))] }))).toBe('x'.repeat(100));
  });

  it('returns null without memos, without a client memo, or for an empty or unreadable one', () => {
    expect(parser.parse(parserTx({}))).toBeNull();
    expect(parser.parse(parserTx({ Memos: [] }))).toBeNull();
    expect(parser.parse(parserTx({ Memos: [memo(hex('description'), hex('x'))] }))).toBeNull();
    expect(parser.parse(parserTx({ Memos: [memo(hex('client'))] }))).toBeNull();
    expect(parser.parse(parserTx({ Memos: [{ Memo: { MemoData: hex('x') } }] }))).toBeNull();
    expect(parser.parse(parserTx({ Memos: [memo('not hex or base64!', hex('x'))] }))).toBeNull();
    expect(parser.parse(parserTx({ Memos: [memo(hex('client'), 'not hex or base64!')] }))).toBeNull();
  });

  it('does not mutate frozen input', () => {
    const t = parserTx({ Memos: [memo(hex('client'), hex('GateHub Wallet'))] });
    const before = JSON.stringify(t);

    expect(parser.parse(t)).toBe('GateHub Wallet');
    expect(JSON.stringify(t)).toBe(before);
  });
});
