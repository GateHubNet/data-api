import { readFileSync } from 'fs';
import { join } from 'path';
import { FixtureLedgerSource } from './fixture-ledger-source';
import { RawTransaction } from './raw-ledger';

/**
 * Guards `test/fixtures/xrpl/amm`: the named cases that the AMM parser, writer and API tests look up in `manifest.json`.
 * The README next to the fixtures says what each case shows; the structural checks below pin the facts it relies on, so
 * a re-recording that picks a different transaction cannot silently change them.
 */
const DIR = join(__dirname, '..', '..', 'test', 'fixtures', 'xrpl', 'amm');

const REQUIRED_CASES = [
  'swap_payment_xrp_iou',
  'swap_offercreate_xrp_iou',
  'swap_iou_iou',
  'payment_two_pools',
  'payment_pool_and_book',
  'offercreate_autobridged_pool_leg',
  'deposit_two_asset',
  'deposit_single_asset',
  'deposit_lp_token',
  'withdraw_two_asset',
  'withdraw_single_asset',
  'withdraw_all_deletes_pool',
  'vote',
  'bid',
  'clawback',
  'delete',
  'create',
  'lp_token_transfer',
  'swap_issuer_transfer_rate',
];

/** Not on the ledger within the searched rows (README, "Not found"); later tasks use a synthetic case. */
const NOT_FOUND = ['deposit_lp_token', 'clawback', 'delete'];

interface Case {
  ledger: number;
  hash: string;
  type: string;
  note: string;
}

interface Manifest {
  cases: Record<string, Case>;
  txs: Record<string, { ledger: number; type: string; result: string }>;
  ledgers: { ledger: number }[];
}

interface Node {
  op: 'CreatedNode' | 'ModifiedNode' | 'DeletedNode';
  type: string;
  fields: Record<string, any>;
}

const LSF_AMM_NODE = 0x01000000;
const LSF_LOW_RESERVE = 0x00010000;
const LSF_HIGH_RESERVE = 0x00020000;

const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as Manifest;
const source = FixtureLedgerSource.fromDir(DIR);

async function transactionOf(name: string): Promise<RawTransaction> {
  const c = manifest.cases[name];
  const ledger = await source.fetch(c.ledger);
  const found = ledger.transactions.find((t) => t.hash === c.hash);
  if (!found) throw new Error(`${name}: ${c.hash} is not in ledger ${c.ledger}`);
  return found;
}

function nodesOf(t: RawTransaction): Node[] {
  return (t.meta.AffectedNodes as Record<string, any>[]).map((entry) => {
    const op = Object.keys(entry)[0] as Node['op'];
    const body = entry[op];
    return {
      op,
      type: body.LedgerEntryType as string,
      fields: { ...body.PreviousFields, ...body.FinalFields, ...body.NewFields },
    };
  });
}

const poolRoots = (nodes: Node[]) => nodes.filter((n) => n.type === 'AccountRoot' && n.fields.AMMID);
const ammNodes = (nodes: Node[]) => nodes.filter((n) => n.type === 'AMM');
/** The pool side of an `lsfAMMNode` line: the side whose reserve bit is set. Undefined when neither bit is set. */
const poolSide = (line: Node): string | undefined => {
  const flags = line.fields.Flags as number;
  if (flags & LSF_LOW_RESERVE) return line.fields.LowLimit.issuer;
  if (flags & LSF_HIGH_RESERVE) return line.fields.HighLimit.issuer;
  return undefined;
};
const poolLines = (nodes: Node[]) =>
  nodes.filter((n) => n.type === 'RippleState' && ((n.fields.Flags as number) & LSF_AMM_NODE) !== 0);

