import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { RawLedger, RawTransaction } from '../ingest/raw-ledger';
import { mptIssuerOf } from '../util/mpt';

/**
 * Guards `test/fixtures/xrpl/mpt` and `test/fixtures/xrpl-testnet/mpt`: the named MPT cases the parser tasks build on.
 * `xrpl/mpt/FINDINGS.md` says what each fact rests on and names the cases that were not found on the network (the tests that
 * need one use a named synthetic). The checks here pin what each case is chosen for, so that a re-recording that picks another
 * transaction cannot change it silently.
 */
const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');
const MAINNET_DIR = join(FIXTURES, 'xrpl', 'mpt');
const TESTNET_DIR = join(FIXTURES, 'xrpl-testnet', 'mpt');
const FINDINGS = join(MAINNET_DIR, 'FINDINGS.md');

/** MPTokensV1, fixMPTDeliveredAmount with fixTokenEscrowV1, and TokenEscrow, on mainnet. */
const MPT_TOKENS_V1_LEDGER = 99226369;
const DELIVERED_FIX_LEDGER = 101852417;
const TOKEN_ESCROW_LEDGER = 102204929;
const ENABLE_LEDGERS = [MPT_TOKENS_V1_LEDGER, DELIVERED_FIX_LEDGER, TOKEN_ESCROW_LEDGER];

interface Case {
  ledger: number;
  hash: string;
}

interface Manifest {
  cases?: Record<string, Case>;
  ledgers: { ledger: number; gzipBytes?: number }[];
}

const manifestOf = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;

/** The cases of a directory; the testnet directory exists only when a case had to come from there. */
const casesOf = (dir: string): Record<string, Case> => (existsSync(dir) ? (manifestOf(dir).cases ?? {}) : {});

const mainnetCases = (): Record<string, Case> => casesOf(MAINNET_DIR);
const testnetCases = (): Record<string, Case> => casesOf(TESTNET_DIR);

/** The directory that holds a case: mainnet first. Undefined for a case that was not found. */
const dirOf = (name: string): string | undefined => {
  if (name in mainnetCases()) return MAINNET_DIR;
  if (name in testnetCases()) return TESTNET_DIR;
  return undefined;
};

const sources = new Map<string, FixtureLedgerSource>();
const sourceOf = (dir: string): FixtureLedgerSource => {
  let source = sources.get(dir);
  if (source === undefined) {
    source = FixtureLedgerSource.fromDir(dir);
    sources.set(dir, source);
  }
  return source;
};
const ledgerOf = (dir: string, index: number): RawLedger | undefined =>
  sourceOf(dir)
    .list()
    .find((ledger) => ledger.header.ledger_index === index);

/** A case's transaction, read from the ledger the manifest names. */
function recorded(name: string): RawTransaction {
  const dir = dirOf(name);
  if (dir === undefined) throw new Error(`${name} is not recorded`);
  const { ledger, hash } = casesOf(dir)[name];
  const found = ledgerOf(dir, ledger)?.transactions.find((t) => t.hash === hash);
  if (found === undefined) throw new Error(`${name}: ledger ${ledger} does not hold ${hash}`);
  return found;
}

/** A ledger node with its fields after the transaction (`FinalFields` or `NewFields`) and its `PreviousFields`. */
interface Node {
  op: 'CreatedNode' | 'ModifiedNode' | 'DeletedNode';
  type: string;
  after: Record<string, unknown>;
  previous?: Record<string, unknown>;
}

function nodesOf(t: RawTransaction, type?: string): Node[] {
  return (t.meta.AffectedNodes as Record<string, Record<string, unknown>>[])
    .map((entry) => {
      const op = Object.keys(entry)[0] as Node['op'];
      const body = entry[op] as Record<string, unknown>;
      return {
        op,
        type: body.LedgerEntryType as string,
        after: { ...(body.FinalFields as object), ...(body.NewFields as object) },
        previous: body.PreviousFields as Record<string, unknown> | undefined,
      };
    })
    .filter((node) => type === undefined || node.type === type);
}

const isMptAmount = (amount: unknown): amount is { mpt_issuance_id: string; value: string } =>
  typeof amount === 'object' &&
  amount !== null &&
  typeof (amount as Record<string, unknown>).mpt_issuance_id === 'string';
