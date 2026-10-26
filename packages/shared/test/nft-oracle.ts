import BigNumber from 'bignumber.js';
import { createHash } from 'crypto';
import type { ParserTx } from '../src/parsers/parser.interface';

/**
 * The oracle of the NFT parser tests: the events `NftParser.parse` has to return for one transaction, worked out from the
 * transaction and its metadata in plain JavaScript and BigNumber by the rules of section 2 of the NFT spec
 * (`docs/superpowers/specs/2026-10-17-nft-data-design.md`) and the controller's rulings that amend it (written next to
 * the rules below). It never uses the parser or its helpers: the NFToken id is decoded, the page owner is encoded from the
 * page key (a base58 check encoding written out here), the amounts are formatted and the royalty is rounded again, so a
 * mistake in one of them shows up as a difference.
 *
 * Used by `src/parsers/nft.parser.spec.ts`, which compares the two over every recorded and synthetic case and over the
 * recorded sets that hold no NFT.
 */

type Json = Record<string, any>;
type Row = Record<string, unknown>;

export interface NftOracleResult {
  events: Row[];
  skipped: number;
}

/** Seconds from 1970-01-01 to the Ripple epoch, 2000-01-01. */
const RIPPLE_EPOCH = 946684800;

/** The base58 alphabet of XRPL addresses. */
const ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';

/** The classic address of a 20-byte AccountID, given as 40 hex digits (version byte 0, then a 4-byte double-SHA-256 check). */
function addressOf(hex: string): string {
  const payload = Buffer.from(`00${hex}`, 'hex');
  const sha = (data: Buffer) => createHash('sha256').update(data).digest();
  const bytes = Buffer.concat([payload, sha(sha(payload)).subarray(0, 4)]);
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let text = '';
  while (n > 0n) {
    text = ALPHABET[Number(n % 58n)] + text;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    text = ALPHABET[0] + text;
  }
  return text;
}

/**
 * Spec "How it looks": `Flags (2) | TransferFee (2) | Issuer (20) | scrambled Taxon (4) | Sequence (4)`, the taxon
 * unscrambled by `scrambled XOR ((384160001 x serial + 2459) mod 2^32)`, the product taken exactly.
 */
function decodeId(id: string) {
  const serial = BigInt(`0x${id.slice(56, 64)}`);
  const mask = (384160001n * serial + 2459n) % 4294967296n;
  return {
    flags: parseInt(id.slice(0, 4), 16),
    fee: parseInt(id.slice(4, 8), 16),
    issuer: addressOf(id.slice(8, 48)),
    taxon: Number(BigInt(`0x${id.slice(48, 56)}`) ^ mask),
    serial: Number(serial),
  };
}

/** An amount as the event columns hold it: exact decimal text in whole units, its currency and issuer. */
interface Priced {
  amount: string;
  currency: string;
  issuer: string;
  value: BigNumber;
  native: boolean;
}

/** An amount of the ledger as event text, or undefined when it is not a native or issued amount (an MPT amount is skipped). */
function priced(a: unknown, native: string): Priced | undefined {
  if (typeof a === 'string') {
    const drops = new BigNumber(a);
    if (!drops.isFinite()) return undefined;
    const value = drops.shiftedBy(-6);
    return { amount: value.toFixed(), currency: native, issuer: '', value, native: true };
  }
  const o = a as Json | null;
  if (typeof o !== 'object' || o === null || o.mpt_issuance_id !== undefined) return undefined;
  if (typeof o.currency !== 'string' || typeof o.issuer !== 'string' || o.value === undefined) return undefined;
  const value = new BigNumber(o.value);
  if (!value.isFinite()) return undefined;
  return { amount: value.toFixed(), currency: o.currency, issuer: o.issuer, value, native: false };
}

/** One entry of `AffectedNodes`. */
interface Node {
  pos: number;
  op: string;
  type: string;
  /** The `LedgerIndex`, in upper case. */
  key: string;
  created?: Json;
  final?: Json;
  /** `FinalFields` or `NewFields`. */
  now: Json;
  was: Json | undefined;
}

/** The order of the events between the removals and the creations: by kind, then by NFT id. */
const KINDS = ['mint', 'sale', 'transfer', 'burn', 'modify'];

interface Pending {
  /** 0 removals and cancels, 1 mints, sales, transfers, burns and modifies, 2 offer creations (spec 2.5). */
  group: 0 | 1 | 2;
  pos: number;
  row: Row;
}

