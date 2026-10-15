import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA_DIR = join(__dirname, '..', '..', 'schema');

/**
 * The migration runner splits a file on a semicolon at the end of a line and drops lines starting with two dashes
 * (see migrate.ts). These checks keep the schema files inside that contract without needing a ClickHouse server.
 */
describe('schema files', () => {
  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.sql'));

  it('has at least the baseline', () => {
    expect(files).toContain('001_baseline.sql');
  });

  describe.each(files)('%s', (file) => {
    const content = readFileSync(join(SCHEMA_DIR, file), 'utf8');
    const lines = content.split('\n');

    it('uses LF line endings, so the checksum is the same on every checkout', () => {
      expect(content).not.toContain('\r');
    });

    it('never ends a comment line with a semicolon', () => {
      expect(lines.filter((l) => l.trim().startsWith('--') && l.trimEnd().endsWith(';'))).toEqual([]);
    });

    it('ends exactly one line per statement with a semicolon, and that line closes the statement', () => {
      const code = lines.filter((l) => !l.trim().startsWith('--'));
      const creates = code.filter((l) => /^CREATE\s/i.test(l)).length;
      expect(creates).toBeGreaterThan(0);

      const enders = code.map((l, i) => (l.trimEnd().endsWith(';') ? i : -1)).filter((i) => i >= 0);
      expect(enders).toHaveLength(creates);
      // After a terminator comes a blank line, the next CREATE or the end of the file, never a continuation.
      for (const i of enders) {
        const next = code.slice(i + 1).find((l) => l.trim() !== '');
        expect(next === undefined || /^CREATE\s/i.test(next)).toBe(true);
      }
    });
  });
});
