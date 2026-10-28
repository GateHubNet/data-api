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
});
