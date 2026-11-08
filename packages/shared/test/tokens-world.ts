import BigNumber from 'bignumber.js';
import { createHash } from 'node:crypto';
import { decodeAccountID, encodeAccountID } from 'ripple-address-codec';
import { LowSideLine, orientations, TokenKey, WantedTokenLine } from '../src/aggregate/token-rules';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { AccountDomainsRow, DomainTomlsRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { normalizeLedgerResponse } from '../src/ingest/raw-ledger';
import { getNetworkProfile } from '../src/network';
import { TomlCurrency } from '../src/tomls/toml-read';
import { okTomlRow, tomlUrlOf } from '../src/tomls/toml-store';
import { ledgerCurrencyOf } from '../src/util/currency-code';
import { syntheticHash } from './synthetic-hash';

/**
 * A world of issued tokens, for the suites of the tokens job (the shared job, the syncer's aggregator, the api): synthetic ledgers
 * written through the real `LedgerWriter`, whose transactions carry hand-built `RippleState` and `AccountRoot` nodes, and the
 * `account_domains` and `domain_tomls` rows of the issuers' domains, written directly (the two tables D4's workers fill).
 *
 * Nothing here was recorded: every transaction is a `TrustSet` or an `AccountSet` (or an `AccountDelete`) made for the node it
 * carries, with a hash `synthetic-tokens-world:…`. The lines are declared from the issuer's side (what the issuer owes the holder);
 * `above` and `below` pick a holder whose account ID is above or below the issuer's, so that the issuer is the line's low account
 * for some lines and its high account for others, and every case of Task 3's table is met from both sides.
 *
 * The world, ledger by ledger (`first` is the first):
 *  - `first`: the issuers set their flags; the first lines are made.
 *  - `first + 1`: `gate` sets a transfer rate (1.005); more lines are made, among them the zero line of two limits above 0.
 *  - `first + 2`: balances change; two lines are deleted (one still shows a balance owed); one line turns round.
 *  - `first + 3`: `gate` lowers its transfer rate to 1.002 and freezes globally; a balance changes again.
 *  - `first + 4`: a deleted line is made again; an AMM pool holds two tokens and issues its LP token; `gone` is deleted.
 *  - `first + 5` (the head): one more change; `nostate` has two lines of HUG, one of them 1e40 (above what the exact sums hold).
 *
 * A second batch of four ledgers after the head is written apart (`seedTokensWorldLater`): the suites that read the world at its head
 * never see it, and the suites of the touches apply it.
 */

type Json = Record<string, any>;

/** The issuer a ledger names in the `Balance` of a RippleState (rippled writes ACCOUNT_ONE there). */
const BALANCE_ISSUER = 'rrrrrrrrrrrrrrrrrrrrBZbvji';

/** The `RippleState` flags the world sets. */
const LSF = {
  lowReserve: 0x00010000,
  highReserve: 0x00020000,
  lowAuth: 0x00040000,
  highAuth: 0x00080000,
  lowFreeze: 0x00400000,
  highFreeze: 0x00800000,
  ammNode: 0x01000000,
} as const;

/** The `AccountRoot` flags the world sets. */
export const ACCOUNT_FLAGS = { requireAuth: 0x00040000, globalFreeze: 0x00400000, defaultRipple: 0x00800000 } as const;

const NETWORK = getNetworkProfile('xrpl');

/** An account the world names: the same address on every run. */
function addr(name: string): string {
  return encodeAccountID(createHash('sha256').update(`tokens-world:${name}`).digest().subarray(0, 20));
}

/** The order of two accounts as the ledger sees it: by AccountID, not by the text of the address. */
function idOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(decodeAccountID(a)), Buffer.from(decodeAccountID(b)));
}

/** An account whose ID is above `account`'s (so that `account` is the low account of a line between them). */
function above(account: string, tag: string): string {
  for (let k = 0; ; k++) {
    const candidate = addr(`${tag}#${k}`);
    if (idOrder(candidate, account) > 0) return candidate;
  }
}

/** An account whose ID is below `account`'s (so that `account` is the high account of a line between them). */
function below(account: string, tag: string): string {
  for (let k = 0; ; k++) {
    const candidate = addr(`${tag}#${k}`);
    if (idOrder(candidate, account) < 0) return candidate;
  }
}

const negate = (value: string): string => {
  const n = new BigNumber(value);
  return n.isZero() ? '0' : n.negated().toFixed();
};

/** A trust line, from the issuer's side: `held` is what the issuer owes the holder (the holder's balance; below 0 when the holder owes). */
interface Line {
  issuer: string;
  holder: string;
  currency: string;
  held: string;
  holderLimit: string;
  issuerLimit?: string;
  /** The issuer froze the line / authorized the holder. */
  frozen?: boolean;
  authorized?: boolean;
  /** The line is an AMM pool's. */
  amm?: boolean;
}

