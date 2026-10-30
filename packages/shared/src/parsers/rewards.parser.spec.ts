import { readFileSync } from 'fs';
import { join } from 'path';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { getNetworkProfile } from '../network';
import { deepFreeze } from '../test-utils/deep-freeze';
import { ParseContext, parseContextFor, ParserTx, toParserTx } from './parser.interface';
import { ParsedGenesisMint, RewardsParser, TF_OPT_OUT } from './rewards.parser';

type Json = Record<string, any>;

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');
const XAHAU: ParseContext = parseContextFor(getNetworkProfile('xahau'));
const XRPL: ParseContext = parseContextFor(getNetworkProfile('xrpl'));

/** The recorded ledgers of Xahau mainnet; `xahau/mint` holds the hand-made opt-out and governance ledgers beside the Imports. */
const recordedSource = FixtureLedgerSource.fromDir(join(FIXTURES, 'xahau', 'recorded'));
const mintSource = FixtureLedgerSource.fromDir(join(FIXTURES, 'xahau', 'mint'));
const mintManifest = JSON.parse(readFileSync(join(FIXTURES, 'xahau', 'mint', 'manifest.json'), 'utf8')) as {
  cases: Record<string, { ledger: number; hash: string; file?: string }>;
};

/** The ClaimReward of ledger 26540187 and the GenesisMint it caused in 26540188 (`xahau/recorded`). */
const CLAIM_HASH = '3A1F25CDF0E2E4466AA0B019EA3039A6E5F87C01FBDD69CBDC474DAC32D8E64C';
const MINT_HASH = 'E8264F11B5CDD9844BFCF3C5CDFE99B5F7EBB91B3723C2CC8A1680FAD86EB22D';
const EMIT_HOOK_HASH = '610F33B8EBF7EC795F822A454FB852156AEFE50BE0CB8326338A81CD74801864';
const CLAIMER = 'rDitc4S7Y1GF2yzM4S2dayA4jYuK6YewSz';
const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
/** The recorded Invoke of ledger 26540711 that the hand-made governance ledger names as the mint's parent. */
const INVOKE_HASH = 'DE1FEAEA69ABF97EA8D95341A6C9B79094746CD8F35C0557583BB986867BB48D';

/** The eight entries of the recorded GenesisMint, in order. */
const RECORDED_MINTS: Array<[string, string]> = [
  ['rDitc4S7Y1GF2yzM4S2dayA4jYuK6YewSz', '11755654'],
  ['rD74dUPRFNfgnY2NzrxxYRXN4BrfGSN6Mv', '587351'],
  ['rN7XCq12KBvBLKad3wWsVUwmb3dNx1fx3e', '587351'],
  ['ra7MQw7YoMjUw6thxmSGE6jpAEY3LTHxev', '587351'],
  ['rfMB6RCNdWSB6TJXYwCEU5HvDC2eArJp8h', '587351'],
  ['r4FF5jjJMS2XqWDyTYStWrgARsj3FjaJ2J', '587351'],
  ['r4FRPZbLnyuVeGiSi1Ap6uaaPvPXYZh1XN', '587351'],
  ['rHsh4MNWJKXN2YGtSf95aEzFYzMqwGiBve', '587351'],
];

const parser = new RewardsParser();

/** A transaction of a fixture source by ledger and hash, deep-frozen. */
function recorded(source: FixtureLedgerSource, ledgerIndex: number, hash: string): ParserTx {
  const ledger = source.list().find((l) => l.header.ledger_index === ledgerIndex);
  const raw = ledger?.transactions.find((t) => t.hash === hash);
  if (!ledger || !raw) throw new Error(`${hash} is not in ledger ${ledgerIndex}`);
  return deepFreeze(toParserTx(raw, ledger.header, null));
}

