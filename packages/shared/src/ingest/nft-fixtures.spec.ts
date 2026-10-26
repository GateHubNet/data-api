import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { encodeAccountID } from 'ripple-address-codec';
import { FixtureLedgerSource } from './fixture-ledger-source';
import { RawTransaction } from './raw-ledger';

/**
 * Guards `test/fixtures/xrpl/nft` and `test/fixtures/xahau/uritoken`: the named cases that the NFT parser, writer and API
 * tests look up in each `manifest.json`. The `FINDINGS.md` next to the ledgers says what each case shows and which names
 * were not found (they become `synthetic-…` transactions in the tests that need them); the checks below pin the facts the
 * cases are chosen for, so a re-recording that picks a different transaction cannot silently change them.
 */
const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');

const XRPL_CASES = [
  'mint',
  'mint_with_offer',
  'mint_on_behalf',
  'burn',
  'burn_removes_offers',
  'modify',
  'sell_offer_create',
  'buy_offer_create',
  'offer_cancel',
  'sale_by_sell_offer',
  'sale_by_buy_offer',
  'brokered_sale_royalty',
  'sale_issued_currency',
  'transfer_zero_amount',
  'page_split_with_mint',
  'offer_removed_other',
];

const XAHAU_CASES = [
  'uritoken_mint',
  'uritoken_mint_with_offer',
  'uritoken_sell_offer_create',
  'uritoken_sell_offer_cancel',
  'uritoken_buy_above_ask',
  'uritoken_burn_with_offer',
  'remit_transfer',
  'remit_mint',
  'uritoken_remint',
];

/** NFTokenMintOffer and DynamicNFT: the first ledgers in which a mint can carry an `Amount` and an NFT can be modified. */
const NFTOKEN_MINT_OFFER_LEDGER = 94166785;
const DYNAMIC_NFT_LEDGER = 96724737;

interface Case {
  ledger: number;
  hash: string;
  type: string;
  note: string;
  /** `uritoken_remint` only: the earlier `URITokenBurn` of the id that the case's mint creates again. */
  burn?: { ledger: number; hash: string };
}

interface Manifest {
  cases: Record<string, Case>;
  txs: Record<string, { ledger: number; type: string; result: string }>;
  ledgers: { ledger: number }[];
}

interface Node {
  op: 'CreatedNode' | 'ModifiedNode' | 'DeletedNode';
  type: string;
  index: string;
  /** The node's fields after the transaction (`FinalFields` or `NewFields`). */
  after: Record<string, any>;
  /** The node's fields before it (`PreviousFields` over `FinalFields`). */
  before: Record<string, any>;
}

function nodesOf(t: RawTransaction): Node[] {
  return (t.meta.AffectedNodes as Record<string, any>[]).map((entry) => {
    const op = Object.keys(entry)[0] as Node['op'];
    const body = entry[op];
    return {
      op,
      type: body.LedgerEntryType as string,
      index: body.LedgerIndex as string,
      after: { ...body.FinalFields, ...body.NewFields },
      before: { ...body.FinalFields, ...body.PreviousFields },
    };
  });
}

const field = (t: RawTransaction, name: string): any => t.tx[name];
const flagsOf = (t: RawTransaction): number => (field(t, 'Flags') as number | undefined) ?? 0;
const offers = (t: RawTransaction, op: Node['op']) =>
  nodesOf(t).filter((n) => n.type === 'NFTokenOffer' && n.op === op);
/** The offers an `NFTokenAcceptOffer` consumed: the deleted nodes named by its two offer fields. */
const accepted = (t: RawTransaction) =>
  offers(t, 'DeletedNode').filter((n) => [field(t, 'NFTokenSellOffer'), field(t, 'NFTokenBuyOffer')].includes(n.index));
const uriTokens = (t: RawTransaction) => nodesOf(t).filter((n) => n.type === 'URIToken');

/** The first 20 bytes of an `NFTokenPage` key are the owner's AccountID. */
const pageOwner = (index: string): string => encodeAccountID(Buffer.from(index.slice(0, 40), 'hex'));
/** An NFTokenID is `Flags (2) | TransferFee (2) | Issuer (20) | scrambled Taxon (4) | Sequence (4)` bytes. */
const idFee = (nftId: string): number => parseInt(nftId.slice(4, 8), 16);
const idIssuer = (nftId: string): string => encodeAccountID(Buffer.from(nftId.slice(8, 48), 'hex'));