/** The `RippleState` fields of a line: the low account's balance, both limits and the flags of both sides. */
function fieldsOf(line: Line): Json {
  const issuerIsLow = idOrder(line.issuer, line.holder) < 0;
  const low = issuerIsLow ? line.issuer : line.holder;
  const high = issuerIsLow ? line.holder : line.issuer;
  const issuerLimit = line.issuerLimit ?? '0';
  const lowLimit = issuerIsLow ? issuerLimit : line.holderLimit;
  const highLimit = issuerIsLow ? line.holderLimit : issuerLimit;
  let flags = 0;
  if (lowLimit !== '0') flags |= LSF.lowReserve;
  if (highLimit !== '0') flags |= LSF.highReserve;
  if (line.frozen) flags |= issuerIsLow ? LSF.lowFreeze : LSF.highFreeze;
  if (line.authorized) flags |= issuerIsLow ? LSF.lowAuth : LSF.highAuth;
  if (line.amm) flags |= LSF.ammNode;
  return {
    Balance: { currency: line.currency, issuer: BALANCE_ISSUER, value: issuerIsLow ? negate(line.held) : line.held },
    Flags: flags,
    HighLimit: { currency: line.currency, issuer: high, value: highLimit },
    LowLimit: { currency: line.currency, issuer: low, value: lowLimit },
  };
}

const lineIndex = (line: Line): string =>
  syntheticHash('tokens-world-line', `${line.issuer}:${line.holder}:${line.currency}`);

const createdLine = (line: Line): Json => ({
  CreatedNode: { LedgerEntryType: 'RippleState', LedgerIndex: lineIndex(line), NewFields: fieldsOf(line) },
});

/** The line after the transaction changed `before` to `after` (the same line). */
const modifiedLine = (before: Line, after: Line): Json => ({
  ModifiedNode: {
    LedgerEntryType: 'RippleState',
    LedgerIndex: lineIndex(after),
    FinalFields: fieldsOf(after),
    PreviousFields: { Balance: fieldsOf(before).Balance },
  },
});

/** The line deleted with the final fields `last`. */
const deletedLine = (last: Line): Json => ({
  DeletedNode: {
    LedgerEntryType: 'RippleState',
    LedgerIndex: lineIndex(last),
    FinalFields: fieldsOf(last),
    PreviousFields: { Balance: fieldsOf(last).Balance },
  },
});

interface Root {
  account: string;
  flags: number;
  transferRate?: number;
  sequence: number;
}

const rootFields = (root: Root): Json => ({
  Account: root.account,
  Balance: '50000000',
  Flags: root.flags,
  OwnerCount: 3,
  Sequence: root.sequence,
  ...(root.transferRate === undefined ? {} : { TransferRate: root.transferRate }),
});

const rootIndex = (account: string): string => syntheticHash('tokens-world-root', account);

/** The root of an account changed by an `AccountSet`: `previous` holds the fields that had another value before. */
const modifiedRoot = (root: Root, previous: Json): Json => ({
  ModifiedNode: {
    LedgerEntryType: 'AccountRoot',
    LedgerIndex: rootIndex(root.account),
    FinalFields: rootFields(root),
    PreviousFields: { Sequence: root.sequence - 1, ...previous },
  },
});

const deletedRoot = (root: Root): Json => ({
  DeletedNode: {
    LedgerEntryType: 'AccountRoot',
    LedgerIndex: rootIndex(root.account),
    FinalFields: rootFields(root),
    PreviousFields: { Balance: '50000010' },
  },
});

interface WorldTx {
  type: 'TrustSet' | 'AccountSet' | 'AccountDelete' | 'Clawback' | 'AMMClawback';
  account: string;
  nodes: Json[];
}

const hexOf = (text: string): string => Buffer.from(text, 'latin1').toString('hex').toUpperCase();

/** A `[[CURRENCIES]]` entry of a toml: `fields` is JSON text. */
const entry = (code: string, issuer: string, fields: Json, network = ''): TomlCurrency => ({
  code,
  issuer,
  network,
  fields: JSON.stringify(fields),
});