const isIssuedAmount = (amount: unknown): boolean =>
  typeof amount === 'object' && amount !== null && !isMptAmount(amount) && 'currency' in amount;

/** The escrow's amount, from the `Escrow` node the transaction deleted. */
const deletedEscrowAmount = (t: RawTransaction): unknown =>
  nodesOf(t, 'Escrow').find((node) => node.op === 'DeletedNode')?.after.Amount;

/** The metadata as JSON, or undefined when the hex is not a JSON object. */
function metadataOf(t: RawTransaction): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(Buffer.from(String(t.tx.MPTokenMetadata), 'hex').toString('utf8')) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const flagsOf = (t: RawTransaction): number => (t.tx.Flags as number | undefined) ?? 0;
const TF_MPT_LOCK = 1;
const TF_MPT_UNLOCK = 2;
const TF_MPT_UNAUTHORIZE = 1;

/** Long keys are XLS-89's `ticker` and `name`, short ones its `t` and `n`. */
const hasLongKeys = (t: RawTransaction): boolean => {
  const metadata = metadataOf(t);
  return metadata !== undefined && ('ticker' in metadata || 'name' in metadata);
};
const hasShortKeys = (t: RawTransaction): boolean => {
  const metadata = metadataOf(t);
  return metadata !== undefined && ('t' in metadata || 'n' in metadata);
};

const issuerOfAmount = (t: RawTransaction): string =>
  mptIssuerOf((t.tx.Amount as { mpt_issuance_id: string }).mpt_issuance_id);

/** The holder's `MPToken` node of a clawback. */
const holderToken = (t: RawTransaction): Node | undefined =>
  nodesOf(t, 'MPToken').find((node) => node.after.Account === t.tx.Holder);

interface Rule {
  type: string;
  /** Holds `tesSUCCESS` unless a case says otherwise. */
  result?: RegExp;
  /** What the transaction shows beyond its type. */
  shows: (t: RawTransaction) => boolean;
}