/** One accepted offer, of the named side and no other, with a non-zero native `Amount`. */
function directSale(t: RawTransaction, side: string, other: string): boolean {
  const [offer, ...rest] = accepted(t);
  return (
    field(t, side) !== undefined &&
    field(t, other) === undefined &&
    rest.length === 0 &&
    typeof offer?.after.Amount === 'string' &&
    offer.after.Amount !== '0'
  );
}

/** What the transaction of a case must show beyond its type (the table of the plan's Task 1). */
const XRPL_SHOWS: Record<string, (t: RawTransaction, c: Case, burn?: RawTransaction) => boolean> = {
  mint: (t) => field(t, 'Issuer') === undefined && field(t, 'Amount') === undefined,
  mint_with_offer: (t) => field(t, 'Amount') !== undefined && offers(t, 'CreatedNode').length === 1,
  mint_on_behalf: (t) => field(t, 'Issuer') !== undefined && field(t, 'Issuer') !== field(t, 'Account'),
  burn: (t) => offers(t, 'DeletedNode').length === 0,
  burn_removes_offers: (t) => offers(t, 'DeletedNode').length > 0,
  modify: () => true,
  sell_offer_create: (t) => (flagsOf(t) & 1) === 1,
  buy_offer_create: (t) => (flagsOf(t) & 1) === 0,
  offer_cancel: () => true,
  sale_by_sell_offer: (t) => directSale(t, 'NFTokenSellOffer', 'NFTokenBuyOffer'),
  sale_by_buy_offer: (t) => directSale(t, 'NFTokenBuyOffer', 'NFTokenSellOffer'),
  brokered_sale_royalty: (t) => {
    const [sell, buy] = [field(t, 'NFTokenSellOffer'), field(t, 'NFTokenBuyOffer')].map((id) =>
      accepted(t).find((n) => n.index === id),
    );
    if (!sell || !buy || field(t, 'NFTokenBrokerFee') === undefined) return false;
    const nftId = sell.after.NFTokenID as string;
    return idFee(nftId) > 0 && ![sell.after.Owner, buy.after.Owner].includes(idIssuer(nftId));
  },
  sale_issued_currency: (t) => accepted(t).length > 0 && accepted(t).every((n) => typeof n.after.Amount === 'object'),
  transfer_zero_amount: (t) => accepted(t).length === 1 && accepted(t)[0].after.Amount === '0',
  page_split_with_mint: (t) => {
    const pages = nodesOf(t).filter((n) => n.type === 'NFTokenPage');
    return pages
      .filter((n) => n.op === 'CreatedNode')
      .some((created) => pages.some((n) => n.op === 'ModifiedNode' && pageOwner(n.index) === pageOwner(created.index)));
  },
  offer_removed_other: (t) =>
    !['NFTokenAcceptOffer', 'NFTokenBurn', 'NFTokenCancelOffer'].includes(field(t, 'TransactionType')) &&
    offers(t, 'DeletedNode').length > 0,
};

/** What a Xahau case must show; the third argument is the case's `burn` transaction, when it has one. */
const XAHAU_SHOWS: Record<string, (t: RawTransaction, c: Case, burn?: RawTransaction) => boolean> = {
  uritoken_mint: (t) => field(t, 'Amount') === undefined,
  uritoken_mint_with_offer: (t) => field(t, 'Amount') !== undefined && field(t, 'Destination') !== undefined,
  uritoken_sell_offer_create: (t) => field(t, 'Amount') !== undefined,
  uritoken_sell_offer_cancel: () => true,
  // A buy that pays more than the ask, else (FINDINGS says so, and the note says "exactly the ask") any buy of an offer.
  uritoken_buy_above_ask: (t, c) => {
    const ask = uriTokens(t)[0]?.before.Amount;
    const value = (amount: any): number => Number(typeof amount === 'string' ? amount : amount.value);
    if (ask === undefined || value(field(t, 'Amount')) < value(ask)) return false;
    return value(field(t, 'Amount')) > value(ask) === !/exactly the ask/.test(c.note);
  },
  uritoken_burn_with_offer: (t) => uriTokens(t).some((n) => n.op === 'DeletedNode' && n.after.Amount !== undefined),
  remit_transfer: (t) => Array.isArray(field(t, 'URITokenIDs')) && field(t, 'URITokenIDs').length > 0,
  remit_mint: (t) => field(t, 'MintURIToken') !== undefined,
  // The mint creates an index that the earlier burn deleted: one id, two lives (decision 19).
  uritoken_remint: (t, _c, burn) => {
    const created = uriTokens(t).filter((n) => n.op === 'CreatedNode');
    const deleted = burn ? uriTokens(burn).filter((n) => n.op === 'DeletedNode') : [];
    return (
      created.length === 1 &&
      deleted.length === 1 &&
      created[0].index === deleted[0].index &&
      created[0].after.URI === deleted[0].after.URI &&
      created[0].after.Issuer === deleted[0].after.Issuer
    );
  },
};

