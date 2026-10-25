import { NetworkName, NetworkProfile } from './network-profile';

/** An account flag (an `lsf` bit of the AccountRoot's `Flags`), named without its `lsf` prefix. */
export interface AccountFlag {
  name: string;
  bit: number;
}

/**
 * The AccountRoot flags of Xahau. xahaud's `server_definitions` (and so `config/definitions/xahau.json` and
 * `xahau-testnet.json`) has no `LEDGER_ENTRY_FLAGS`, so they are kept here by hand, from `enum LedgerSpecificFlags`
 * ("ltACCOUNT_ROOT") of
 * https://github.com/Xahau/xahaud/blob/17a484ae4adc551ced360d715be8d27d62b7bb2b/include/xrpl/protocol/LedgerFormats.h
 * (branch `dev`, 2026-10-24). A new flag there is a new line here.
 */
const XAHAU_ACCOUNT_FLAGS: Record<string, number> = {
  lsfPasswordSpent: 0x00010000,
  lsfRequireDestTag: 0x00020000,
  lsfRequireAuth: 0x00040000,
  lsfDisallowXRP: 0x00080000,
  lsfDisableMaster: 0x00100000,
  lsfNoFreeze: 0x00200000,
  lsfGlobalFreeze: 0x00400000,
  lsfDefaultRipple: 0x00800000,
  lsfDepositAuth: 0x01000000,
  lsfTshCollect: 0x02000000,
  lsfDisallowIncomingNFTokenOffer: 0x04000000,
  lsfDisallowIncomingCheck: 0x08000000,
  lsfDisallowIncomingPayChan: 0x10000000,
  lsfDisallowIncomingTrustline: 0x20000000,
  lsfURITokenIssuer: 0x40000000,
  lsfDisallowIncomingRemit: 0x80000000,
  lsfAllowTrustLineClawback: 0x00001000,
};

const cache = new Map<NetworkName, readonly AccountFlag[]>();

/** `{ lsfName: bit }` as a list of flags without the prefix, in the order of their bits. */
function toFlags(named: Record<string, unknown>): AccountFlag[] {
  return Object.entries(named)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([name, bit]) => ({ name: name.replace(/^lsf/, ''), bit }))
    .sort((a, b) => a.bit - b.bit);
}

/**
 * The account flags a network names, in the order of their bits. The source follows the family: an XRP Ledger network
 * reads them from its own definitions (`LEDGER_ENTRY_FLAGS.AccountRoot` of `config/definitions/<network>.json`, so XRPL
 * Testnet's come from the file of its node and not from mainnet's), a Xahau network takes the hand list above. The two
 * lists differ: the same bit can have another name on each family (0x80000000 is AllowTrustLineClawback on the XRP Ledger
 * and DisallowIncomingRemit on Xahau), and a flag of one may not exist on the other. The cache is keyed by network name.
 */
export function accountFlagsOf(profile: NetworkProfile): readonly AccountFlag[] {
  const known = cache.get(profile.name);
  if (known) return known;
  let named: Record<string, unknown>;
  if (profile.family === 'xahau') {
    named = XAHAU_ACCOUNT_FLAGS;
  } else {
    const definitions = profile.definitionsFallback() as
      | { LEDGER_ENTRY_FLAGS?: { AccountRoot?: Record<string, unknown> } }
      | undefined;
    const accountRoot = definitions?.LEDGER_ENTRY_FLAGS?.AccountRoot;
    if (!accountRoot) throw new Error(`The definitions of ${profile.name} name no AccountRoot flags`);
    named = accountRoot;
  }
  const flags = Object.freeze(toFlags(named));
  cache.set(profile.name, flags);
  return flags;
}

/** Every flag of the list as `name: set?`, in the list's order. Bits the list does not name are left out. */
export function namedAccountFlags(flags: number, names: readonly AccountFlag[]): Record<string, boolean> {
  return Object.fromEntries(names.map(({ name, bit }) => [name, ((flags >>> 0) & bit) >>> 0 === bit]));
}
