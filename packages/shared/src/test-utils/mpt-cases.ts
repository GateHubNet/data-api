import { readFileSync } from 'fs';
import { join } from 'path';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { RawLedger } from '../ingest/raw-ledger';
import { getNetworkProfile, NetworkName } from '../network/network-profile';
import { ParseContext, parseContextFor, ParserTx, toParserTx } from '../parsers/parser.interface';
import { deepFreeze } from './deep-freeze';

/**
 * The recorded MPT cases of `test/fixtures/xrpl/mpt` and `test/fixtures/xrpl-testnet/mpt` (D9, Task 1). Test-only: `src/test-utils`
 * is excluded from the build. `xrpl/mpt/FINDINGS.md` says what each case shows and names the shapes no transaction read shows: a
 * test that needs one uses `editedMptCase`, and says which case it edited and how.
 */
const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');
const NETWORKS: readonly MptNetwork[] = ['xrpl', 'xrpl-testnet'];

type MptNetwork = Extract<NetworkName, 'xrpl' | 'xrpl-testnet'>;
type Json = Record<string, any>;

export const mptContext = (network: MptNetwork): ParseContext => parseContextFor(getNetworkProfile(network));

const dirOf = (network: MptNetwork): string => join(FIXTURES, network, 'mpt');

const sources = new Map<MptNetwork, RawLedger[]>();
/** The recorded ledgers of a network's MPT cases, whole. */
export function mptLedgers(network: MptNetwork): RawLedger[] {
  let ledgers = sources.get(network);
  if (ledgers === undefined) {
    ledgers = FixtureLedgerSource.fromDir(dirOf(network)).list();
    sources.set(network, ledgers);
  }
  return ledgers;
}

const manifests = new Map<MptNetwork, Record<string, { ledger: number; hash: string }>>();
function casesOf(network: MptNetwork): Record<string, { ledger: number; hash: string }> {
  let cases = manifests.get(network);
  if (cases === undefined) {
    cases = (JSON.parse(readFileSync(join(dirOf(network), 'manifest.json'), 'utf8')) as { cases: typeof cases }).cases!;
    manifests.set(network, cases);
  }
  return cases;
}

/** Every case name, mainnet's first. */
export const mptCaseNames = (): string[] => NETWORKS.flatMap((network) => Object.keys(casesOf(network)));

const networkOf = (name: string): MptNetwork => {
  const network = NETWORKS.find((n) => name in casesOf(n));
  if (network === undefined) throw new Error(`${name} is not a recorded MPT case`);
  return network;
};

/** A recorded case as a parser takes it, deep-frozen. */
export function mptCase(name: string): ParserTx {
  const network = networkOf(name);
  const { ledger, hash } = casesOf(network)[name];
  const raw = mptLedgers(network).find((l) => l.header.ledger_index === ledger);
  const found = raw?.transactions.find((t) => t.hash === hash);
  if (raw === undefined || found === undefined) throw new Error(`${name}: ledger ${ledger} does not hold ${hash}`);
  return deepFreeze(toParserTx(found, raw.header, null));
}

/** The context of a case's network. */
export const mptCaseContext = (name: string): ParseContext => mptContext(networkOf(name));

/** A synthetic: a deep copy of a recorded case, changed by `edit` and frozen. The caller says what the edit stands for. */
export function editedMptCase(name: string, edit: (tx: Json, meta: Json) => void): ParserTx {
  const copy = JSON.parse(JSON.stringify(mptCase(name))) as ParserTx & { tx: Json; meta: Json };
  edit(copy.tx, copy.meta);
  return deepFreeze(copy);
}

/** A node of a transaction's metadata: the entry and its body. `test` picks among the nodes of `type`. */
export function mptNode(meta: Json, type: string, test: (fields: Json) => boolean = () => true): Json {
  for (const entry of meta.AffectedNodes as Json[]) {
    const body = (entry.CreatedNode ?? entry.ModifiedNode ?? entry.DeletedNode) as Json;
    if (body.LedgerEntryType === type && test({ ...body.FinalFields, ...body.NewFields })) return body;
  }
  throw new Error(`no ${type} node`);
}

const touchesMpt = (t: ParserTx): boolean =>
  ((t.meta.AffectedNodes ?? []) as Json[]).some((entry) => {
    const type = (entry.CreatedNode ?? entry.ModifiedNode ?? entry.DeletedNode)?.LedgerEntryType;
    return type === 'MPToken' || type === 'MPTokenIssuance';
  });

/** Every recorded transaction with an MPT node on both networks, cases or not, each with its network and hash for a message. */
export function everyMptTransaction(): { network: MptNetwork; t: ParserTx }[] {
  return NETWORKS.flatMap((network) =>
    mptLedgers(network).flatMap((ledger) =>
      ledger.transactions
        .map((raw) => deepFreeze(toParserTx(raw, ledger.header, null)))
        .filter(touchesMpt)
        .map((t) => ({ network, t })),
    ),
  );
}
