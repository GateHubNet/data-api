import {
  burnedFromCap,
  NATIVE_CAP_DROPS,
  nativeReserveDrops,
  PoolReserves,
  reservesDrops,
  SUPPLY_ACCOUNT_PREFIXES,
  SUPPLY_PREFIXES_PER_READ,
  supplyAccountRanges,
} from './supply';

/** The XRPL base58 alphabet, written out here and not read from the code under test. */
const ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';

describe('the supply arithmetic', () => {
  describe('the account prefixes', () => {
    it('has 3,364 prefixes in byte order, each two characters of the XRPL alphabet', () => {
      expect(ALPHABET).toHaveLength(58);
      expect(SUPPLY_ACCOUNT_PREFIXES).toHaveLength(58 * 58);
      expect(SUPPLY_ACCOUNT_PREFIXES[0]).toBe('11');
      expect(SUPPLY_ACCOUNT_PREFIXES.at(-1)).toBe('zz');
      for (const prefix of SUPPLY_ACCOUNT_PREFIXES) {
        expect(prefix).toHaveLength(2);
        expect(ALPHABET).toContain(prefix[0]);
        expect(ALPHABET).toContain(prefix[1]);
      }
      // strictly increasing by byte value: in order and none twice
      for (let i = 1; i < SUPPLY_ACCOUNT_PREFIXES.length; i++) {
        const order = Buffer.compare(
          Buffer.from(SUPPLY_ACCOUNT_PREFIXES[i - 1]),
          Buffer.from(SUPPLY_ACCOUNT_PREFIXES[i]),
        );
        if (order >= 0) throw new Error(`${SUPPLY_ACCOUNT_PREFIXES[i - 1]} is not below ${SUPPLY_ACCOUNT_PREFIXES[i]}`);
      }
    });

    it('is every pair of the alphabet', () => {
      const expected = new Set<string>();
      for (const a of ALPHABET) for (const b of ALPHABET) expected.add(a + b);
      expect(new Set(SUPPLY_ACCOUNT_PREFIXES)).toEqual(expected);
    });
  });

  describe('the account ranges', () => {
    const ranges = supplyAccountRanges();

    it('cuts the key space into 106 ranges from "r" to "s" with no gap or overlap', () => {
      expect(SUPPLY_PREFIXES_PER_READ).toBe(32);
      expect(ranges).toHaveLength(106);
      expect(ranges[0].lo).toBe('r');
      expect(ranges.at(-1)?.hi).toBe('s');
      for (let k = 0; k + 1 < ranges.length; k++) expect(ranges[k].hi).toBe(ranges[k + 1].lo);
      for (const { lo, hi } of ranges) expect(Buffer.compare(Buffer.from(lo), Buffer.from(hi))).toBeLessThan(0);
    });

    it('takes 32 prefixes a range, 4 in the last one', () => {
      for (let k = 1; k < ranges.length; k++) {
        expect(ranges[k].lo).toBe(`r${SUPPLY_ACCOUNT_PREFIXES[SUPPLY_PREFIXES_PER_READ * k]}`);
      }
      for (let k = 0; k < ranges.length - 1; k++) {
        expect(ranges[k].hi).toBe(`r${SUPPLY_ACCOUNT_PREFIXES[SUPPLY_PREFIXES_PER_READ * (k + 1)]}`);
      }
      // 105 × 32 + 4 = 3,364: the last range holds the prefixes P[3360..3363]
      expect(ranges.at(-1)?.lo).toBe(`r${SUPPLY_ACCOUNT_PREFIXES[3360]}`);
    });

    it('puts every address of the alphabet in exactly one range', () => {
      const inRange = (account: string): number => ranges.filter(({ lo, hi }) => account >= lo && account < hi).length;
      const samples = [
        'r',
        'rrrrrrrrrrrrrrrrrrrrrhoLvTp', // ACCOUNT_ZERO
        'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
        'r11111111111111111111111111',
        'rzzzzzzzzzzzzzzzzzzzzzzzzzzz',
        'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH',
        // the first and the last address of each range's neighbours
        ...ranges.flatMap(({ lo }) => [lo, `${lo}1`, `${lo}zzzz`]),
      ];
      for (const account of samples) expect([account, inRange(account)]).toEqual([account, 1]);
    });
  });

  describe('the reserves', () => {
    it('adds the reserves exactly', () => {
      expect(reservesDrops(6410280n, 16998620n, 1_000_000n, 200_000n)).toBe(9_810_004_000_000n);
      expect(reservesDrops(0n, 0n, 1_000_000n, 200_000n)).toBe(0n);
      // past 2^53: no float in the sum
      expect(reservesDrops(9_007_199_254_740_993n, 1n, 1n, 1n)).toBe(9_007_199_254_740_994n);
    });
  });

  describe('the native side of a pool', () => {
    const pool = (over: Partial<PoolReserves>): PoolReserves => ({
      base_currency: 'XRP',
      base_issuer: '',
      counter_currency: 'USD',
      counter_issuer: 'rIssuer',
      reserve_base: '1.5',
      reserve_counter: '9999',
      deleted: false,
      ...over,
    });

    it('takes the native side of a pool', () => {
      expect(nativeReserveDrops(pool({}), 'XRP')).toBe(1_500_000n);
      expect(
        nativeReserveDrops(
          pool({
            base_currency: 'USD',
            base_issuer: 'rIssuer',
            counter_currency: 'XRP',
            counter_issuer: '',
            reserve_base: '9999',
            reserve_counter: '0.000001',
          }),
          'XRP',
        ),
      ).toBe(1n);
      // neither side is native
      expect(nativeReserveDrops(pool({ base_currency: 'EUR', base_issuer: 'rOther' }), 'XRP')).toBe(0n);
      // a deleted pool holds nothing, whatever its last reserves were
      expect(nativeReserveDrops(pool({ deleted: true }), 'XRP')).toBe(0n);
    });

    it("asks for the network's native currency and no issuer", () => {
      expect(nativeReserveDrops(pool({ base_currency: 'XAH' }), 'XAH')).toBe(1_500_000n);
      expect(nativeReserveDrops(pool({}), 'XAH')).toBe(0n);
      // an issued currency called XRP is not the native one
      expect(nativeReserveDrops(pool({ base_issuer: 'rIssuer' }), 'XRP')).toBe(0n);
    });

    it('counts a native side without a reserve as nothing', () => {
      expect(nativeReserveDrops(pool({ reserve_base: null }), 'XRP')).toBe(0n);
    });

    it('is exact where a float is not', () => {
      expect(nativeReserveDrops(pool({ reserve_base: '99985312374.716318' }), 'XRP')).toBe(99_985_312_374_716_318n);
      expect(nativeReserveDrops(pool({ reserve_base: '46218377.402915' }), 'XRP')).toBe(46_218_377_402_915n);
      expect(nativeReserveDrops(pool({ reserve_base: '12' }), 'XRP')).toBe(12_000_000n);
      expect(nativeReserveDrops(pool({ reserve_base: '0' }), 'XRP')).toBe(0n);
    });

    it('refuses a reserve that is not a whole number of drops', () => {
      expect(() => nativeReserveDrops(pool({ reserve_base: '0.0000001' }), 'XRP')).toThrow(/drops/);
      expect(() => nativeReserveDrops(pool({ reserve_base: 'abc' }), 'XRP')).toThrow(/drops/);
      expect(() => nativeReserveDrops(pool({ reserve_base: '-1' }), 'XRP')).toThrow(/drops/);
    });
  });

  describe('the burned drops', () => {
    it('burns what the cap lost', () => {
      expect(NATIVE_CAP_DROPS).toBe(10n ** 17n);
      expect(burnedFromCap(99_985_312_374_716_318n)).toBe(14_687_625_283_682n);
      expect(burnedFromCap(NATIVE_CAP_DROPS)).toBe(0n);
    });
  });
});
