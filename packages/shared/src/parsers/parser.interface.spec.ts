import { ACCOUNT_ZERO, delegateOf, feePayer } from './parser.interface';

const A = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const D = 'rw2X2GFePFiLDdcQw6iELFfUEw1hPqAGcK';

describe('feePayer', () => {
  it('is the Delegate when the transaction has one, else the sender', () => {
    expect([
      feePayer({ Account: A, Delegate: D }),
      feePayer({ Account: A }),
      feePayer({ Account: '' }),
      feePayer({ Account: A, Delegate: '' }),
    ]).toEqual([D, A, ACCOUNT_ZERO, A]);
  });

  it('is undefined when the transaction has no usable Account and no Delegate', () => {
    expect(feePayer({})).toBeUndefined();
    expect(feePayer({ Account: 7 })).toBeUndefined();
  });

  it('is the Delegate even when Account is missing, and ignores a Delegate that is not a string', () => {
    expect(feePayer({ Delegate: D })).toBe(D);
    expect(feePayer({ Account: A, Delegate: 5 })).toBe(A);
    expect(feePayer({ Account: A, Delegate: null })).toBe(A);
  });
});

describe('delegateOf', () => {
  it('is the Delegate when it is a non-empty string, else undefined', () => {
    expect([
      delegateOf({ Account: A, Delegate: D }),
      delegateOf({ Delegate: D }),
      delegateOf({ Account: A }),
      delegateOf({ Account: A, Delegate: '' }),
      delegateOf({ Account: A, Delegate: 5 }),
      delegateOf({ Account: A, Delegate: null }),
    ]).toEqual([D, D, undefined, undefined, undefined, undefined]);
  });
});