/** A hand-made case of `xahau/mint` by its manifest name. */
function mintCase(name: string): ParserTx {
  const c = mintManifest.cases[name];
  if (!c) throw new Error(`no case ${name} in the xahau/mint manifest`);
  return recorded(mintSource, c.ledger, c.hash);
}

const recordedClaim = (): ParserTx => recorded(recordedSource, 26540187, CLAIM_HASH);
const recordedMint = (): ParserTx => recorded(recordedSource, 26540188, MINT_HASH);

/** A deep-frozen copy of `t` after `edit` changed (copies of) its transaction and metadata. */
function variant(t: ParserTx, edit: (tx: Json, meta: Json) => void): ParserTx {
  const tx = structuredClone(t.tx) as Json;
  const meta = structuredClone(t.meta) as Json;
  edit(tx, meta);
  return deepFreeze({ ...t, tx, meta });
}

/** A GenesisMint built from entries, the way the recorded one is shaped. */
function genesisMint(entries: unknown[], over: Json = {}, result = 'tesSUCCESS'): ParserTx {
  return deepFreeze({
    hash: 'HASH',
    ledger_index: 26_540_188,
    close_time: 1_700_000_000,
    tx_index: 0,
    client: null,
    tx: {
      TransactionType: 'GenesisMint',
      Account: ISSUER,
      Fee: '0',
      Flags: 2_147_483_648,
      GenesisMints: entries,
      EmitDetails: { EmitHookHash: EMIT_HOOK_HASH, EmitParentTxnID: CLAIM_HASH },
      ...over,
    },
    meta: { TransactionResult: result, TransactionIndex: 0, AffectedNodes: [] },
  });
}

const native = (destination: string, amount: unknown): Json => ({
  GenesisMint: { Destination: destination, Amount: amount },
});

