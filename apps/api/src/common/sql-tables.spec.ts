import { SharedTable, Table } from '@gatehub/data-api-shared';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

/**
 * `FROM ledgers`, `JOIN transactions`, `INSERT INTO payments`: a table named by hand instead of by `Table`. A table of
 * the shared database written by hand (`FROM account_names`) would also read the network database, not the shared one.
 */
const NAMED_BY_HAND = new RegExp(
  `\\b(?:FROM|JOIN|INTO)\\s+(?:${[...Object.values(Table), ...Object.values(SharedTable)].join('|')})\\b`,
  'i',
);

describe('SQL in the API', () => {
  it('takes the table names from the Table enum: none is written by hand', () => {
    const files = sourceFiles(SRC);
    expect(files.map((f) => relative(SRC, f))).toEqual(
      expect.arrayContaining(['common/ledger-range.service.ts', 'common/tx-object.ts']),
    );
    const offenders = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          // prose in comments is not SQL
          !/^\s*(\/\/|\*|\/\*)/.test(line) && NAMED_BY_HAND.test(line)
            ? [`${relative(SRC, file)}:${i + 1}: ${line.trim()}`]
            : [],
        ),
    );
    expect(offenders).toEqual([]);
  });

  it('finds a table written by hand', () => {
    expect(NAMED_BY_HAND.test('SELECT 1 FROM ledgers')).toBe(true);
    expect(NAMED_BY_HAND.test('SELECT 1 FROM ${Table.Ledgers}')).toBe(false);
    expect(NAMED_BY_HAND.test('INSERT INTO tx_by_hash')).toBe(true);
    expect(NAMED_BY_HAND.test('SELECT name FROM account_names')).toBe(true);
    expect(NAMED_BY_HAND.test('SELECT name FROM ${shared}.${SharedTable.AccountNames}')).toBe(false);
  });
});