const RULES: Record<string, Rule> = {
  issuance_create: {
    type: 'MPTokenIssuanceCreate',
    shows: (t) => hasLongKeys(t),
  },
  issuance_create_short_keys: {
    type: 'MPTokenIssuanceCreate',
    shows: (t) => hasShortKeys(t) && !hasLongKeys(t),
  },
  issuance_create_raw_metadata: {
    type: 'MPTokenIssuanceCreate',
    shows: (t) => typeof t.tx.MPTokenMetadata === 'string' && metadataOf(t) === undefined,
  },
  issuance_create_no_max: {
    type: 'MPTokenIssuanceCreate',
    shows: (t) => t.tx.MaximumAmount === undefined,
  },
  issuance_set_lock_holder: {
    type: 'MPTokenIssuanceSet',
    shows: (t) => (flagsOf(t) & TF_MPT_LOCK) !== 0 && t.tx.Holder !== undefined,
  },
  issuance_set_unlock_holder: {
    type: 'MPTokenIssuanceSet',
    shows: (t) => (flagsOf(t) & TF_MPT_UNLOCK) !== 0 && t.tx.Holder !== undefined,
  },
  issuance_set_lock_all: {
    type: 'MPTokenIssuanceSet',
    shows: (t) => (flagsOf(t) & TF_MPT_LOCK) !== 0 && t.tx.Holder === undefined,
  },
  issuance_destroy: {
    type: 'MPTokenIssuanceDestroy',
    shows: (t) => nodesOf(t, 'MPTokenIssuance').some((node) => node.op === 'DeletedNode'),
  },
  authorize_holder: {
    type: 'MPTokenAuthorize',
    shows: (t) => t.tx.Holder === undefined && (flagsOf(t) & TF_MPT_UNAUTHORIZE) === 0,
  },
  authorize_by_issuer: {
    type: 'MPTokenAuthorize',
    shows: (t) => t.tx.Holder !== undefined,
  },
  unauthorize_holder: {
    type: 'MPTokenAuthorize',
    shows: (t) => (flagsOf(t) & TF_MPT_UNAUTHORIZE) !== 0,
  },
  payment_holder_to_holder: {
    type: 'Payment',
    shows: (t) =>
      isMptAmount(t.tx.Amount) && t.tx.Account !== issuerOfAmount(t) && t.tx.Destination !== issuerOfAmount(t),
  },
  payment_mint: {
    type: 'Payment',
    shows: (t) => isMptAmount(t.tx.Amount) && t.tx.Account === issuerOfAmount(t),
  },
  payment_redeem: {
    type: 'Payment',
    shows: (t) => isMptAmount(t.tx.Amount) && t.tx.Destination === issuerOfAmount(t),
  },
  payment_transfer_fee: {
    type: 'Payment',
    shows: (t) => isMptAmount(t.tx.Amount) && isMptAmount(t.tx.SendMax),
  },
  payment_before_delivered_fix: {
    type: 'Payment',
    shows: (t) => isMptAmount(t.tx.Amount),
  },
  payment_failed: {
    type: 'Payment',
    result: /^tec/,
    shows: (t) => isMptAmount(t.tx.Amount),
  },
  clawback_full: {
    type: 'Clawback',
    shows: (t) =>
      isMptAmount(t.tx.Amount) && t.tx.Holder !== undefined && (holderToken(t)?.after.MPTAmount ?? '0') === '0',
  },
  clawback_partial: {
    type: 'Clawback',
    shows: (t) =>
      isMptAmount(t.tx.Amount) && t.tx.Holder !== undefined && (holderToken(t)?.after.MPTAmount ?? '0') !== '0',
  },
  clawback_issued: {
    type: 'Clawback',
    shows: (t) => isIssuedAmount(t.tx.Amount),
  },
  escrow_create: {
    type: 'EscrowCreate',
    shows: (t) => isMptAmount(t.tx.Amount),
  },
  escrow_finish: {
    type: 'EscrowFinish',
    shows: (t) => isMptAmount(deletedEscrowAmount(t)),
  },
  escrow_cancel: {
    type: 'EscrowCancel',
    shows: (t) => isMptAmount(deletedEscrowAmount(t)),
  },
  // For the fee fact of spec 4.2. Only XRPL Testnet has them: no mainnet escrow read has a `TransferRate`.
  escrow_create_transfer_fee: {
    type: 'EscrowCreate',
    shows: (t) => isMptAmount(t.tx.Amount) && nodesOf(t, 'Escrow')[0]?.after.TransferRate !== undefined,
  },
  escrow_finish_transfer_fee: {
    type: 'EscrowFinish',
    shows: (t) => isMptAmount(deletedEscrowAmount(t)) && nodesOf(t, 'Escrow')[0]?.after.TransferRate !== undefined,
  },
  escrow_finish_creates_token: {
    type: 'EscrowFinish',
    shows: (t) =>
      isMptAmount(deletedEscrowAmount(t)) &&
      nodesOf(t, 'MPToken').some((node) => node.op === 'CreatedNode' && node.after.MPTAmount !== undefined),
  },
};

const CASE_NAMES = Object.keys(RULES);

