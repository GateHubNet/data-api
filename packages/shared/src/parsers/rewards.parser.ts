import { ParseContext, ParserTx } from './parser.interface';

/**
 * `tfOptOut`, the only flag of Xahau's `ClaimReward` (`enum ClaimRewardFlags`, `include/xrpl/protocol/TxFlags.h:230-234`).
 */
export const TF_OPT_OUT = 0x0000_0001;

/** What a `ClaimReward` says about its sender: the claim (whatever the transaction's result). */
export interface ParsedRewardClaim {
  /** The claiming account (`Account`). */
  account: string;
  /** The hook account the claim names (`Issuer`), `''` for an opt-out, which has none. */
  issuer: string;
  /** `Flags` is exactly `tfOptOut`: the account opts out of the reward. */
  opt_out: boolean;
}

/** One native entry of a `GenesisMint`. */
export interface ParsedGenesisMint {
  /** The entry's index in `GenesisMints`: a skipped entry leaves its index unused, so a mint's key never moves. */
  mint_index: number;
  destination: string;
  /** Drops, as a decimal string (plain digits). */
  amount: string;
  /** `EmitDetails.EmitParentTxnID`: the transaction whose hook emitted the mint, `''` when absent. */
  parent_tx_hash: string;
  /** `EmitDetails.EmitHookHash`, `''` when absent. */
  emit_hook_hash: string;
}

/** A native amount: drops, as a string of digits. */
const DIGITS = /^\d+$/;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export class RewardsParser {
  /**
   * Xahau's reward transactions (spec 2).
   *
   * - `ClaimReward`, whatever its result, gives the `claim`. `opt_out` follows xahaud's own test, which is equality with
   *   the flag and not a mask (`ClaimReward.cpp:127` and `:202`: `isOptOut = flags && *flags == tfOptOut`; FINDINGS fact 1
   *   of `test/fixtures/xahau/mint`): an opt-out claim has `Flags` exactly 1 and no `Issuer`, and a `Flags` of 0x80000001
   *   with an `Issuer` is a normal claim for xahaud, so it is not an opt-out here either.
   * - `GenesisMint` with `tesSUCCESS` gives one mint per entry of `GenesisMints` whose `Amount` is a string of digits (native
   *   drops: xahaud rejects a token `Amount`, and an entry without one mints nothing), `mint_index` being the entry's
   *   index. A failed `GenesisMint` gives none.
   * - Every other type, and so every XRPL ledger, gives `{ mints: [] }`.
   *
   * Drops are `bigint` while handled and plain digits in the result. Pure: nothing in `t` is modified, and a field that is
   * not what the ledger always has is read as empty or skipped, never thrown on (a ledger the parsers cannot read halts the
   * ingest).
   */
  parse(t: ParserTx, _ctx: ParseContext): { claim?: ParsedRewardClaim; mints: ParsedGenesisMint[] } {
    const tx = t.tx;
    if (tx.TransactionType === 'ClaimReward') {
      return {
        claim: { account: text(tx.Account), issuer: text(tx.Issuer), opt_out: tx.Flags === TF_OPT_OUT },
        mints: [],
      };
    }
    if (tx.TransactionType === 'GenesisMint' && t.meta.TransactionResult === 'tesSUCCESS') {
      return { mints: genesisMints(tx) };
    }
    return { mints: [] };
  }
}

function genesisMints(tx: Readonly<Record<string, any>>): ParsedGenesisMint[] {
  const entries: unknown = tx.GenesisMints;
  if (!Array.isArray(entries)) return [];
  const parent = text(tx.EmitDetails?.EmitParentTxnID);
  const hook = text(tx.EmitDetails?.EmitHookHash);

  const mints: ParsedGenesisMint[] = [];
  entries.forEach((entry, index) => {
    const mint = entry?.GenesisMint;
    if (typeof mint?.Amount !== 'string' || !DIGITS.test(mint.Amount)) return;
    mints.push({
      mint_index: index,
      destination: text(mint.Destination),
      amount: String(BigInt(mint.Amount)),
      parent_tx_hash: parent,
      emit_hook_hash: hook,
    });
  });
  return mints;
}
