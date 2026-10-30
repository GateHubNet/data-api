import { mintSlices, SUPPLY_MINT_SLICE_LEDGERS } from './supply';

describe('mintSlices', () => {
  it('cuts at the multiples of a million ledgers, the partitions of the mint tables', () => {
    expect(SUPPLY_MINT_SLICE_LEDGERS).toBe(1_000_000);
    expect(mintSlices(999_998, 2_000_001)).toEqual([
      [999_998, 999_999],
      [1_000_000, 1_999_999],
      [2_000_000, 2_000_001],
    ]);
  });

  it('keeps a range inside one partition whole', () => {
    expect(mintSlices(5, 10)).toEqual([[5, 10]]);
    expect(mintSlices(1_000_000, 1_999_999)).toEqual([[1_000_000, 1_999_999]]);
    expect(mintSlices(0, 0)).toEqual([[0, 0]]);
    expect(mintSlices(7, 7)).toEqual([[7, 7]]);
  });

  it('has no gap or overlap at a cut', () => {
    expect(mintSlices(999_999, 1_000_000)).toEqual([
      [999_999, 999_999],
      [1_000_000, 1_000_000],
    ]);
  });

  it('covers the whole key space of a ledger index', () => {
    const slices = mintSlices(0, 4_294_967_295);
    expect(slices).toHaveLength(4295);
    expect(slices[0]).toEqual([0, 999_999]);
    expect(slices.at(-1)).toEqual([4_294_000_000, 4_294_967_295]);
    for (let i = 1; i < slices.length; i++) expect(slices[i][0]).toBe(slices[i - 1][1] + 1);
  });

  it('is empty for a range that is none', () => {
    expect(mintSlices(10, 5)).toEqual([]);
  });
});