describe('RewardsParser', () => {
  describe('ClaimReward', () => {
    it('makes the claim of the recorded ClaimReward', () => {
      expect(parser.parse(recordedClaim(), XAHAU)).toStrictEqual({
        claim: { account: CLAIMER, issuer: ISSUER, opt_out: false },
        mints: [],
      });
    });

    describe('reads tfOptOut as xahaud does: by equality with the flag, not as a mask (FINDINGS fact 1)', () => {
      it('is the bit 0x00000001', () => {
        expect(TF_OPT_OUT).toBe(1);
      });

      it('the hand-made opt-out ledger: Flags 1 and no Issuer give an opt-out with an empty issuer', () => {
        const t = mintCase('claim-opt-out');
        expect(t.tx.Flags).toBe(1);
        expect(t.tx.Issuer).toBeUndefined();

        expect(parser.parse(t, XAHAU)).toStrictEqual({
          claim: { account: CLAIMER, issuer: '', opt_out: true },
          mints: [],
        });
      });

      it('Flags 2147483649 (0x80000001, tfUniversal too) with an Issuer is a normal claim for xahaud, so not an opt-out', () => {
        const t = variant(recordedClaim(), (tx) => {
          tx.Flags = 2_147_483_649;
        });

        expect(parser.parse(t, XAHAU).claim).toStrictEqual({ account: CLAIMER, issuer: ISSUER, opt_out: false });
      });

      it.each([0, 2, 3, 2_147_483_648])('Flags %i is not an opt-out', (flags) => {
        const t = variant(recordedClaim(), (tx) => {
          tx.Flags = flags;
        });

        expect(parser.parse(t, XAHAU).claim?.opt_out).toBe(false);
      });

      it('a claim without Flags is not an opt-out', () => {
        const t = variant(recordedClaim(), (tx) => {
          delete tx.Flags;
        });

        expect(parser.parse(t, XAHAU).claim?.opt_out).toBe(false);
      });
    });

    it('makes a claim whatever its result', () => {
      const t = variant(recordedClaim(), (_tx, meta) => {
        meta.TransactionResult = 'tecNO_PERMISSION';
      });

      expect(t.meta.TransactionResult).toBe('tecNO_PERMISSION');
      expect(parser.parse(t, XAHAU)).toStrictEqual({
        claim: { account: CLAIMER, issuer: ISSUER, opt_out: false },
        mints: [],
      });
    });

    it('a claim has no mints, and a GenesisMint no claim', () => {
      expect(parser.parse(recordedClaim(), XAHAU).mints).toStrictEqual([]);
      expect('claim' in parser.parse(recordedMint(), XAHAU)).toBe(false);
    });
  });

  describe('GenesisMint', () => {
    it('makes one mint per native entry of the recorded GenesisMint', () => {
      const { claim, mints } = parser.parse(recordedMint(), XAHAU);

      expect(claim).toBeUndefined();
      expect(mints).toHaveLength(8);
      expect(mints.map((m) => m.mint_index)).toStrictEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(mints.reduce((sum, m) => sum + BigInt(m.amount), 0n)).toBe(15_867_111n);
      expect(mints).toStrictEqual(
        RECORDED_MINTS.map(
          ([destination, amount], mint_index): ParsedGenesisMint => ({
            mint_index,
            destination,
            amount,
            parent_tx_hash: CLAIM_HASH,
            emit_hook_hash: EMIT_HOOK_HASH,
          }),
        ),
      );
    });

    it('reads the parent of the hand-made governance ledger as it names it (the Invoke, no claim)', () => {
      const { mints } = parser.parse(mintCase('genesis-mint-governance'), XAHAU);

      expect(mints).toHaveLength(8);
      expect(new Set(mints.map((m) => m.parent_tx_hash))).toStrictEqual(new Set([INVOKE_HASH]));
      expect(new Set(mints.map((m) => m.emit_hook_hash))).toStrictEqual(new Set([EMIT_HOOK_HASH]));
      expect(mints.map((m) => [m.destination, m.amount])).toStrictEqual(RECORDED_MINTS);
    });

    it('skips an entry without Amount or with a token Amount and keeps the indexes of the others', () => {
      const t = genesisMint([
        native('rFirst', '100'),
        { GenesisMint: { Destination: 'rNoAmount' } },
        { GenesisMint: { Destination: 'rToken', Amount: { currency: 'USD', issuer: ISSUER, value: '5' } } },
        native('rLast', '7'),
      ]);

      expect(parser.parse(t, XAHAU).mints.map((m) => [m.mint_index, m.destination, m.amount])).toStrictEqual([
        [0, 'rFirst', '100'],
        [3, 'rLast', '7'],
      ]);
    });

    it.each([
      ['an empty string', ''],
      ['a decimal', '1.5'],
      ['a negative', '-5'],
      ['an exponent', '1e3'],
      ['text', 'abc'],
      ['a number', 5],
      ['null', null],
    ])('skips an entry whose Amount is %s: only a string of digits is native drops', (_label, amount) => {
      const t = genesisMint([native('rSkipped', amount), native('rKept', '9')]);

      expect(parser.parse(t, XAHAU).mints.map((m) => [m.mint_index, m.destination])).toStrictEqual([[1, 'rKept']]);
    });

    it('skips an entry that is not a GenesisMint wrapper, and keeps the indexes', () => {
      const t = genesisMint([null, 'text', { Other: {} }, native('rKept', '9')]);

      expect(parser.parse(t, XAHAU).mints.map((m) => m.mint_index)).toStrictEqual([3]);
    });

    it('gives no mints for a transaction without a list of entries', () => {
      expect(parser.parse(genesisMint([], { GenesisMints: undefined }), XAHAU).mints).toStrictEqual([]);
      expect(parser.parse(genesisMint([], { GenesisMints: {} }), XAHAU).mints).toStrictEqual([]);
      expect(parser.parse(genesisMint([]), XAHAU).mints).toStrictEqual([]);
    });

    it('reads absent EmitDetails as empty hashes', () => {
      const withoutDetails = genesisMint([native('rA', '1')], { EmitDetails: undefined });
      const withoutHook = genesisMint([native('rA', '1')], { EmitDetails: { EmitParentTxnID: CLAIM_HASH } });
      const withoutParent = genesisMint([native('rA', '1')], { EmitDetails: { EmitHookHash: EMIT_HOOK_HASH } });

      expect(parser.parse(withoutDetails, XAHAU).mints).toStrictEqual([
        { mint_index: 0, destination: 'rA', amount: '1', parent_tx_hash: '', emit_hook_hash: '' },
      ]);
      expect(parser.parse(withoutHook, XAHAU).mints[0]).toMatchObject({
        parent_tx_hash: CLAIM_HASH,
        emit_hook_hash: '',
      });
      expect(parser.parse(withoutParent, XAHAU).mints[0]).toMatchObject({
        parent_tx_hash: '',
        emit_hook_hash: EMIT_HOOK_HASH,
      });
    });

    it('writes an amount as plain digits, however large', () => {
      const t = genesisMint([native('rA', '100000000000000000'), native('rB', '9007199254740993')]);

      expect(parser.parse(t, XAHAU).mints.map((m) => m.amount)).toStrictEqual([
        '100000000000000000',
        '9007199254740993',
      ]);
    });

    it('gives no mint for a GenesisMint that failed', () => {
      const t = variant(recordedMint(), (_tx, meta) => {
        meta.TransactionResult = 'tecNO_DST';
      });

      expect(parser.parse(t, XAHAU)).toStrictEqual({ mints: [] });
    });
  });

  describe('everything else', () => {
    /** Every transaction of a fixture directory, in ledger order. */
    function transactionsOf(source: FixtureLedgerSource): ParserTx[] {
      return source
        .list()
        .flatMap((ledger) => ledger.transactions.map((raw) => deepFreeze(toParserTx(raw, ledger.header, null))));
    }

    it('gives nothing for other types: only the recorded ClaimReward and GenesisMint of xahau/recorded give anything', () => {
      const given: string[] = [];
      let others = 0;
      for (const t of transactionsOf(recordedSource)) {
        const result = parser.parse(t, XAHAU);
        if (result.claim || result.mints.length > 0) given.push(`${t.tx.TransactionType} ${t.hash}`);
        else others++;
      }

      expect(given).toStrictEqual([`ClaimReward ${CLAIM_HASH}`, `GenesisMint ${MINT_HASH}`]);
      expect(others).toBeGreaterThan(20);
    });

    it('gives nothing for an Import', () => {
      const t = recorded(
        mintSource,
        mintManifest.cases['import-existing-account'].ledger,
        mintManifest.cases['import-existing-account'].hash,
      );

      expect(t.tx.TransactionType).toBe('Import');
      expect(parser.parse(t, XAHAU)).toStrictEqual({ mints: [] });
    });

    it('gives nothing for every ledger of xrpl/recorded and xrpl-testnet/recorded', () => {
      const transactions = ['xrpl/recorded', 'xrpl-testnet/recorded'].flatMap((dir) =>
        transactionsOf(FixtureLedgerSource.fromDir(join(FIXTURES, dir))),
      );

      expect(transactions.length).toBeGreaterThan(1000);
      for (const t of transactions) {
        expect(parser.parse(t, XRPL)).toStrictEqual({ mints: [] });
      }
    });
  });

  describe('purity', () => {
    it('leaves its deep-frozen input as it was', () => {
      const inputs = [recordedClaim(), mintCase('claim-opt-out'), recordedMint(), mintCase('genesis-mint-governance')];

      for (const t of inputs) {
        const before = JSON.stringify(t);
        expect(Object.isFrozen(t.meta)).toBe(true);
        expect(() => parser.parse(t, XAHAU)).not.toThrow();
        expect(JSON.stringify(t)).toBe(before);
      }
    });
  });
});