/** The ledgers of a timeline, `first` the index of the first: the transactions of a ledger in the order given. */
function ledgersOf(first: number, timeline: readonly WorldTx[][]) {
  return timeline.map((txs, n) => {
    const index = first + n;
    return normalizeLedgerResponse({
      ledger_index: index,
      ledger_hash: syntheticHash('tokens-world-ledger', String(index)),
      parent_hash: syntheticHash('tokens-world-ledger', String(index - 1)),
      account_hash: syntheticHash('tokens-world-accounts', String(index)),
      transaction_hash: syntheticHash('tokens-world-transactions', String(index)),
      total_coins: '99999999999000000',
      close_time: 800_000_000 + index * 4,
      close_time_resolution: 10,
      transactions: txs.map((t, i) => ({
        hash: syntheticHash('synthetic-tokens-world', `${index}:${i}`),
        TransactionType: t.type,
        Account: t.account,
        Fee: '10',
        Sequence: 1,
        Flags: 0,
        SigningPubKey: '',
        metaData: { TransactionIndex: i, TransactionResult: 'tesSUCCESS', AffectedNodes: t.nodes },
      })),
    });
  });
}

/** The accounts, currencies and ledgers of the world, for the suites that read it. */
export interface TokensWorld {
  /** The first and the last ledger written. */
  first: number;
  head: number;
  /** The ledgers written, in order. */
  ledgers: number[];
  /** The issuers: `gate` (USD, MYTOKEN; transfer rate and a global freeze; listed by its own domain), `plain` (USD; a domain whose toml lists
   *  other issuers' tokens only), `nodomain` (EUR, BTH; no domain), `nostate` (ABC; no `AccountRoot` in any ledger), `gone` (GON; its
   *  `AccountRoot` is deleted at `first + 4`). */
  gate: string;
  plain: string;
  nodomain: string;
  nostate: string;
  gone: string;
  /** An AMM pool account: a holder of USD of `gate` and of `plain`, and the issuer of an LP token its holder `lpHolder` has. */
  pool: string;
  lpHolder: string;
  /** The currencies, in the ledger's form. */
  usd: string;
  eur: string;
  both: string;
  myToken: string;
  lp: string;
  /** A currency of `nostate` with an amount (1e40) that the exact sums cannot hold: its supply is the Float64 sum. */
  huge: string;
  /** The ledgers of `gate`'s `AccountSet`s: the transfer rate 1.005 is set at `rateFirst`, the rate 1.002 and the global freeze at `rateNow`. */
  rateFirst: number;
  rateNow: number;
  /** The domains of `gate` and `plain`, as `accountDomainOf` gives them, and the flags and rates `gate` ends with. */
  gateDomain: string;
  plainDomain: string;
  gateFlags: number;
  gateRate: number;
  /** How many lines the issuer is the low account of, and the high account of: both are above 0. */
  issuerLow: number;
  issuerHigh: number;
}

export interface TokensWorldOptions {
  /** The first ledger (default 1,000). */
  first?: number;
}

/**
 * Writes the world: its ledgers through `writer` (one batch), then the `account_domains` and `domain_tomls` rows. Returns what the
 * suites need to name its parts.
 */