/** Every column at its absent value, in the order of the events' columns. */
function blank(nftId: string): Row {
  return {
    nft_id: nftId,
    event_index: 0,
    kind: '',
    event: '',
    issuer: '',
    taxon: null,
    taxon_key: 0,
    serial: 0,
    nft_flags: 0,
    transfer_fee: 0,
    uri: '',
    digest: '',
    account: '',
    from_account: '',
    to_account: '',
    offer_id: '',
    is_sell_offer: 0,
    amount: '',
    currency: '',
    amount_issuer: '',
    destination: '',
    expiration: null,
    broker: '',
    broker_fee: '',
    royalty_est: '',
    removed_by: '',
  };
}

export function nftOracle(t: ParserTx, native: string): NftOracleResult {
  const result: NftOracleResult = { events: [], skipped: 0 };
  const tx = t.tx as Json;
  const meta = t.meta as Json;
  if (meta.TransactionResult !== 'tesSUCCESS') return result;

  const type: string = tx.TransactionType;
  const sender: string = tx.Account;
  const nodes: Node[] = ((meta.AffectedNodes ?? []) as Json[]).map((wrapper, pos) => {
    const op = Object.keys(wrapper)[0];
    const body = wrapper[op];
    return {
      pos,
      op,
      type: body.LedgerEntryType,
      key: String(body.LedgerIndex).toUpperCase(),
      created: body.NewFields,
      final: body.FinalFields,
      now: body.NewFields ?? body.FinalFields ?? {},
      was: body.PreviousFields,
    };
  });

  const pending: Pending[] = [];
  let skipped = 0;
  const push = (group: 0 | 1 | 2, pos: number, row: Row) => pending.push({ group, pos, row });

  // ---- XRPL: the id of an NFToken fills the columns the id encodes.
  const nftRow = (id: string, fields: Row): Row => {
    const d = decodeId(id);
    return {
      ...blank(id),
      kind: 'nftoken',
      issuer: d.issuer,
      taxon: d.taxon,
      taxon_key: d.taxon,
      serial: d.serial,
      nft_flags: d.flags,
      transfer_fee: d.fee,
      ...fields,
    };
  };
  const withAmount = (p: Priced): Row => ({ amount: p.amount, currency: p.currency, amount_issuer: p.issuer });

  // Spec 2.1: ids and owners from the pages, over the union of the transaction's pages. Ruling: the before ids of a
  // modified or deleted page are its PreviousFields.NFTokens when it has them, else its FinalFields.NFTokens; a created
  // page has none; the after ids are those of the FinalFields / NewFields of modified and created pages.
  interface Held {
    owner: string;
    uri: string;
  }
  const before = new Map<string, Held>();
  const after = new Map<string, Held>();
  for (const n of nodes) {
    if (n.type !== 'NFTokenPage') continue;
    const owner = addressOf(n.key.slice(0, 40));
    const add = (into: Map<string, Held>, tokens: Json[] | undefined) => {
      for (const entry of tokens ?? []) {
        into.set(String(entry.NFToken.NFTokenID).toUpperCase(), { owner, uri: entry.NFToken.URI ?? '' });
      }
    };
    if (n.op !== 'CreatedNode') add(before, n.was?.NFTokens ?? n.final?.NFTokens);
    if (n.op !== 'DeletedNode') add(after, n.final?.NFTokens ?? n.created?.NFTokens);
  }

  // Spec 2.2: the offers. Ruling: `removed_by` is named by the removing transaction.
  const offers = nodes.filter((n) => n.type === 'NFTokenOffer');
  const offerRow = (n: Node, event: string, removedBy: string): Row | undefined => {
    const f = n.now;
    // A zero native Amount is not stored in the NewFields of a created offer: it reads as 0.
    const p = priced(f.Amount ?? '0', native);
    if (!p) {
      skipped += 1;
      return undefined;
    }
    return nftRow(String(f.NFTokenID).toUpperCase(), {
      event,
      account: f.Owner,
      offer_id: n.key,
      is_sell_offer: (f.Flags ?? 0) & 1,
      ...withAmount(p),
      destination: f.Destination ?? '',
      expiration: f.Expiration === undefined ? null : f.Expiration + RIPPLE_EPOCH,
      removed_by: removedBy,
    });
  };
  for (const n of offers) {
    if (n.op === 'CreatedNode') {
      const row = offerRow(n, 'offer_create', '');
      if (row) push(2, n.pos, row);
    } else if (n.op === 'DeletedNode') {
      const cancel = type === 'NFTokenCancelOffer';
      const by = type === 'NFTokenAcceptOffer' ? 'sale' : type === 'NFTokenBurn' ? 'burn' : 'other';
      const row = offerRow(n, cancel ? 'offer_cancel' : 'offer_removed', cancel ? '' : by);
      if (row) push(0, n.pos, row);
    }
  }

  // Spec 2.3: the offers an NFTokenAcceptOffer accepted are the deleted offers its two fields name.
  const accepted = (field: string): Node | undefined => {
    const id = typeof tx[field] === 'string' ? tx[field].toUpperCase() : undefined;
    return offers.find((n) => n.op === 'DeletedNode' && n.key === id);
  };
  const sellOffer = type === 'NFTokenAcceptOffer' ? accepted('NFTokenSellOffer') : undefined;
  const buyOffer = type === 'NFTokenAcceptOffer' ? accepted('NFTokenBuyOffer') : undefined;
  const brokered = sellOffer !== undefined && buyOffer !== undefined;
  // Brokered: the price is the buy offer's, the sale names the sell offer. Direct: the one accepted offer is both.
  const priceOffer = brokered ? buyOffer : (sellOffer ?? buyOffer);
  const namedOffer = brokered ? sellOffer : priceOffer;

  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(id);
    const now = after.get(id);
    if (!was && now) {
      push(1, 0, nftRow(id, { event: 'mint', uri: now.uri, account: sender, to_account: now.owner }));
    } else if (was && !now) {
      push(1, 0, nftRow(id, { event: 'burn', account: sender, from_account: was.owner }));
    } else if (was && now && was.owner !== now.owner) {
      const move = { account: sender, from_account: was.owner, to_account: now.owner };
      const moved = priceOffer !== undefined && String(priceOffer.now.NFTokenID).toUpperCase() === id;
      if (!moved) {
        push(1, 0, nftRow(id, { event: 'transfer', ...move }));
        continue;
      }
      const price = priced(priceOffer.now.Amount ?? '0', native);
      if (!price) {
        skipped += 1;
        continue;
      }
      const named = { offer_id: namedOffer!.key, is_sell_offer: (namedOffer!.now.Flags ?? 0) & 1 };
      if (price.value.isZero()) {
        // An accepted offer of zero moves the NFT without a price.
        push(1, 0, nftRow(id, { event: 'transfer', ...move, ...named }));
        continue;
      }
      const brokerFee = brokered && tx.NFTokenBrokerFee !== undefined ? priced(tx.NFTokenBrokerFee, native) : undefined;
      const d = decodeId(id);
      let royalty = '';
      if (d.fee !== 0 && d.issuer !== was.owner && d.issuer !== now.owner) {
        // (price - broker fee) x TransferFee / 100000, down to a drop (native) or to the 16 digits of an issued amount.
        const raw = price.value
          .minus(brokerFee?.value ?? 0)
          .times(d.fee)
          .shiftedBy(-5);
        royalty = (
          price.native ? raw.decimalPlaces(6, BigNumber.ROUND_DOWN) : raw.precision(16, BigNumber.ROUND_DOWN)
        ).toFixed();
      }
      push(
        1,
        0,
        nftRow(id, {
          event: 'sale',
          ...move,
          ...named,
          ...withAmount(price),
          broker: brokered ? sender : '',
          broker_fee: brokerFee ? brokerFee.amount : '',
          royalty_est: royalty,
        }),
      );
    } else if (was && now && was.uri !== now.uri) {
      push(1, 0, nftRow(id, { event: 'modify', uri: now.uri, account: sender }));
    }
    // The same owner and URI on another page: a split or a merge, nothing.
  }

  // ---- Xahau: spec 2.4, from the URIToken nodes and the transaction type.
  for (const n of nodes) {
    if (n.type !== 'URIToken') continue;
    const e = n.now;
    const was = n.was ?? {};
    const row = (event: string, fields: Row): Row => ({
      ...blank(n.key),
      kind: 'uritoken',
      event,
      issuer: e.Issuer ?? '',
      nft_flags: e.Flags ?? 0,
      digest: e.Digest ?? '',
      ...fields,
    });
    /** A sell offer of the token (the offers of a URIToken are all sell offers, named by the token's id), or undefined. */
    const offer = (event: string, owner: string, amount: unknown, destination: unknown, removedBy: string) => {
      const p = priced(amount, native);
      if (!p) return undefined;
      return row(event, {
        account: owner,
        offer_id: n.key,
        is_sell_offer: 1,
        ...withAmount(p),
        destination: destination ?? '',
        removed_by: removedBy,
      });
    };
    /** Adds an offer event; an offer without a row had an MPT amount and is skipped. */
    const emit = (group: 0 | 1 | 2, built: Row | undefined) => {
      if (built) push(group, n.pos, built);
      else skipped += 1;
    };

    if (n.op === 'CreatedNode') {
      push(1, n.pos, row('mint', { account: sender, to_account: e.Owner, uri: e.URI ?? '' }));
      // Ruling: a created URIToken of a URITokenMint whose NewFields lack Amount while the transaction carries one is an
      // offer at the transaction's Amount (a zero native amount is not stored).
      const amount = e.Amount ?? (type === 'URITokenMint' ? tx.Amount : undefined);
      if (amount !== undefined) emit(2, offer('offer_create', e.Owner, amount, e.Destination, ''));
    } else if (n.op === 'DeletedNode') {
      if (e.Amount !== undefined) emit(0, offer('offer_removed', e.Owner, e.Amount, e.Destination, 'burn'));
      push(1, n.pos, row('burn', { account: sender, from_account: e.Owner }));
    } else if (n.op === 'ModifiedNode') {
      const ownerChanged = was.Owner !== undefined && was.Owner !== e.Owner;
      const amountCleared = was.Amount !== undefined && e.Amount === undefined;
      // What the entry held before: the PreviousFields value of a changed field, else the final one.
      const previous = (field: string) => (was[field] !== undefined ? was[field] : e[field]);
      if (ownerChanged && type === 'URITokenBuy') {
        if (previous('Amount') !== undefined) {
          emit(0, offer('offer_removed', was.Owner, previous('Amount'), previous('Destination'), 'sale'));
        }
        const price = priced(tx.Amount, native);
        if (price) {
          push(
            1,
            n.pos,
            row('sale', {
              account: sender,
              from_account: was.Owner,
              to_account: sender,
              offer_id: n.key,
              is_sell_offer: 1,
              ...withAmount(price),
            }),
          );
        } else {
          skipped += 1;
        }
      } else if (ownerChanged) {
        push(1, n.pos, row('transfer', { account: sender, from_account: was.Owner, to_account: e.Owner }));
        if (amountCleared) {
          emit(0, offer('offer_removed', was.Owner, was.Amount, previous('Destination'), 'transfer'));
        }
      } else if (amountCleared) {
        emit(0, offer('offer_cancel', e.Owner, was.Amount, previous('Destination'), ''));
      }
      // Ruling: a changed Amount is an offer_create in any transaction; a same-owner Amount with no previous value is one
      // only in a URITokenCreateSellOffer.
      if (e.Amount !== undefined) {
        const changed = was.Amount !== undefined;
        if (changed || (!ownerChanged && type === 'URITokenCreateSellOffer')) {
          emit(2, offer('offer_create', e.Owner, e.Amount, e.Destination, ''));
        }
      }
    }
  }

  // Spec 2.5 (Ruling 2): removals and cancels in node order, then mints, sales, transfers, burns and modifies by kind and
  // NFT id, then creations in node order.
  const rank = (p: Pending) => KINDS.indexOf(p.row.event as string);
  const byId = (a: Pending, b: Pending) => {
    const [x, y] = [a.row.nft_id as string, b.row.nft_id as string];
    return x === y ? 0 : x < y ? -1 : 1;
  };
  pending.sort((a, b) => {
    if (a.group !== b.group) return a.group - b.group;
    if (a.group === 1) return rank(a) - rank(b) || byId(a, b) || a.pos - b.pos;
    return a.pos - b.pos;
  });
  result.events = pending.map((p, index) => ({ ...p.row, event_index: index }));
  result.skipped = skipped;
  return result;
}

