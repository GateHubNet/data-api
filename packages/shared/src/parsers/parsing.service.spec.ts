import { join } from 'path';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { XrplTx } from './parser.interface';
import { ParsingService } from './parsing.service';

const MOCK_DIR = join(__dirname, '..', '..', 'test', 'fixtures', 'xrpl', 'ripple-mock');

/** The first successful Payment between two accounts in the mock ledgers, in the legacy XrplTx shape. */
function firstPayment(): XrplTx {
  for (const { header, transactions } of FixtureLedgerSource.fromDir(MOCK_DIR).list()) {
    for (const raw of transactions) {
      if (raw.tx.TransactionType === 'Payment' && raw.meta.TransactionResult === 'tesSUCCESS') {
        return structuredClone({
          ...raw.tx,
          hash: raw.hash,
          ledger_index: header.ledger_index,
          date: header.close_time,
          meta: raw.meta,
          client: null,
        }) as unknown as XrplTx;
      }
    }
  }
  throw new Error('no payment in the mock ledgers');
}

describe('ParsingService (legacy XrplTx adapter)', () => {
  const previous = process.env.GH_NETWORK;
  afterEach(() => {
    if (previous === undefined) delete process.env.GH_NETWORK;
    else process.env.GH_NETWORK = previous;
  });

  it('hands the payment parser a ParserTx built from the XrplTx', () => {
    delete process.env.GH_NETWORK;
    const tx = firstPayment();
    const { payment } = new ParsingService().parseTransaction(tx);

    expect(payment).toBeDefined();
    expect(payment!.source).toBe((tx as unknown as { Account: string }).Account);
    expect(payment!.fee_drops).toBe((tx as unknown as { Fee: string }).Fee);
  });

  it('uses the native currency of GH_NETWORK', () => {
    process.env.GH_NETWORK = 'xahau';
    const tx = firstPayment();
    const { payment } = new ParsingService().parseTransaction(tx);

    if (typeof (tx as unknown as { Amount: unknown }).Amount === 'string') expect(payment!.currency).toBe('XAH');
    expect(payment!.source_balance_changes.every((c) => c.currency !== 'XRP')).toBe(true);
  });
});
