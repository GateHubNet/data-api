import {
  amendmentNeeded,
  amendmentPasses,
  amendmentThreshold,
  isVotingLedger,
  nextFlagLedger,
  quorumOf,
  votingLedgerAtOrAfter,
} from './consensus';

describe('quorumOf (F12)', () => {
  it('is max(ceil(4 (unl - negative) / 5), ceil(3 unl / 5))', () => {
    expect([quorumOf(35, 0), quorumOf(35, 3), quorumOf(19, 1), quorumOf(2, 0), quorumOf(1, 0), quorumOf(0, 0)]).toEqual(
      [28, 26, 15, 2, 1, 0],
    );
  });

  it('never drops below 60 % of the UNL, however large the negative UNL', () => {
    expect(quorumOf(35, 14)).toBe(21);
    expect(quorumOf(35, 35)).toBe(21);
    expect(quorumOf(10, 10)).toBe(6);
  });

  it('agrees with an exact search over every UNL size and negative UNL', () => {
    const smallest = (needed: number) => {
      let q = 0;
      while (5 * q < needed) q++;
      return q;
    };
    for (let unl = 0; unl <= 120; unl++) {
      for (let negative = 0; negative <= unl; negative++) {
        expect(quorumOf(unl, negative)).toBe(Math.max(smallest(4 * (unl - negative)), smallest(3 * unl)));
      }
    }
  });
});

describe('amendment threshold (F7)', () => {
  it('is max(1, floor(trusted x 80 / 100)), and needed is one more above a single validator', () => {
    expect([0, 1, 2, 35].map((t) => [amendmentThreshold(t), amendmentNeeded(t)])).toEqual([
      [1, 1],
      [1, 1],
      [1, 2],
      [28, 29],
    ]);
  });

  it('passes with yes > threshold, and with yes >= threshold for a single validator', () => {
    expect([
      amendmentPasses(0, 0),
      amendmentPasses(1, 1),
      amendmentPasses(1, 2),
      amendmentPasses(2, 2),
      amendmentPasses(28, 35),
      amendmentPasses(29, 35),
    ]).toEqual([false, true, false, true, false, true]);
  });

  it('does not pass one vote with no trusted validator: the single-validator rule is for exactly one', () => {
    expect(amendmentPasses(1, 0)).toBe(false);
  });

  it('floors whole votes: 4 trusted -> 3, 5 -> 4, 6 -> 4, 7 -> 5', () => {
    expect([4, 5, 6, 7].map((t) => amendmentThreshold(t))).toEqual([3, 4, 4, 5]);
    expect([4, 5, 6, 7].map((t) => amendmentNeeded(t))).toEqual([4, 5, 5, 6]);
  });

  it('takes another percentage', () => {
    expect(amendmentThreshold(10, 50)).toBe(5);
    expect(amendmentNeeded(10, 50)).toBe(6);
    expect(amendmentPasses(5, 10, 50)).toBe(false);
    expect(amendmentPasses(6, 10, 50)).toBe(true);
    expect(amendmentThreshold(10)).toBe(8);
  });

  it('passes at exactly the votes needed, for every number of trusted validators with a record', () => {
    for (let trusted = 1; trusted <= 200; trusted++) {
      const needed = amendmentNeeded(trusted);
      expect(amendmentPasses(needed, trusted)).toBe(true);
      expect(amendmentPasses(needed - 1, trusted)).toBe(false);
    }
  });

  it('agrees with an exact search for the threshold', () => {
    for (let trusted = 0; trusted <= 300; trusted++) {
      let k = 0;
      while (100 * (k + 1) <= trusted * 80) k++;
      expect(amendmentThreshold(trusted)).toBe(Math.max(1, k));
    }
  });
});

describe('flag ledgers', () => {
  it('finds the voting ledger and the flag ledger around an index', () => {
    expect([
      isVotingLedger(107748095),
      nextFlagLedger(107748183),
      nextFlagLedger(107748352),
      votingLedgerAtOrAfter(107748096),
    ]).toEqual([true, 107748352, 107748608, 107748351]);
  });

  it('is a voting ledger at 256k - 1 only', () => {
    expect([254, 255, 256, 257, 511].map(isVotingLedger)).toEqual([false, true, false, false, true]);
    expect(isVotingLedger(0)).toBe(false);
  });

  it('takes the next flag ledger strictly above the index', () => {
    expect([0, 1, 255, 256, 257].map(nextFlagLedger)).toEqual([256, 256, 256, 512, 512]);
  });

  it('takes the first voting ledger at or after the index', () => {
    expect([0, 254, 255, 256, 511, 512].map(votingLedgerAtOrAfter)).toEqual([255, 255, 255, 511, 511, 767]);
    expect(votingLedgerAtOrAfter(107748095)).toBe(107748095);
  });

  it('keeps the voting ledger within a round of the index, and the flag ledger one above a voting ledger', () => {
    for (const index of [1, 100, 255, 256, 1000, 107748183]) {
      const voting = votingLedgerAtOrAfter(index);
      expect(isVotingLedger(voting)).toBe(true);
      expect(voting).toBeGreaterThanOrEqual(index);
      expect(voting).toBeLessThan(index + 256);
      expect(nextFlagLedger(voting)).toBe(voting + 1);
      expect(nextFlagLedger(index) % 256).toBe(0);
    }
  });
});
