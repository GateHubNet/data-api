import { Harness, startHarness } from './harness';
import {
  fixtureSource,
  fixtureTransactions,
  transactionId,
  transactionTreeRoot,
  XAHAU_FLAG_LEDGER,
  xahauFlagNodeBlobs,
} from './support/fixtures';

/**
 * Xahau flag ledger 26570752 (rulings R95, R97): every 256th Xahau ledger carries one `UNLReport` pseudo-transaction per
 * active validator, whose `Account` is `""` (an AccountID the node never set, serialized as `81 00`). The syncer indexes
 * it under the zero account and keeps the node's JSON; the API shows `""` like the node and serves the node's bytes.
 */
describe('a Xahau flag ledger with UNLReport pseudo-transactions (Account "")', () => {
  const seed = 'xahau-flag';
  const [ledger] = fixtureSource(seed).list();
  const all = fixtureTransactions(seed);
  const reports = all.filter((t) => t.row.tx_type === 'UNLReport');
  let h: Harness;
  const get = (path: string) => h.http().get(path).set('X-API-Key', h.key);

  beforeAll(async () => {
    h = await startHarness({ seed });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('is a flag ledger with 22 UNLReports', () => {
    expect(ledger.header.ledger_index).toBe(XAHAU_FLAG_LEDGER);
    expect(reports).toHaveLength(22);
    expect(all).toHaveLength(37);
  });

  it('GET /v2/transactions/{hash} shows Account "" as the node does', async () => {
    const res = await get(`/v2/transactions/${reports[0].tx.hash}`);
    expect(res.status).toBe(200);
    expect(res.body.transaction.tx).toMatchObject({ TransactionType: 'UNLReport', Account: '', Fee: '0' });
    expect(res.body.transaction.tx.ActiveValidator).toEqual(reports[0].tx.tx.ActiveValidator);
  });

  it("GET /v2/transactions/{hash}?binary=true serves the node's bytes, which re-hash to the hash", async () => {
    const node = xahauFlagNodeBlobs();
    for (const { tx } of reports) {
      const res = await get(`/v2/transactions/${tx.hash}?binary=true`);
      expect(res.status).toBe(200);
      expect(res.body.transaction.tx).toBe(node.get(tx.hash)?.tx);
      expect(res.body.transaction.meta).toBe(node.get(tx.hash)?.meta);
      expect(transactionId(res.body.transaction.tx)).toBe(tx.hash);
    }
  });

  it('GET /v2/ledgers/{flag}?binary=true: the transactions re-hash to the ledger transaction_hash', async () => {
    const res = await get(`/v2/ledgers/${XAHAU_FLAG_LEDGER}?binary=true`);
    expect(res.status).toBe(200);
    expect(res.body.ledger.transactions).toHaveLength(37);
    expect(transactionTreeRoot(res.body.ledger.transactions)).toBe(ledger.header.transaction_hash);
  });

  it('GET /v2/ledgers/{flag}?binary=true&expand=true is the binary form too (binary wins)', async () => {
    const res = await get(`/v2/ledgers/${XAHAU_FLAG_LEDGER}?binary=true&expand=true`);
    expect(res.status).toBe(200);
    expect(transactionTreeRoot(res.body.ledger.transactions)).toBe(ledger.header.transaction_hash);
  });

  it('GET /v2/ledgers/{flag}?expand=true shows the UNLReports with Account ""', async () => {
    const res = await get(`/v2/ledgers/${XAHAU_FLAG_LEDGER}?expand=true`);
    expect(res.status).toBe(200);
    const listed = (res.body.ledger.transactions as { tx: { TransactionType: string; Account: string } }[]).filter(
      (t) => t.tx.TransactionType === 'UNLReport',
    );
    expect(listed).toHaveLength(22);
    expect(listed.every((t) => t.tx.Account === '')).toBe(true);
  });

  it('GET /v2/transactions?type=UNLReport lists them, as JSON and as binary', async () => {
    const json = await get('/v2/transactions?type=UNLReport&limit=100');
    expect(json.status).toBe(200);
    expect(json.body.count).toBe(22);
    expect(json.body.transactions.every((t: { tx: { Account: string } }) => t.tx.Account === '')).toBe(true);
    const binary = await get('/v2/transactions?type=UNLReport&limit=100&binary=true');
    expect(binary.status).toBe(200);
    for (const t of binary.body.transactions as { hash: string; tx: string }[]) {
      expect(transactionId(t.tx)).toBe(t.hash);
    }
  });

  it('lists the UNLReports under the zero account, by sequence, as the XRPL pseudo-transactions are', async () => {
    const res = await get('/v2/accounts/rrrrrrrrrrrrrrrrrrrrrhoLvTp/transactions/0');
    expect(res.status).toBe(200);
    expect(res.body.transaction.tx).toMatchObject({ TransactionType: 'UNLReport', Account: '' });
    const bySequence = await get('/v2/accounts/rrrrrrrrrrrrrrrrrrrrrhoLvTp/transactions?min_sequence=0&limit=100');
    expect(bySequence.status).toBe(200);
    expect(bySequence.body.transactions.map((t: { hash: string }) => t.hash).sort()).toEqual(
      reports.map((t) => t.tx.hash).sort(),
    );
  });
});
