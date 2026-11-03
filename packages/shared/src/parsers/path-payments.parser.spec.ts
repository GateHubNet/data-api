import { join } from 'path';
import { delegatedFrom, SYNTHETIC_DELEGATE } from '../../test/synthetic-delegated';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { getNetworkProfile } from '../network';
import { deepFreeze } from '../test-utils/deep-freeze';
import { parseContextFor, toParserTx } from './parser.interface';
import { PathPaymentParser } from './path-payments.parser';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');
const XRPL = parseContextFor(getNetworkProfile('xrpl'));

const parser = new PathPaymentParser();

describe('PathPaymentParser', () => {
  // `synthetic-delegated-payment`, made from the recorded path payment 2DD69A5F… (ledger 107872476): 0.165495 XRP spent
  // for RLUSD through an AMM or order books, with a 15 drop fee. Hand-made, never recorded: no delegated Payment was found
  // on the network. The delegate paid the fee, so the source's balance moved by the spent XRP alone.
  it('takes no fee out of the source of a delegated path payment: it spends what the recorded original spent (synthetic-delegated-payment)', () => {
    const ledger = FixtureLedgerSource.fromDir(join(FIXTURES, 'xrpl', 'path-payments'))
      .list()
      .find((l) => l.header.ledger_index === 107872476)!;
    const original = ledger.transactions.find(
      (t) => t.hash === '2DD69A5FB706C325BEB11EF19B177EFEFE0597823E4474996BB3C35FE38715E3',
    )!;
    const delegated = delegatedFrom(original, 'synthetic-delegated-payment');

    const expected = parser.parse(toParserTx(original, ledger.header, null), XRPL)!;
    const pathPayment = parser.parse(deepFreeze(toParserTx(delegated, ledger.header, null)), XRPL)!;

    expect(original.tx.Fee).toBe('15');
    expect(delegated.tx.Delegate).toBe(SYNTHETIC_DELEGATE);
    expect(expected).toMatchObject({ source_amount: '0.165495', source_currency: 'XRP' });
    expect(pathPayment).toEqual(expected);
  });
});
