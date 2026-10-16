import {
  bucketAvg,
  ledgerAvg,
  roundToDrops,
  StoredBucketFees,
  StoredFeeStat,
  StoredLedgerFees,
  toBucketFees,
  toFeeStat,
  toLedgerFees,
  toNative,
} from './fee-object';

describe('toNative', () => {
  it('turns drops into native units: a million drops to the unit, as an exact double', () => {
    expect(toNative(0)).toBe(0);
    expect(toNative(10)).toBe(0.00001);
    expect(toNative(12)).toBe(0.000012);
    expect(toNative(1)).toBe(0.000001);
    expect(toNative(5000)).toBe(0.005);
    expect(toNative(1_082_568)).toBe(1.082568);
    expect(toNative(123_456_789_012)).toBe(123456.789012);
  });

  it('takes the text of digits a ClickHouse client may hand over for a 64-bit column', () => {
    expect(toNative('1082568')).toBe(1.082568);
  });
});

describe('roundToDrops', () => {
  it('rounds to 6 decimals of the unit (a drop), as `round(x, 6)` of the original aggregation', () => {
    expect(roundToDrops(0.0106154)).toBe(0.010615);
    expect(roundToDrops(0.0000125)).toBe(0.000013); // 12.5 drops: half up
    expect(roundToDrops(0.00001)).toBe(0.00001);
    expect(roundToDrops(1.0000000000000002)).toBe(1);
    expect(roundToDrops(0)).toBe(0);
  });

  it('copes with values the text of which is in exponent form (the original turned them into NaN)', () => {
    expect(roundToDrops(5e-7)).toBe(0.000001); // half a drop rounds up
    expect(roundToDrops(4e-7)).toBe(0);
    expect(Number.isNaN(roundToDrops(1e-9))).toBe(false);
  });
});

describe('ledgerAvg', () => {
  it('is the mean fee to 6 significant digits, then to a drop (the parser, then the aggregation of the original)', () => {
    // ledger 11118827 of the mock ledgers: 13 transactions, 138000 drops: 0.0106153846... -> 0.0106154 -> 0.010615
    expect(ledgerAvg(138_000, 13)).toBe(0.010615);
    expect(ledgerAvg(109_000, 10)).toBe(0.0109);
    expect(ledgerAvg(120, 12)).toBe(0.00001);
  });

  it('is 0 for a ledger without transactions, not NaN', () => {
    expect(ledgerAvg(0, 0)).toBe(0);
  });
});

describe('bucketAvg', () => {
  it('is the total over the count, to a drop', () => {
    expect(bucketAvg(1_000_025, 2)).toBe(0.500013); // 500012.5 drops
    expect(bucketAvg(30_000, 3)).toBe(0.01);
  });

  it('is 0 for a bucket without transactions (the original divided 0 by 0)', () => {
    expect(bucketAvg(0, 0)).toBe(0);
  });
});

describe('toLedgerFees', () => {
  const stored: StoredLedgerFees = {
    ledger_index: 11118827,
    closed: 1421256550,
    tx_count: 13,
    fee_total: 138000,
    fee_min: 10000,
    fee_max: 11000,
  };

  it('is {avg, max, min, total, tx_count, date, ledger_index}, in the order HBase served the columns, fees in native units', () => {
    const row = toLedgerFees(stored);
    expect(row).toEqual({
      avg: 0.010615,
      max: 0.011,
      min: 0.01,
      total: 0.138,
      tx_count: 13,
      date: '2015-01-14T17:29:10Z',
      ledger_index: 11118827,
    });
    expect(Object.keys(row)).toEqual(['avg', 'max', 'min', 'total', 'tx_count', 'date', 'ledger_index']);
  });

  it('is all numbers (and the date text), whatever shape the client hands the 64-bit columns over in', () => {
    const row = toLedgerFees({
      ...stored,
      fee_total: '138000' as unknown as number,
      fee_min: '10000' as unknown as number,
      fee_max: '11000' as unknown as number,
    });
    expect(row).toEqual(toLedgerFees(stored));
    for (const key of ['avg', 'min', 'max', 'total', 'tx_count', 'ledger_index'] as const) {
      expect(typeof row[key]).toBe('number');
    }
  });

  it('an empty ledger has min 0, max 0, total 0, avg 0 and a count of 0', () => {
    expect(toLedgerFees({ ...stored, tx_count: 0, fee_total: 0, fee_min: 0, fee_max: 0 })).toEqual({
      avg: 0,
      min: 0,
      max: 0,
      total: 0,
      tx_count: 0,
      date: '2015-01-14T17:29:10Z',
      ledger_index: 11118827,
    });
  });
});

