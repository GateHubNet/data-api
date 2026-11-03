import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Table } from '../clickhouse/tables';
import { ACCOUNT_DOMAINS_SEED_BUCKETS, ACCOUNT_DOMAINS_SEED_SQL } from './account-domains-seed';

describe('the account_domains seed', () => {
  it('is seeded in 16 buckets', () => {
    expect(ACCOUNT_DOMAINS_SEED_BUCKETS).toBe(16);
    expect(ACCOUNT_DOMAINS_SEED_SQL).toContain('cityHash64(account) % 16 = {bucket:UInt8}');
  });

  it('takes the last ledger and the bucket as bound parameters', () => {
    expect(ACCOUNT_DOMAINS_SEED_SQL).toContain('ledger_index <= {X:UInt32}');
    expect(ACCOUNT_DOMAINS_SEED_SQL).toContain('{bucket:UInt8}');
    expect([...ACCOUNT_DOMAINS_SEED_SQL.matchAll(/\{(\w+):/g)].map((m) => m[1]).sort()).toEqual(['X', 'bucket']);
  });

  it('copies the newest state row of an account into account_domains, the version as the parser makes it', () => {
    expect(ACCOUNT_DOMAINS_SEED_SQL).toMatch(new RegExp(`^INSERT INTO ${Table.AccountDomains} \\(`));
    expect(ACCOUNT_DOMAINS_SEED_SQL).toContain(`FROM ${Table.AccountStates}`);
    expect(ACCOUNT_DOMAINS_SEED_SQL).toContain(
      'argMax((ledger_index, tx_index, node_index), (ledger_index, tx_index, node_index)) AS top',
    );
    expect(ACCOUNT_DOMAINS_SEED_SQL).toContain(
      'bitOr(bitShiftLeft(toUInt64(top.1), 32), bitOr(bitShiftLeft(toUInt64(top.2), 16), toUInt64(top.3)))',
    );
    expect(ACCOUNT_DOMAINS_SEED_SQL).toContain("WHERE hex != '' AND gone = 0");
    expect(ACCOUNT_DOMAINS_SEED_SQL).not.toMatch(/\bFINAL\b/i);
  });

  it('is written verbatim in docs/backfill.md, where the operator copies it from', () => {
    const backfill = readFileSync(join(__dirname, '..', '..', '..', '..', 'docs', 'backfill.md'), 'utf8');

    // a fenced block of its own, at the first column: a statement indented under a list item is no copy of it
    expect(backfill).toContain(`\n\`\`\`sql\n${ACCOUNT_DOMAINS_SEED_SQL}\n\`\`\`\n`);
    expect(backfill).toContain('### Account domains seed');
  });
});