export async function seedTokensWorld(
  ch: ClickHouseService,
  writer: LedgerWriter,
  o: TokensWorldOptions = {},
): Promise<TokensWorld> {
  const first = o.first ?? 1_000;
  const gate = addr('gate');
  const plain = addr('plain');
  const nodomain = addr('nodomain');
  const nostate = addr('nostate');
  const gone = addr('gone');
  const pool = addr('pool');
  const lpHolder = addr('lp-holder');
  const USD = 'USD';
  const EUR = 'EUR';
  const BTH = 'BTH';
  const myToken = ledgerCurrencyOf('MYTOKEN') as string;
  const lp = `03${'AB'.repeat(19)}`;
  const huge = 'HUG';

  const timeline: WorldTx[][] = Array.from({ length: 6 }, () => []);
  const at = (n: number, tx: WorldTx): void => void timeline[n].push(tx);
  const makes = (n: number, ...lines: Line[]): void =>
    lines.forEach((line) => at(n, { type: 'TrustSet', account: line.holder, nodes: [createdLine(line)] }));
  const changes = (n: number, before: Line, after: Line): void =>
    at(n, { type: 'TrustSet', account: after.holder, nodes: [modifiedLine(before, after)] });

  let issuerLow = 0;
  let issuerHigh = 0;
  const count = (line: Line): Line => {
    if (idOrder(line.issuer, line.holder) < 0) issuerLow++;
    else issuerHigh++;
    return line;
  };
  const usd = (holder: string, held: string, holderLimit: string, more: Partial<Line> = {}): Line =>
    count({ issuer: gate, holder, currency: USD, held, holderLimit, ...more });

  // -- gate's USD: every case of Task 3's table, from both sides ------------------------------------------------------------
  const gU1 = usd(above(gate, 'gU1'), '100.5', '1000');
  const gU2 = usd(below(gate, 'gU2'), '250', '1000');
  // a small balance, and two that a float sum cannot hold together: 1e15 + 1e-15 has 31 digits
  const gU3 = usd(above(gate, 'gU3'), '0.0000001', '10');
  const gU4 = usd(below(gate, 'gU4'), '1000000000000000', '10000000000000000');
  const gU5 = usd(above(gate, 'gU5'), '0.000000000000001', '10');
  // a zero balance with a limit of the holder's counts; with none, and no limit of the issuer's, it does not
  const gU6 = usd(below(gate, 'gU6'), '0', '50');
  const gU8 = usd(above(gate, 'gU8'), '0', '0');
  // the issuer extends credit and the holder does not: the line counts for the holder's token (USD of gU7) only
  const gU7: Line = count({
    issuer: gate,
    holder: below(gate, 'gU7'),
    currency: USD,
    held: '0',
    holderLimit: '0',
    issuerLimit: '100',
  });
  // a balance owed counts without a limit
  const gU9 = usd(above(gate, 'gU9'), '5', '0');
  // a balance that changes twice: the newest wins
  const gU10 = usd(below(gate, 'gU10'), '10', '100');
  const gU10b = { ...gU10, held: '40' };
  const gU10c = { ...gU10, held: '25' };
  // a line deleted with a balance still showing in its final fields (the pass must not count it), one deleted and made again
  const gU11 = usd(above(gate, 'gU11'), '9', '100');
  const gU12 = usd(below(gate, 'gU12'), '30', '100');
  const gU12b = { ...gU12, held: '12' };
  const gU13 = usd(above(gate, 'gU13'), '8', '100');
  // turned round: the holder now owes the issuer, so the line counts for the holder's token
  const gU13b = { ...gU13, held: '-6' };
  const gU14 = usd(below(gate, 'gU14'), '3', '100', { frozen: true });
  const gU15 = usd(above(gate, 'gU15'), '4', '100', { authorized: true });
  const bulk = Array.from({ length: 12 }, (_, k) =>
    usd(k % 2 === 0 ? above(gate, `bulk${k}`) : below(gate, `bulk${k}`), String(k + 1), '500'),
  );
  const gM1: Line = count({
    issuer: gate,
    holder: above(gate, 'gM1'),
    currency: myToken,
    held: '12.34',
    holderLimit: '1000',
  });
  const gM2: Line = count({ issuer: gate, holder: below(gate, 'gM2'), currency: myToken, held: '0', holderLimit: '5' });
  const gBoth: Line = count({
    issuer: gate,
    holder: nodomain,
    currency: BTH,
    held: '0',
    holderLimit: '20',
    issuerLimit: '10',
  });

  // -- the other issuers ---------------------------------------------------------------------------------------------------
  const pU1: Line = count({ issuer: plain, holder: above(plain, 'pU1'), currency: USD, held: '1', holderLimit: '100' });
  const pU2: Line = count({ issuer: plain, holder: below(plain, 'pU2'), currency: USD, held: '0', holderLimit: '10' });
  const pU1b = { ...pU1, held: '2' };
  const nE1: Line = count({
    issuer: nodomain,
    holder: above(nodomain, 'nE1'),
    currency: EUR,
    held: '7.25',
    holderLimit: '100',
  });
  const nE2: Line = count({
    issuer: nodomain,
    holder: below(nodomain, 'nE2'),
    currency: EUR,
    held: '3',
    holderLimit: '100',
  });
  const sA1: Line = count({
    issuer: nostate,
    holder: above(nostate, 'sA1'),
    currency: 'ABC',
    held: '9',
    holderLimit: '100',
  });
  const sA2: Line = count({
    issuer: nostate,
    holder: below(nostate, 'sA2'),
    currency: 'ABC',
    held: '1',
    holderLimit: '100',
  });
  // 1e40 is above the 1e36 that the exact sums hold, so the supply of HUG is the Float64 sum: 1e40 and 5 make 1e40
  const hugeA: Line = count({
    issuer: nostate,
    holder: above(nostate, 'hugeA'),
    currency: huge,
    held: '1e40',
    holderLimit: '1000',
  });
  const hugeB: Line = count({
    issuer: nostate,
    holder: below(nostate, 'hugeB'),
    currency: huge,
    held: '5',
    holderLimit: '1000',
  });
  const xG1: Line = count({ issuer: gone, holder: above(gone, 'xG1'), currency: 'GON', held: '2', holderLimit: '100' });
  const poolGate: Line = count({
    issuer: gate,
    holder: pool,
    currency: USD,
    held: '5000',
    holderLimit: '0',
    amm: true,
  });
  const poolPlain: Line = count({
    issuer: plain,
    holder: pool,
    currency: USD,
    held: '700',
    holderLimit: '0',
    amm: true,
  });
  // the LP token: it counts for nothing (the pool is its issuer, its holder holds 100)
  const lpLine: Line = { issuer: pool, holder: lpHolder, currency: lp, held: '100', holderLimit: '1000000', amm: true };

  // -- first: flags, then lines ---------------------------------------------------------------------------------------------
  const gateRoot = (sequence: number, flags: number, transferRate?: number): Root => ({
    account: gate,
    flags,
    sequence,
    transferRate,
  });
  at(0, {
    type: 'AccountSet',
    account: gate,
    nodes: [modifiedRoot(gateRoot(11, ACCOUNT_FLAGS.defaultRipple), { Flags: 0 })],
  });
  at(0, {
    type: 'AccountSet',
    account: plain,
    nodes: [modifiedRoot({ account: plain, flags: ACCOUNT_FLAGS.defaultRipple, sequence: 5 }, { Flags: 0 })],
  });
  at(0, {
    type: 'AccountSet',
    account: nodomain,
    nodes: [modifiedRoot({ account: nodomain, flags: ACCOUNT_FLAGS.requireAuth, sequence: 5 }, { Flags: 0 })],
  });
  at(0, {
    type: 'AccountSet',
    account: gone,
    nodes: [modifiedRoot({ account: gone, flags: ACCOUNT_FLAGS.defaultRipple, sequence: 5 }, { Flags: 0 })],
  });
  makes(0, gU1, gU2, gU3, gU4, gU5, gU6, gU7, gU8, gU9, gU10, gU11, gU12, gU13, xG1, pU1, nE1, sA1);

  // -- first + 1: a transfer rate; more lines -------------------------------------------------------------------------------
  at(1, {
    type: 'AccountSet',
    account: gate,
    // a field set for the first time is in FinalFields alone
    nodes: [modifiedRoot(gateRoot(12, ACCOUNT_FLAGS.defaultRipple, 1_005_000_000), {})],
  });
  makes(1, gU14, gU15, ...bulk, gM1, gM2, gBoth, pU2, nE2, sA2);

  // -- first + 2: balances change; lines are deleted; one turns round ------------------------------------------------------
  changes(2, gU10, gU10b);
  at(2, { type: 'TrustSet', account: gU11.holder, nodes: [deletedLine(gU11)] });
  at(2, { type: 'TrustSet', account: gU12.holder, nodes: [deletedLine(gU12)] });
  changes(2, gU13, gU13b);

  // -- first + 3: the rate goes down and gate freezes globally -------------------------------------------------------------
  at(3, {
    type: 'AccountSet',
    account: gate,
    nodes: [
      modifiedRoot(gateRoot(13, ACCOUNT_FLAGS.defaultRipple | ACCOUNT_FLAGS.globalFreeze, 1_002_000_000), {
        Flags: ACCOUNT_FLAGS.defaultRipple,
        TransferRate: 1_005_000_000,
      }),
    ],
  });
  changes(3, gU10b, gU10c);

  // -- first + 4: a line made again; the pool; gone is deleted -------------------------------------------------------------
  makes(4, gU12b, poolGate, poolPlain, lpLine);
  at(4, {
    type: 'AccountDelete',
    account: gone,
    nodes: [deletedRoot({ account: gone, flags: ACCOUNT_FLAGS.defaultRipple, sequence: 6 })],
  });

  // -- first + 5: the head --------------------------------------------------------------------------------------------------
  changes(5, pU1, pU1b);
  makes(5, hugeA, hugeB);

  const ledgers = ledgersOf(first, timeline);
  await writer.write(ledgers);

  // -- the domains of the issuers and their tomls, written the way D4's workers do --------------------------------------------
  const gateDomain = 'gateway.example';
  const plainDomain = 'plain.example';
  const version = (ledger: number, tx: number): string => String((BigInt(ledger) << 32n) | (BigInt(tx) << 16n));
  const domainRow = (account: string, text: string, ledger: number, deleted = 0): AccountDomainsRow => ({
    account,
    ledger_index: ledger,
    tx_index: 0,
    node_index: 0,
    version: version(ledger, 0),
    domain_hex: hexOf(text),
    deleted,
  });
  await ch.insert(Table.AccountDomains, [
    // the Domain field holds capitals: the domain is the lower-case text
    domainRow(gate, 'Gateway.Example', first),
    domainRow(plain, plainDomain, first),
    // nodomain named a domain, then took it back (the newer row is the word)
    domainRow(nodomain, 'old.example', first),
    domainRow(nodomain, 'old.example', first + 1, 1),
  ]);

  const tomlRow = (domain: string, currencies: TomlCurrency[]): DomainTomlsRow =>
    okTomlRow({
      domain,
      tomlUrl: tomlUrlOf(domain, NETWORK),
      content: { modified: null, expires: null, accounts: [], currencies, validators: [], principals: [] },
      now: 1_700_000_000.5,
      recheckMs: 3_600_000,
    });
  await ch.insert(Table.DomainTomls, [
    tomlRow(gateDomain, [
      entry('USD', gate, {
        name: 'Gateway Dollar',
        icon: 'https://gateway.example/usd.png',
        display_decimals: 2,
        ignored: 'not served',
      }),
      entry('MYTOKEN', gate, { name: 'My Token', symbol: 'MYT' }),
    ]),
    // plain's toml lists the tokens of others and not its own USD
    tomlRow(plainDomain, [
      entry('USD', gate, { name: 'Gate dollar, as plain says' }),
      entry('EUR', nodomain, { name: 'Euro, as plain says' }),
    ]),
  ]);

  return {
    first,
    head: first + timeline.length - 1,
    ledgers: timeline.map((_, n) => first + n),
    gate,
    plain,
    nodomain,
    nostate,
    gone,
    pool,
    lpHolder,
    usd: USD,
    eur: EUR,
    both: BTH,
    myToken,
    lp,
    huge,
    rateFirst: first + 1,
    rateNow: first + 3,
    gateDomain,
    plainDomain,
    gateFlags: ACCOUNT_FLAGS.defaultRipple | ACCOUNT_FLAGS.globalFreeze,
    gateRate: 1_002_000_000,
    issuerLow,
    issuerHigh,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The second batch
// ---------------------------------------------------------------------------------------------------------------------

/** What the second batch of the world did, by the ledger it did it in (`first` is its first ledger, the world's head + 1). */
export interface TokensWorldLater {
  first: number;
  head: number;
  ledgers: number[];
  /** The holders of gate's USD whose lines change, and the ledgers they change in:
   *  - `changedTwice`: 100.5 becomes 150 at `first` and 180 at `first + 2`;
   *  - `turnedRound`: 250 becomes -4 at `first + 1` (the holder now owes gate: the line counts for the holder's token) and 7 at `first + 3`;
   *  - `emptied`: 5 becomes 0 at `first + 1`, and the holder's limit is 0, so the line counts no more;
   *  - `deleted`: the line is deleted at `first`;
   *  - `made`: a line of 77 is made at `first`. */
  changedTwice: string;
  turnedRound: string;
  emptied: string;
  deleted: string;
  made: string;
  /** The currency `plain` issues from `first` on, and the holder of its one line. */
  newCurrency: string;
  newHolder: string;
  /** The ledgers and rates of gate's `AccountSet`s: the rate goes up twice. */
  rateSteps: Array<{ ledger: number; rate: number }>;
}

/**
 * Writes the second batch of the world, four ledgers after its head, through `writer`: the first batch is untouched, so the suites
 * that read it keep their numbers at `world.head`. What it does is on `TokensWorldLater`; it is what the touches of a window
 * apply: a line changed in two ledgers, a line turned round (and back), emptied and deleted, a line and a token made, an
 * issuer whose transfer rate changes twice (`gate`), and an issuer with no `AccountRoot` whose line changes (`nostate`).
 */
export async function seedTokensWorldLater(writer: LedgerWriter, world: TokensWorld): Promise<TokensWorldLater> {
  const first = world.head + 1;
  const { gate, plain, nostate } = world;
  const NEW = 'NEW';

  const timeline: WorldTx[][] = Array.from({ length: 4 }, () => []);
  const at = (n: number, tx: WorldTx): void => void timeline[n].push(tx);
  const makes = (n: number, line: Line): void =>
    at(n, { type: 'TrustSet', account: line.holder, nodes: [createdLine(line)] });
  const changes = (n: number, before: Line, held: string): Line => {
    const after = { ...before, held };
    at(n, { type: 'TrustSet', account: after.holder, nodes: [modifiedLine(before, after)] });
    return after;
  };
  const deletes = (n: number, last: Line): void =>
    at(n, { type: 'TrustSet', account: last.holder, nodes: [deletedLine(last)] });
  const sets = (n: number, sequence: number, rate: number, before: number): void =>
    at(n, {
      type: 'AccountSet',
      account: gate,
      nodes: [
        modifiedRoot({ account: gate, flags: world.gateFlags, sequence, transferRate: rate }, { TransferRate: before }),
      ],
    });

  // the lines of the first batch that change, as that batch made them
  const usd = (holder: string, held: string, holderLimit: string): Line => ({
    issuer: gate,
    holder,
    currency: world.usd,
    held,
    holderLimit,
  });
  const gU1 = usd(above(gate, 'gU1'), '100.5', '1000');
  const gU2 = usd(below(gate, 'gU2'), '250', '1000');
  const gU3 = usd(above(gate, 'gU3'), '0.0000001', '10');
  const gU9 = usd(above(gate, 'gU9'), '5', '0');
  const sA1: Line = { issuer: nostate, holder: above(nostate, 'sA1'), currency: 'ABC', held: '9', holderLimit: '100' };
  const gU16 = usd(above(gate, 'gU16'), '77', '100');
  const pN1: Line = { issuer: plain, holder: above(plain, 'pN1'), currency: NEW, held: '3', holderLimit: '50' };

  // first: a balance changes (and again at first + 2); a line is deleted; two are made; the rate goes up
  sets(0, 14, 1_010_000_000, world.gateRate);
  const gU1b = changes(0, gU1, '150');
  deletes(0, gU3);
  makes(0, gU16);
  makes(0, pN1);

  // first + 1: a line turns round; one is emptied with no limit
  const gU2b = changes(1, gU2, '-4');
  changes(1, gU9, '0');

  // first + 2: the balance changes again; the rate goes up again; the issuer with no root has a line change
  changes(2, gU1b, '180');
  sets(2, 15, 1_015_000_000, 1_010_000_000);
  changes(2, sA1, '12');

  // first + 3: the line that turned round turns back
  changes(3, gU2b, '7');

  const ledgers = ledgersOf(first, timeline);
  await writer.write(ledgers);
  return {
    first,
    head: first + timeline.length - 1,
    ledgers: timeline.map((_, n) => first + n),
    changedTwice: gU1.holder,
    turnedRound: gU2.holder,
    emptied: gU9.holder,
    deleted: gU3.holder,
    made: gU16.holder,
    newCurrency: NEW,
    newHolder: pN1.holder,
    rateSteps: [
      { ledger: first, rate: 1_010_000_000 },
      { ledger: first + 2, rate: 1_015_000_000 },
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The token history's world
// ---------------------------------------------------------------------------------------------------------------------

/** The world of the token history's suites: the tokens world, its second batch, and one ledger more (`clawbackLedger`, the head);
 *  `ledgers` holds all of them. */
export interface TokenHistoryWorld extends TokensWorld {
  /** The second batch (`seedTokensWorldLater`). */
  later: TokensWorldLater;
  /** The ledger after the second batch, the world's head: a `Clawback`, an `AMMClawback`, and the first row of `preexisting`. */
  clawbackLedger: number;
  /** The holder of gate's USD that gate claws back 3 of (4 becomes 1), and the pool, which an `AMMClawback` takes 100 from (5000
   *  becomes 4900). */
  clawedHolder: string;
  /** A holder of gate's USD whose line the world never makes: its first row is a `ModifiedNode` (20 becomes 25). */
  preexisting: string;
}

/**
 * Writes the tokens world, its second batch and one more ledger through `writer`, for the token history's suites: a `Clawback` and
 * an `AMMClawback` (whose changes are clawed back), and a line whose first row is not its creation. `head` is that last ledger.
 */
export async function seedTokenHistoryWorld(
  ch: ClickHouseService,
  writer: LedgerWriter,
  o: TokensWorldOptions = {},
): Promise<TokenHistoryWorld> {
  const world = await seedTokensWorld(ch, writer, o);
  const later = await seedTokensWorldLater(writer, world);
  const { gate, pool } = world;
  const clawed: Line = {
    issuer: gate,
    holder: above(gate, 'gU15'),
    currency: world.usd,
    held: '4',
    holderLimit: '100',
    authorized: true,
  };
  const pooled: Line = { issuer: gate, holder: pool, currency: world.usd, held: '5000', holderLimit: '0', amm: true };
  const pre: Line = { issuer: gate, holder: below(gate, 'pre'), currency: world.usd, held: '20', holderLimit: '100' };
  const clawbackLedger = later.head + 1;
  const [ledger] = ledgersOf(clawbackLedger, [
    [
      { type: 'Clawback', account: gate, nodes: [modifiedLine(clawed, { ...clawed, held: '1' })] },
      { type: 'AMMClawback', account: gate, nodes: [modifiedLine(pooled, { ...pooled, held: '4900' })] },
      { type: 'TrustSet', account: pre.holder, nodes: [modifiedLine(pre, { ...pre, held: '25' })] },
    ],
  ]);
  await writer.write([ledger]);
  return {
    ...world,
    head: clawbackLedger,
    ledgers: [...world.ledgers, ...later.ledgers, clawbackLedger],
    later,
    clawbackLedger,
    clawedHolder: clawed.holder,
    preexisting: pre.holder,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------------------------------------------------

/** The key a token has in the oracle's maps. */
export const tokenMapKey = (token: TokenKey): string => `${token.issuer} ${token.currency}`;

/** The key a line has in the oracle's maps. */
export const lineMapKey = (token: TokenKey, holder: string): string => `${tokenMapKey(token)} ${holder}`;

interface StateRow {
  account: string;
  counterparty: string;
  currency: string;
  ledger_index: number;
  balance: string;
  limit: string;
  limit_peer: string;
  authorized: number;
  peer_authorized: number;
  freeze: number;
  peer_freeze: number;
  deleted: number;
}

/** A line that counts, with the token it is a line of. */
export interface BruteForceLine {
  token: TokenKey;
  line: WantedTokenLine;
}

/**
 * What every `token_lines` row should say at `head`: the newest state of each line of `trust_line_states` at or before it, from
 * both of its sides, with spec 1 applied in TypeScript (`orientations`), keyed by `lineMapKey`. The two sides of a line must
 * agree: the oracle throws when they do not, so that a mistake of the world shows as one.
 */
export async function bruteForceLines(ch: ClickHouseService, head: number): Promise<Map<string, BruteForceLine>> {
  const rows = await ch.query<StateRow>(
    `SELECT account, counterparty, currency, ledger_index, balance, \`limit\`, limit_peer, authorized, peer_authorized,
            freeze, peer_freeze, deleted
       FROM ${Table.TrustLineStates}
      WHERE ledger_index <= {head:UInt32}
      ORDER BY account, counterparty, currency, ledger_index, tx_index, node_index`,
    { head },
  );
  // the newest row of each (account, counterparty, currency): the rows come in the order of the state changes
  const newest = new Map<string, StateRow>();
  for (const row of rows) newest.set(JSON.stringify([row.account, row.counterparty, row.currency]), row);

  const wanted = new Map<string, BruteForceLine>();
  for (const row of newest.values()) {
    const state: LowSideLine = {
      account: row.account,
      counterparty: row.counterparty,
      currency: row.currency,
      balance: row.balance,
      limit: row.limit,
      limit_peer: row.limit_peer,
      authorized: row.authorized === 1,
      peer_authorized: row.peer_authorized === 1,
      freeze: row.freeze === 1,
      peer_freeze: row.peer_freeze === 1,
      ledger_index: row.ledger_index,
      deleted: row.deleted === 1,
    };
    for (const { token, wanted: line } of orientations(state)) {
      if (line === null) continue;
      const key = lineMapKey(token, line.holder);
      const seen = wanted.get(key);
      // each row is one side of the line and sees the same two tokens, so a second sighting must say the same
      if (seen !== undefined && JSON.stringify(seen.line) !== JSON.stringify(line)) {
        throw new Error(
          `the two sides of the line ${key} disagree: ${JSON.stringify(seen.line)} and ${JSON.stringify(line)}`,
        );
      }
      wanted.set(key, { token, line });
    }
  }
  return wanted;
}

/** The counts and the supply of a token. */
export interface BruteForceToken {
  holders: number;
  trust_lines: number;
  supply: string;
}

/** Whether `Decimal256(30)` holds an amount whole (`exactAmount`): at most 30 decimal places and below 1e36. */
const fitsExactSum = (balance: string): boolean => {
  const n = new BigNumber(balance);
  return (n.decimalPlaces() ?? 0) <= 30 && n.isLessThan('1e36');
};

/**
 * The tokens at `head`, counted the plain way: the lines of `bruteForceLines` per token, the holders those with a balance above 0, the
 * supply the exact sum of their balances (BigNumber). A token with a balance that the exact sums cannot hold (more than 30 decimal
 * places, or 1e36 and above) has the Float64 sum of its balances instead, as `sumOf` gives it. Keyed by `tokenMapKey`; a token with no
 * line that counts is not in it.
 */
export async function bruteForceTokens(ch: ClickHouseService, head: number): Promise<Map<string, BruteForceToken>> {
  const tokens = new Map<
    string,
    { holders: number; trust_lines: number; supply: BigNumber; float: number; fits: boolean }
  >();
  for (const { token, line } of (await bruteForceLines(ch, head)).values()) {
    const key = tokenMapKey(token);
    const sums = tokens.get(key) ?? { holders: 0, trust_lines: 0, supply: new BigNumber(0), float: 0, fits: true };
    sums.trust_lines += 1;
    if (new BigNumber(line.balance).isGreaterThan(0)) sums.holders += 1;
    sums.supply = sums.supply.plus(line.balance);
    sums.float += Number(line.balance);
    sums.fits &&= fitsExactSum(line.balance);
    tokens.set(key, sums);
  }
  return new Map(
    [...tokens].map(([key, sums]) => [
      key,
      {
        holders: sums.holders,
        trust_lines: sums.trust_lines,
        supply: sums.fits ? sums.supply.toFixed() : new BigNumber(sums.float).toFixed(),
      },
    ]),
  );
}
