import { decodeMarker, encodeMarker, keysetClause, nextMarker, SortKey } from './pagination';

const KEYS: SortKey[] = [
  { column: 'date', type: 'DateTime' },
  { column: 'ledger_index', type: 'UInt32' },
];

describe('pagination', () => {
  it('round-trips a marker', () => {
    const marker = encodeMarker(['2024-01-01 00:00:00', 42]);
    expect(decodeMarker(marker)).toEqual(['2024-01-01 00:00:00', 42]);
  });

  it('returns no clause without a marker', () => {
    expect(keysetClause(KEYS, false, undefined).clause).toBe('');
  });

  it('builds a tuple comparison in the sort direction', () => {
    const asc = keysetClause(KEYS, false, encodeMarker(['2024-01-01 00:00:00', 42]));
    expect(asc.clause).toBe('(date, ledger_index) > ({k0:DateTime}, {k1:UInt32})');
    expect(asc.params).toEqual({ k0: '2024-01-01 00:00:00', k1: 42 });

    const desc = keysetClause(KEYS, true, encodeMarker(['x', 1]));
    expect(desc.clause).toContain('<');
  });

  it('only emits a next marker when the page is full', () => {
    const rows = [{ date: 'd', ledger_index: 1 }];
    expect(nextMarker(rows, KEYS, 1)).toBeDefined();
    expect(nextMarker(rows, KEYS, 50)).toBeUndefined();
  });
});
