import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA_DIR = join(__dirname, '..', '..', 'schema');
/** The migration set of the shared database (ADR-0014), run by the same runner. */
const SHARED_SCHEMA_DIR = join(__dirname, '..', '..', 'schema-shared');

/**
 * The migration runner splits a file on a semicolon at the end of a line and drops lines starting with two dashes
 * (see migrate.ts). These checks keep the schema files inside that contract without needing a ClickHouse server.
 */
describe.each([
  ['schema', SCHEMA_DIR, '001_baseline.sql'],
  ['schema-shared', SHARED_SCHEMA_DIR, '001_account_names.sql'],
])('schema files of %s/', (_set, dir, first) => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));

  it(`has at least ${first}`, () => {
    expect(files).toContain(first);
  });

  describe.each(files)('%s', (file) => {
    const content = readFileSync(join(dir, file), 'utf8');
    const lines = content.split('\n');

    it('uses LF line endings, so the checksum is the same on every checkout', () => {
      expect(content).not.toContain('\r');
    });

    it('never ends a comment line with a semicolon', () => {
      expect(lines.filter((l) => l.trim().startsWith('--') && l.trimEnd().endsWith(';'))).toEqual([]);
    });

    it('ends exactly one line per statement with a semicolon, and that line closes the statement', () => {
      const code = lines.filter((l) => !l.trim().startsWith('--'));
      // A statement starts with CREATE or ALTER (the additive migrations alter the baseline's tables).
      const starts = code.filter((l) => /^(CREATE|ALTER)\s/i.test(l)).length;
      expect(starts).toBeGreaterThan(0);

      const enders = code.map((l, i) => (l.trimEnd().endsWith(';') ? i : -1)).filter((i) => i >= 0);
      expect(enders).toHaveLength(starts);
      // After a terminator comes a blank line, the next CREATE or ALTER, or the end of the file, never a continuation.
      for (const i of enders) {
        const next = code.slice(i + 1).find((l) => l.trim() !== '');
        expect(next === undefined || /^(CREATE|ALTER)\s/i.test(next)).toBe(true);
      }
    });
  });
});
