import { feesOfSetFee } from './set-fee';

const FEES = { base_fee: '10', reserve_base: '1000000', reserve_inc: '200000' };

describe('feesOfSetFee', () => {
  it('reads the drops fields of a SetFee after the XRPFees amendment', () => {
    const tx = {
      TransactionType: 'SetFee',
      BaseFeeDrops: '10',
      ReserveBaseDrops: '1000000',
      ReserveIncrementDrops: '200000',
    };
    expect(feesOfSetFee(JSON.stringify(tx))).toEqual(FEES);
  });

  it('reads the legacy fields: BaseFee in hex, the reserves as numbers or text', () => {
    const tx = {
      TransactionType: 'SetFee',
      BaseFee: '000000000000000A',
      ReferenceFeeUnits: 10,
      ReserveBase: 10_000_000,
      ReserveIncrement: '2000000',
    };
    expect(feesOfSetFee(JSON.stringify(tx))).toEqual({
      base_fee: '10',
      reserve_base: '10000000',
      reserve_inc: '2000000',
    });
  });

  it('reads a field from its drops form when it has both, and field by field', () => {
    const tx = { BaseFeeDrops: '12', BaseFee: '000000000000000A', ReserveBase: 5, ReserveIncrementDrops: '7' };
    expect(feesOfSetFee(JSON.stringify(tx))).toEqual({ base_fee: '12', reserve_base: '5', reserve_inc: '7' });
  });

  it('keeps an amount above 2^53 exact', () => {
    const tx = {
      BaseFeeDrops: '18446744073709551615',
      ReserveBaseDrops: '9007199254740993',
      ReserveIncrementDrops: '0',
    };
    expect(feesOfSetFee(JSON.stringify(tx))).toEqual({
      base_fee: '18446744073709551615',
      reserve_base: '9007199254740993',
      reserve_inc: '0',
    });
  });

  it('is undefined when a fee is missing or is not an amount, or the text is not a transaction', () => {
    const ok = { BaseFeeDrops: '10', ReserveBaseDrops: '1', ReserveIncrementDrops: '2' };
    expect(feesOfSetFee(JSON.stringify({ ...ok, ReserveIncrementDrops: undefined }))).toBeUndefined();
    expect(feesOfSetFee(JSON.stringify({ ...ok, BaseFeeDrops: '-1' }))).toBeUndefined();
    expect(feesOfSetFee(JSON.stringify({ ...ok, BaseFeeDrops: '1.5' }))).toBeUndefined();
    expect(feesOfSetFee(JSON.stringify({ ...ok, BaseFeeDrops: '18446744073709551616' }))).toBeUndefined();
    expect(feesOfSetFee(JSON.stringify({ ...ok, ReserveBaseDrops: null }))).toBeUndefined();
    expect(feesOfSetFee(JSON.stringify({ BaseFee: 'xyz', ReserveBase: 1, ReserveIncrement: 2 }))).toBeUndefined();
    expect(feesOfSetFee('not json')).toBeUndefined();
    expect(feesOfSetFee('[]')).toBeUndefined();
    expect(feesOfSetFee('7')).toBeUndefined();
    expect(feesOfSetFee('{}')).toBeUndefined();
  });
});