/** The names under the "Not found" heading of `FINDINGS.md`: one bullet each, the name in backticks first. */
function notFoundNames(findings: string): string[] {
  const lines = findings.split('\n');
  const start = lines.findIndex((line) => /^##\s+Not found\s*$/.test(line));
  if (start < 0) throw new Error('FINDINGS.md has no "## Not found" section');
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    const match = /^- `([a-z_]+)`/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

describe.each([
  ['xrpl/nft', XRPL_CASES, XRPL_SHOWS],
  ['xahau/uritoken', XAHAU_CASES, XAHAU_SHOWS],
] as const)('%s fixtures', (set, required, shows) => {
  const dir = join(FIXTURES, ...set.split('/'));
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const findings = readFileSync(join(dir, 'FINDINGS.md'), 'utf8');
  const source = FixtureLedgerSource.fromDir(dir);
  const found = Object.keys(manifest.cases);

  async function transactionAt(ledger: number, hash: string): Promise<RawTransaction> {
    const t = (await source.fetch(ledger)).transactions.find((tx) => tx.hash === hash);
    if (!t) throw new Error(`${hash} is not in ledger ${ledger}`);
    return t;
  }
  const transactionOf = (name: string) => transactionAt(manifest.cases[name].ledger, manifest.cases[name].hash);

  it('has a case for every required name, and the not-found names are exactly the ones FINDINGS lists', () => {
    expect(found.filter((name) => !required.includes(name))).toEqual([]);
    const missing = required.filter((name) => !found.includes(name));
    expect(missing.sort()).toEqual(notFoundNames(findings).sort());
  });

  it('records each case ledger once, and every ledger file belongs to a case', () => {
    const caseLedgers = [
      ...new Set(Object.values(manifest.cases).flatMap((c) => [c.ledger, c.burn?.ledger ?? c.ledger])),
    ].sort((a, b) => a - b);
    expect(manifest.ledgers.map((l) => l.ledger).sort((a, b) => a - b)).toEqual(caseLedgers);
    const files = readdirSync(dir)
      .filter((name) => /^\d+\.json\.gz$/.test(name))
      .map((name) => Number(name.slice(0, name.indexOf('.'))))
      .sort((a, b) => a - b);
    expect(files).toEqual(caseLedgers);
  });

  it('loads through FixtureLedgerSource', async () => {
    for (const c of Object.values(manifest.cases)) {
      expect((await source.fetch(c.ledger)).header.ledger_index).toBe(c.ledger);
    }
  });

  describe.each(found)('case %s', (name) => {
    it('points at a successful transaction of the stated type, in that ledger, with a note', async () => {
      const c = manifest.cases[name];
      const t = await transactionOf(name);
      expect(t.hash).toMatch(/^[0-9A-F]{64}$/);
      expect(t.tx.TransactionType).toBe(c.type);
      expect(t.meta.TransactionResult).toBe('tesSUCCESS');
      expect(manifest.txs[c.hash]).toEqual({ ledger: c.ledger, type: c.type, result: 'tesSUCCESS' });
      expect(c.note.length).toBeGreaterThan(40);
    });

    it('shows what the case is for', async () => {
      const c = manifest.cases[name];
      const burn = c.burn && (await transactionAt(c.burn.ledger, c.burn.hash));
      expect(shows[name]).toBeDefined();
      expect(shows[name](await transactionOf(name), c, burn)).toBe(true);
      if (c.burn) {
        expect(burn?.tx.TransactionType).toBe('URITokenBurn');
        expect(burn?.meta.TransactionResult).toBe('tesSUCCESS');
        expect(manifest.txs[c.burn.hash]).toEqual({
          ledger: c.burn.ledger,
          type: 'URITokenBurn',
          result: 'tesSUCCESS',
        });
        expect(c.burn.ledger).toBeLessThan(c.ledger);
      }
    });
  });
});

describe('xrpl/nft fixtures: amendment ledgers', () => {
  const manifest = JSON.parse(readFileSync(join(FIXTURES, 'xrpl', 'nft', 'manifest.json'), 'utf8')) as Manifest;

  it('mint_with_offer is at or above 94166785 and modify at or above 96724737', () => {
    expect(manifest.cases.mint_with_offer.ledger).toBeGreaterThanOrEqual(NFTOKEN_MINT_OFFER_LEDGER);
    expect(manifest.cases.modify.ledger).toBeGreaterThanOrEqual(DYNAMIC_NFT_LEDGER);
  });
});