/**
 * Spec 2.6: the accounts an event involves, each with its roles in the order `issuer`, `minter`, `from`, `to`, `broker`,
 * `offer_owner`, `destination`; an account with two roles is one entry, and the entries are in the order of their first
 * role. The issuer is named by a mint, a burn and a sale only, so that an issuer's history is not every offer on its NFTs.
 * Ruling: a modify has no roles.
 */
export function nftOracleRoles(e: Json): [string, string[]][] {
  const named = new Map<string, string[]>();
  const add = (account: unknown, role: string) => {
    if (typeof account !== 'string' || account === '') return;
    named.set(account, [...(named.get(account) ?? []), role]);
  };
  const event: string = e.event;
  if (event === 'modify') return [];
  if (event === 'mint' || event === 'burn' || event === 'sale') add(e.issuer, 'issuer');
  if (event === 'mint' && e.account !== e.issuer) add(e.account, 'minter');
  add(e.from_account, 'from');
  add(e.to_account, 'to');
  add(e.broker, 'broker');
  if (event === 'offer_create' || event === 'offer_cancel' || event === 'offer_removed') add(e.account, 'offer_owner');
  add(e.destination, 'destination');
  // The roles an account took are in the order above, but an account listed first by an earlier role keeps its place.
  return [...named.entries()];
}