describe('toBucketFees', () => {
  const stored: StoredBucketFees = {
    bucket: 1421251200, // 2015-01-14T16:00:00Z
    ledgers: 2,
    tx_count: 3,
    fee_total: 30_000,
    fee_min: 10_000,
    fee_max: 10_000,
  };

  it('is {avg, max, min, total, tx_count, date} with the start of the bucket as date and no ledger_index', () => {
    const row = toBucketFees(stored);
    expect(row).toEqual({
      avg: 0.01,
      max: 0.01,
      min: 0.01,
      total: 0.03,
      tx_count: 3,
      date: '2015-01-14T16:00:00Z',
    });
    expect(Object.keys(row)).toEqual(['avg', 'max', 'min', 'total', 'tx_count', 'date']);
  });

  it('a bucket of one ledger has the avg of that ledger (to six digits, then to a drop), a bucket of two is worked out again', () => {
    // 138000 drops over 13 transactions: 0.0106153846 -> 0.0106154 -> 0.010615 either way...
    const one = { bucket: 1421251200, ledgers: 1, tx_count: 13, fee_total: 138_000, fee_min: 10_000, fee_max: 11_000 };
    expect(toBucketFees(one).avg).toBe(0.010615);
    // ... but 10500.46 drops is 0.01050046 -> 0.0105005 (a tenth of a drop is all six digits keep) -> 0.010501
    // for a ledger, and 0.010500 straight from the total
    const tie = {
      bucket: 1421251200,
      ledgers: 1,
      tx_count: 100,
      fee_total: 1_050_046,
      fee_min: 10_000,
      fee_max: 11_000,
    };
    expect(toBucketFees(tie).avg).toBe(0.010501);
    expect(toBucketFees({ ...tie, ledgers: 2 }).avg).toBe(0.0105);
  });

  it('a bucket of empty ledgers or of transactions that paid nothing: min 0, avg 0', () => {
    expect(toBucketFees({ ...stored, tx_count: 0, fee_total: 0, fee_min: 0, fee_max: 0 })).toMatchObject({
      avg: 0,
      min: 0,
      max: 0,
      total: 0,
      tx_count: 0,
    });
  });
});

describe('toFeeStat', () => {
  const stored: StoredFeeStat = {
    ms: 1471997700123,
    current_ledger_size: 46,
    expected_ledger_size: 52,
    current_queue_size: 3,
    pct_max_queue_size: 0.29,
    median_fee: 5000,
    minimum_fee: 10,
    open_ledger_fee: 12,
  };

  it('is the snapshot with fees in native units, the date to the second, and the fields sorted by name as HBase served them', () => {
    const row = toFeeStat(stored);
    expect(row).toEqual({
      current_ledger_size: 46,
      current_queue_size: 3,
      date: '2016-08-24T00:15:00Z',
      expected_ledger_size: 52,
      median_fee: 0.005,
      minimum_fee: 0.00001,
      open_ledger_fee: 0.000012,
      pct_max_queue_size: 0.29,
    });
    expect(Object.keys(row)).toEqual([
      'current_ledger_size',
      'current_queue_size',
      'date',
      'expected_ledger_size',
      'median_fee',
      'minimum_fee',
      'open_ledger_fee',
      'pct_max_queue_size',
    ]);
  });

  it('every field is a number but the date, also when the client hands the 64-bit columns over as text', () => {
    const row = toFeeStat({
      ...stored,
      ms: '1471997700123' as unknown as number,
      median_fee: '5000' as unknown as number,
    });
    expect(row).toEqual(toFeeStat(stored));
    for (const [key, value] of Object.entries(row)) expect(typeof value).toBe(key === 'date' ? 'string' : 'number');
  });

  it('cuts the milliseconds off the date (the original stamped whole seconds)', () => {
    expect(toFeeStat({ ...stored, ms: 1471997700999 }).date).toBe('2016-08-24T00:15:00Z');
  });
});