describe('recorded MPT cases', () => {
  it('lists every case, or names it in FINDINGS as not found', () => {
    const findings = readFileSync(FINDINGS, 'utf8');
    const missing = CASE_NAMES.filter(
      (name) => dirOf(name) === undefined && !new RegExp(`^- ${name}: not found \\(.+\\)`, 'm').test(findings),
    );
    expect(missing).toEqual([]);
  });

  it('has no case the list does not name', () => {
    const names = [...Object.keys(mainnetCases()), ...Object.keys(testnetCases())];
    expect(names.filter((name) => !(name in RULES))).toEqual([]);
  });

  it.each(CASE_NAMES)('each case is its transaction: %s', (name) => {
    if (dirOf(name) === undefined) return; // named in FINDINGS: the test above holds it
    const rule = RULES[name];
    const t = recorded(name);
    expect(t.tx.TransactionType).toBe(rule.type);
    expect(t.meta.TransactionResult).toMatch(rule.result ?? /^tesSUCCESS$/);
    expect(rule.shows(t)).toBe(true);
  });

  it('keeps the ledgers each case is dated by', () => {
    const cases = mainnetCases();
    if ('payment_before_delivered_fix' in cases) {
      expect(cases.payment_before_delivered_fix.ledger).toBeLessThan(DELIVERED_FIX_LEDGER);
    }
    for (const name of ['escrow_create', 'escrow_finish', 'escrow_cancel']) {
      if (name in cases) expect(cases[name].ledger).toBeGreaterThanOrEqual(TOKEN_ESCROW_LEDGER);
    }

    const recordedLedgers = manifestOf(MAINNET_DIR).ledgers.map((entry) => entry.ledger);
    for (const index of ENABLE_LEDGERS) {
      expect(recordedLedgers).toContain(index);
      const enables = ledgerOf(MAINNET_DIR, index)?.transactions.filter(
        (t) => t.tx.TransactionType === 'EnableAmendment' && flagsOf(t) === 0,
      );
      expect(enables?.length).toBeGreaterThan(0);
    }
  });

  // What the parser's "before" rests on: an added field is not listed, and `PreviousFields` can be present and empty.
  describe('an added field is not in PreviousFields', () => {
    const tokenOf = (t: RawTransaction, account: unknown): Node => {
      const node = nodesOf(t, 'MPToken').find((candidate) => candidate.after.Account === account);
      if (node === undefined) throw new Error(`no MPToken of ${String(account)}`);
      return node;
    };
    const issuanceOf = (t: RawTransaction): Node => nodesOf(t, 'MPTokenIssuance')[0];

    it("a holder's first credit: payment_mint", () => {
      const t = recorded('payment_mint');
      const token = tokenOf(t, t.tx.Destination);
      expect(token.op).toBe('ModifiedNode');
      expect(token.previous).toEqual({});
      expect(token.after.MPTAmount).toBe((t.tx.Amount as { value: string }).value);
    });

    it("a destination's first credit: escrow_finish", () => {
      const t = recorded('escrow_finish');
      const escrow = nodesOf(t, 'Escrow')[0];
      const token = tokenOf(t, escrow.after.Destination);
      expect(token.previous).toEqual({});
      expect(token.after.MPTAmount).toBe((escrow.after.Amount as { value: string }).value);
    });

    it('a first escrow, on the holder and on the issuance: escrow_create', () => {
      const t = recorded('escrow_create');
      const amount = (t.tx.Amount as { value: string }).value;
      const token = tokenOf(t, t.tx.Account);
      expect(Object.keys(token.previous ?? {})).toEqual(['MPTAmount']);
      expect(token.after.LockedAmount).toBe(amount);
      const issuance = issuanceOf(t);
      expect(issuance.previous).toEqual({});
      expect(issuance.after.LockedAmount).toBe(amount);
    });

    it("an owner's balance back from a cancel, when it had put in all it held: escrow_cancel", () => {
      const t = recorded('escrow_cancel');
      const escrow = nodesOf(t, 'Escrow')[0];
      const owner = tokenOf(t, escrow.after.Account);
      expect(owner.previous).toEqual({ LockedAmount: '10000' });
      expect(owner.after.MPTAmount).toBe('10000');
      expect(owner.after.LockedAmount).toBeUndefined();
      const issuance = issuanceOf(t);
      expect(issuance.previous).toEqual({ LockedAmount: '10000' });
      expect(issuance.after.LockedAmount).toBeUndefined();
    });

    it('a field that falls to 0 is listed and leaves FinalFields: clawback_full', () => {
      const t = recorded('clawback_full');
      const token = tokenOf(t, t.tx.Holder);
      expect(Object.keys(token.previous ?? {})).toEqual(['MPTAmount']);
      expect(token.after.MPTAmount).toBeUndefined();
    });
  });

  it('EscrowFinish of an MPT escrow charges the fee out of the locked amount: escrow_finish_transfer_fee', () => {
    const t = recorded('escrow_finish_transfer_fee');
    const escrow = nodesOf(t, 'Escrow')[0];
    expect(escrow.after.Amount).toMatchObject({ value: '10000' });

    const issuance = nodesOf(t, 'MPTokenIssuance')[0];
    expect(issuance.previous).toEqual({ LockedAmount: '10000', OutstandingAmount: '100000' });
    expect(issuance.after.OutstandingAmount).toBe('99990');
    expect(issuance.after.LockedAmount).toBeUndefined();

    const destination = nodesOf(t, 'MPToken').find((node) => node.after.Account === escrow.after.Destination);
    expect(destination?.previous).toEqual({});
    expect(destination?.after.MPTAmount).toBe('9990');

    const owner = nodesOf(t, 'MPToken').find((node) => node.after.Account === escrow.after.Account);
    expect(owner?.previous).toEqual({ LockedAmount: '10000' });
  });
});
