import { CheckApi, CheckNode, parseTokenHistoryCheckArgs, runTokenHistoryCheck } from './token-history-check';

const ISSUER = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
const A = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const B = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const C = 'rrrrrrrrrrrrrrrrrrrrBZbvji';

/** A fake api: the snapshot of each `token ledger`, in pages of two, and the requests it was asked, in order. */
function fakeApi(snapshots: Record<string, { holder: string; balance: string }[]>): CheckApi & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async snapshotPage(token, ledger, marker) {
      asked.push(`${token} ${ledger} ${marker ?? ''}`);
      const all = snapshots[`${token} ${ledger}`];
      if (all === undefined) return { error: 'ledger is not in the token history yet' };
      const start = marker === undefined ? 0 : Number(marker);
      return {
        currency: token.split('.')[0],
        supply: all.reduce((s, b) => s + Number(b.balance), 0).toString(),
        balances: all.slice(start, start + 2),
        ...(start + 2 < all.length && { marker: String(start + 2) }),
      };
    },
  };
}

/** A fake node: the issuer's lines (its own side: a holder's balance is negative) in pages of two, and its obligations. */
function fakeNode(
  lines: { account: string; currency: string; balance: string }[],
  obligations: Record<string, string>,
): CheckNode {
  return {
    async accountLines(_issuer, _ledger, marker) {
      const start = marker === undefined ? 0 : Number(marker);
      return { lines: lines.slice(start, start + 2), ...(start + 2 < lines.length && { marker: String(start + 2) }) };
    },
    async gatewayBalances() {
      return { obligations };
    },
  };
}

describe('parseTokenHistoryCheckArgs', () => {
  it('reads the api, the key variable, the node, the tokens file and the ledgers', () => {
    expect(
      parseTokenHistoryCheckArgs([
        '--api',
        'https://x',
        '--key-env',
        'KEY',
        '--node',
        'wss://n',
        '--tokens',
        't.txt',
        '--ledgers',
        '5,7',
      ]),
    ).toEqual({ api: 'https://x', keyEnv: 'KEY', node: 'wss://n', tokens: 't.txt', ledgers: [5, 7] });
    expect(() => parseTokenHistoryCheckArgs(['--api', 'https://x'])).toThrow(/--key-env/);
    expect(() =>
      parseTokenHistoryCheckArgs(['--api', 'a', '--key-env', 'K', '--node', 'n', '--tokens', 't', '--ledgers', '5,x']),
    ).toThrow(/--ledgers/);
  });
});

describe('runTokenHistoryCheck', () => {
  it('the check compares balances exactly and reports a difference', async () => {
    const token = `USD.${ISSUER}`;
    const api = fakeApi({
      [`${token} 100`]: [
        { holder: A, balance: '10.5' },
        { holder: B, balance: '1' },
        { holder: C, balance: '3' },
      ],
      [`${token} 200`]: [
        { holder: A, balance: '10.5' },
        { holder: B, balance: '1' },
      ],
    });
    const node = fakeNode(
      [
        { account: A, currency: 'USD', balance: '-10.50' },
        { account: B, currency: 'USD', balance: '-1.0000000000000001' },
        { account: C, currency: 'EUR', balance: '-3' },
        // a line the issuer holds the other side of: no holder of its USD
        { account: C, currency: 'USD', balance: '2' },
      ],
      { USD: '11.5' },
    );
    const out: string[] = [];
    const report = await runTokenHistoryCheck({
      api,
      node,
      samples: [{ token, ledger: 100 }],
      out: (l) => out.push(l),
    });
    expect(report).toEqual({ matched: 0, different: 1, skipped: 0 });
    // 10.5 is 10.50; 1 is not 1.0000000000000001; C holds 3 by the api and nothing by the node
    expect(out.join('\n')).toContain(`${B}: api 1, node 1.0000000000000001`);
    expect(out.join('\n')).toContain(`${C}: api 3, node 0`);
    expect(out.join('\n')).not.toContain(`${A}:`);
    expect(out.join('\n')).toContain('supply api 14.5, gateway_balances 11.5');

    const matched = await runTokenHistoryCheck({
      api,
      node: fakeNode(
        [
          { account: A, currency: 'USD', balance: '-10.5' },
          { account: B, currency: 'USD', balance: '-1' },
        ],
        { USD: '11.5' },
      ),
      samples: [
        { token, ledger: 200 },
        { token, ledger: 300 },
        { token: `${'AB'.repeat(24)}`, ledger: 200 },
      ],
      out: (l) => out.push(l),
    });
    expect(matched).toEqual({ matched: 1, different: 0, skipped: 2 });
    expect(out.join('\n')).toContain('skipped: ledger is not in the token history yet');
    expect(out.join('\n')).toContain('skipped: an MPT has no trust lines to compare');
    // one request in flight: the pages were asked one after the other, in order
    expect(api.asked.slice(0, 2)).toEqual([`${token} 100 `, `${token} 100 2`]);
  });
});
