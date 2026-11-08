import { TokenHistoryLease } from './token-history-lease';

/**
 * A ClickHouse that keeps the rows of `syncer_lease` the way the server does: the newest row of a lease is its state, aged on the
 * server's clock (here `now`).
 */
function fakeLeaseTable() {
  const rows: Array<{ network: string; holder: string; at: number }> = [];
  let now = 1_000_000;
  const ch = {
    queryOne: jest.fn(async (_sql: string, params: { network: string }) => {
      const mine = rows.filter((r) => r.network === params.network);
      if (mine.length === 0) return { holder: '', age_ms: '0', n: '0' };
      const newest = mine.reduce((a, b) => (b.at >= a.at ? b : a));
      return { holder: newest.holder, age_ms: String(now - newest.at), n: String(mine.length) };
    }),
    command: jest.fn(async (_sql: string, params: { network: string; holder: string }) => {
      rows.push({ network: params.network, holder: params.holder, at: now });
    }),
  };
  return { ch, rows, advance: (ms: number) => (now += ms) };
}

describe('TokenHistoryLease', () => {
  it('the lease is refused while another fresh holder has it, and taken after its TTL', async () => {
    const db = fakeLeaseTable();
    const first = new TokenHistoryLease(db.ch as never, 'xrpl', 'worker-a');
    const second = new TokenHistoryLease(db.ch as never, 'xrpl', 'worker-b');
    await first.take();
    expect(db.rows).toEqual([{ network: 'xrpl:token_history', holder: 'worker-a', at: 1_000_000 }]);

    db.advance(29_000);
    await expect(second.take()).rejects.toThrow('another token_history worker holds the lease (worker-a)');
    // its own holder takes it again at once
    await expect(first.take()).resolves.toBeUndefined();

    db.advance(30_000);
    await expect(second.take()).resolves.toBeUndefined();
    expect(db.rows[db.rows.length - 1]).toMatchObject({ holder: 'worker-b' });
  });

  it('a heartbeat renews the lease while it is ours, and stops when another holder took it', async () => {
    const db = fakeLeaseTable();
    const lease = new TokenHistoryLease(db.ch as never, 'xahau', 'worker-a');
    await lease.take();
    db.advance(10_000);
    await expect(lease.heartbeat()).resolves.toBe(true);
    expect(db.rows).toHaveLength(2);
    // another worker took it over after a long pause of ours
    db.rows.push({ network: 'xahau:token_history', holder: 'worker-b', at: 1_100_000 });
    db.advance(100_000);
    await expect(lease.heartbeat()).resolves.toBe(false);
    expect(db.rows[db.rows.length - 1]).toMatchObject({ holder: 'worker-b' });
  });

  it('release writes an empty holder, so the next worker takes the lease at once', async () => {
    const db = fakeLeaseTable();
    const lease = new TokenHistoryLease(db.ch as never, 'xrpl', 'worker-a');
    await lease.take();
    await lease.release();
    expect(db.rows[db.rows.length - 1]).toMatchObject({ holder: '' });
    await expect(new TokenHistoryLease(db.ch as never, 'xrpl', 'worker-b').take()).resolves.toBeUndefined();
  });
});