describe('xrpl/amm fixtures', () => {
  it('has a manifest case for every required name that was found, and the not-found names are exactly the rest', () => {
    const found = Object.keys(manifest.cases);
    expect([...found, ...NOT_FOUND].sort()).toEqual([...REQUIRED_CASES].sort());
    for (const name of NOT_FOUND) expect(manifest.cases[name]).toBeUndefined();
  });

  it('records each case ledger once, and every ledger file belongs to a case', () => {
    const caseLedgers = new Set(Object.values(manifest.cases).map((c) => c.ledger));
    expect(manifest.ledgers.map((l) => l.ledger).sort()).toEqual([...caseLedgers].sort());
  });

  it('loads through FixtureLedgerSource', async () => {
    for (const c of Object.values(manifest.cases)) {
      expect((await source.fetch(c.ledger)).header.ledger_index).toBe(c.ledger);
    }
  });

  describe.each(Object.keys(manifest.cases))('case %s', (name) => {
    it('points at a successful transaction of the stated type, in that ledger, with a note', async () => {
      const c = manifest.cases[name];
      const t = await transactionOf(name);
      expect(t.hash).toMatch(/^[0-9A-F]{64}$/);
      expect(t.tx.TransactionType).toBe(c.type);
      expect(t.meta.TransactionResult).toBe('tesSUCCESS');
      expect(manifest.txs[c.hash]).toEqual({ ledger: c.ledger, type: c.type, result: 'tesSUCCESS' });
      expect(c.note.length).toBeGreaterThan(40);
    });
  });

  describe('what the README says about pool nodes', () => {
    it.each(['swap_payment_xrp_iou', 'swap_offercreate_xrp_iou', 'payment_pool_and_book', 'swap_issuer_transfer_rate'])(
      '%s: one pool, named by its AccountRoot and one lsfAMMNode trust line, no AMM node',
      async (name) => {
        const nodes = nodesOf(await transactionOf(name));
        expect(poolRoots(nodes)).toHaveLength(1);
        expect(poolLines(nodes)).toHaveLength(1);
        expect(ammNodes(nodes)).toHaveLength(0);
      },
    );

    it('swap_iou_iou: the pool AccountRoot and the AMM node are absent; two lsfAMMNode trust lines name the pool', async () => {
      const nodes = nodesOf(await transactionOf('swap_iou_iou'));
      expect(poolRoots(nodes)).toHaveLength(0);
      expect(ammNodes(nodes)).toHaveLength(0);
      const lines = poolLines(nodes);
      expect(lines).toHaveLength(2);
      expect(lines.map(poolSide)).toEqual(['rfWfhoLj3LiaBpoxus3h7pEF8jXDMtyGqb', 'rfWfhoLj3LiaBpoxus3h7pEF8jXDMtyGqb']);
      for (const line of lines) expect(line.op).toBe('ModifiedNode');
    });

    it('payment_two_pools: two pools, each with its own AccountRoot and trust line', async () => {
      const nodes = nodesOf(await transactionOf('payment_two_pools'));
      expect(poolRoots(nodes).map((n) => n.fields.Account)).toHaveLength(2);
      expect(poolLines(nodes)).toHaveLength(2);
    });

    it('payment_pool_and_book: an order-book offer owned by someone else is consumed next to the pool', async () => {
      const t = await transactionOf('payment_pool_and_book');
      const consumed = nodesOf(t).filter((n) => n.type === 'Offer' && n.op === 'DeletedNode');
      expect(consumed).toHaveLength(1);
      expect(consumed[0].fields.Account).not.toBe(t.tx.Account);
    });

    it('offercreate_autobridged_pool_leg: neither side of the offer is XRP, one pool and one book offer fill it', async () => {
      const t = await transactionOf('offercreate_autobridged_pool_leg');
      expect(typeof t.tx.TakerGets).toBe('object');
      expect(typeof t.tx.TakerPays).toBe('object');
      const nodes = nodesOf(t);
      expect(poolRoots(nodes)).toHaveLength(1);
      expect(nodes.filter((n) => n.type === 'Offer' && n.fields.Account !== t.tx.Account)).toHaveLength(1);
    });

    it.each(['deposit_two_asset', 'deposit_single_asset', 'withdraw_single_asset'])(
      '%s: AMM node and pool AccountRoot',
      async (name) => {
        const nodes = nodesOf(await transactionOf(name));
        expect(ammNodes(nodes)).toHaveLength(1);
        expect(poolRoots(nodes)).toHaveLength(1);
      },
    );

    it('single-asset XRP deposit and withdraw have no lsfAMMNode trust line; two-asset deposit has one', async () => {
      expect(poolLines(nodesOf(await transactionOf('deposit_single_asset')))).toHaveLength(0);
      expect(poolLines(nodesOf(await transactionOf('withdraw_single_asset')))).toHaveLength(0);
      expect(poolLines(nodesOf(await transactionOf('deposit_two_asset')))).toHaveLength(1);
    });

    it('withdraw_two_asset (IOU/IOU pool): AMM node and two trust lines, no pool AccountRoot', async () => {
      const nodes = nodesOf(await transactionOf('withdraw_two_asset'));
      expect(ammNodes(nodes)).toHaveLength(1);
      expect(poolLines(nodes)).toHaveLength(2);
      expect(poolRoots(nodes)).toHaveLength(0);
    });

    it('withdraw_all_deletes_pool: the AMM node, the pool AccountRoot and the pool trust line are deleted', async () => {
      const nodes = nodesOf(await transactionOf('withdraw_all_deletes_pool'));
      expect(ammNodes(nodes).map((n) => n.op)).toEqual(['DeletedNode']);
      expect(poolRoots(nodes).map((n) => n.op)).toEqual(['DeletedNode']);
      expect(poolLines(nodes).map((n) => n.op)).toEqual(['DeletedNode']);
    });

    it.each([
      'swap_payment_xrp_iou',
      'swap_offercreate_xrp_iou',
      'payment_two_pools',
      'payment_pool_and_book',
      'offercreate_autobridged_pool_leg',
      'deposit_two_asset',
      'swap_issuer_transfer_rate',
      'create',
    ])('%s: the reserve bit of every lsfAMMNode line points at a pool named by an AccountRoot', async (name) => {
      const nodes = nodesOf(await transactionOf(name));
      const roots = poolRoots(nodes).map((n) => n.fields.Account);
      const lines = poolLines(nodes);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(roots).toContain(poolSide(line));
    });

    it('a deleted lsfAMMNode line has no reserve bit left, so the pool side cannot be read from it', async () => {
      const [line] = poolLines(nodesOf(await transactionOf('withdraw_all_deletes_pool')));
      expect(line.op).toBe('DeletedNode');
      expect(line.fields.Flags).toBe(LSF_AMM_NODE);
      expect(poolSide(line)).toBeUndefined();
    });

    it('create: the AMM node, the pool AccountRoot and the pool trust line are created', async () => {
      const nodes = nodesOf(await transactionOf('create'));
      expect(ammNodes(nodes).map((n) => n.op)).toEqual(['CreatedNode']);
      expect(poolRoots(nodes).map((n) => n.op)).toEqual(['CreatedNode']);
      expect(poolLines(nodes).map((n) => n.op)).toEqual(['CreatedNode']);
    });

    it.each(['vote', 'bid'])('%s: the pool is named by the AMM node only', async (name) => {
      const nodes = nodesOf(await transactionOf(name));
      expect(ammNodes(nodes)).toHaveLength(1);
      expect(poolRoots(nodes)).toHaveLength(0);
      expect(poolLines(nodes)).toHaveLength(0);
    });

    it('lp_token_transfer: no AMM node, no pool AccountRoot and no lsfAMMNode line', async () => {
      const t = await transactionOf('lp_token_transfer');
      const nodes = nodesOf(t);
      expect(ammNodes(nodes)).toHaveLength(0);
      expect(poolRoots(nodes)).toHaveLength(0);
      expect(poolLines(nodes)).toHaveLength(0);
      expect((t.tx.Amount as { currency: string }).currency).toMatch(/^03[0-9A-F]{38}$/);
    });

    it('swap_issuer_transfer_rate: the receiver is credited 0.2% less than the pool paid out', async () => {
      const t = await transactionOf('swap_issuer_transfer_rate');
      const lines = nodesOf(t).filter((n) => n.type === 'RippleState');
      const change = (n: Node) => Math.abs(Number(n.fields.Balance.value) - Number(prevBalance(t, n)));
      const pool = lines.find((n) => ((n.fields.Flags as number) & LSF_AMM_NODE) !== 0) as Node;
      const user = lines.find((n) => n !== pool) as Node;
      expect(change(pool) / change(user)).toBeCloseTo(1.002, 5);
    });
  });
});

/** Balance of a `RippleState` node before the transaction, read from the raw metadata. */
function prevBalance(t: RawTransaction, node: Node): string {
  const entry = (t.meta.AffectedNodes as Record<string, any>[])
    .map((e) => e[Object.keys(e)[0]])
    .find(
      (body) =>
        body.LedgerEntryType === 'RippleState' &&
        body.FinalFields?.LowLimit?.issuer === node.fields.LowLimit.issuer &&
        body.FinalFields?.HighLimit?.issuer === node.fields.HighLimit.issuer,
    );
  return entry.PreviousFields.Balance.value;
}
