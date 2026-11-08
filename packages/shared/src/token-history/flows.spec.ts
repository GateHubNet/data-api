import BigNumber from 'bignumber.js';
import { generatedAmount, seededRandom } from '../test-utils/token-history-cases';
import { ChangeAmounts, flowsOfTransaction } from './flows';

const known = (before: string, after: string): ChangeAmounts => ({ before, after, beforeKnown: true });

describe('flowsOfTransaction', () => {
  it('a payment from the issuer is issued', () => {
    expect(flowsOfTransaction([known('0', '100')], false)).toEqual({
      issued: '100',
      redeemed: '0',
      clawed_back: '0',
      transferred: '0',
      transfers: 0,
      unknown_before: 0,
    });
  });

  it('a redemption is redeemed', () => {
    expect(flowsOfTransaction([known('250', '50')], false)).toMatchObject({
      issued: '0',
      redeemed: '200',
      clawed_back: '0',
      transferred: '0',
      transfers: 0,
    });
  });

  it('a transfer with a fee transfers the amount and redeems the fee', () => {
    // holder A pays 101, holder B gets 100: the issuer's obligation falls by the fee of 1
    expect(flowsOfTransaction([known('500', '399'), known('0', '100')], false)).toEqual({
      issued: '0',
      redeemed: '1',
      clawed_back: '0',
      transferred: '100',
      transfers: 1,
      unknown_before: 0,
    });
  });

  it('a Clawback and an AMMClawback are clawed back', () => {
    // the clawback flag is the transaction's (Clawback or AMMClawback, both from tx_by_type)
    expect(flowsOfTransaction([known('80', '30')], true)).toMatchObject({
      issued: '0',
      redeemed: '0',
      clawed_back: '50',
      transferred: '0',
      transfers: 0,
    });
    // an AMMClawback takes from the pool, which is a holder like any other
    expect(flowsOfTransaction([known('1000', '400'), known('5', '5')], true)).toMatchObject({ clawed_back: '600' });
  });

  it('an unknown before-state is in no flow', () => {
    expect(
      flowsOfTransaction([{ before: '0', after: '70', beforeKnown: false }, known('10', '20')], false),
    ).toEqual({
      issued: '10',
      redeemed: '0',
      clawed_back: '0',
      transferred: '0',
      transfers: 0,
      unknown_before: 1,
    });
  });

  it('keeps exact amounts the doubles would round', () => {
    expect(flowsOfTransaction([known('0', '9.999999999999999e80'), known('1e-81', '0')], false)).toMatchObject({
      issued: new BigNumber('9.999999999999999e80').minus('1e-81').toFixed(),
      // the 1e-81 one holder gave moved to the other: transferred, by spec 1
      transferred: new BigNumber('1e-81').toFixed(),
      transfers: 1,
    });
  });

  it('supply change equals issued minus redeemed minus clawed back over 2,000 generated transactions', () => {
    const rnd = seededRandom(2_000);
    const wrong: unknown[] = [];
    for (let t = 0; t < 2_000; t++) {
      const changes: ChangeAmounts[] = [];
      const n = 1 + Math.floor(rnd() * 5);
      for (let i = 0; i < n; i++) {
        const amount = (): string => (rnd() < 0.3 ? '0' : generatedAmount(rnd));
        changes.push({ before: amount(), after: amount(), beforeKnown: rnd() > 0.1 });
      }
      const clawback = rnd() < 0.2;
      const f = flowsOfTransaction(changes, clawback);
      const delta = changes
        .filter((c) => c.beforeKnown)
        .reduce((s, c) => s.plus(c.after).minus(c.before), new BigNumber(0));
      const identity = new BigNumber(f.issued).minus(f.redeemed).minus(f.clawed_back);
      const positive = [f.issued, f.redeemed, f.clawed_back, f.transferred].every((x) => !new BigNumber(x).isNegative());
      const transfersRight = f.transfers === (new BigNumber(f.transferred).isGreaterThan(0) ? 1 : 0);
      const unknownRight = f.unknown_before === changes.filter((c) => !c.beforeKnown).length;
      if (!delta.isEqualTo(identity) || !positive || !transfersRight || !unknownRight) wrong.push({ changes, clawback, f });
      if (clawback && f.redeemed !== '0') wrong.push({ changes, clawback, f });
      if (!clawback && f.clawed_back !== '0') wrong.push({ changes, clawback, f });
    }
    expect(wrong).toEqual([]);
  });
});
