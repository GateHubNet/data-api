import {
  DomainTomlsRow,
  EMPTY_TOML_CONTENT,
  getNetworkProfile,
  NetworkProfile,
  recordToml,
  Table,
  tomlUrlOf,
} from '@gatehub/data-api-shared';
import type { Harness } from '../harness';

/**
 * What the e2e suites of the display names write into the tables the api reads them from (`display-names.e2e-spec.ts`,
 * `toml.e2e-spec.ts`): the Domain of an account as the ingest writes it, a toml as the tomls worker stores it, and the
 * operator's names. Plain inserts, the way their writers do them. The api keeps what it reads on request for 60 s (the account
 * domain of an address, the row of a domain): a suite that writes after it asked empties the caches first, through the test
 * route of `cache-controllers.ts`.
 */

const XRPL = getNetworkProfile('xrpl');

/** The Domain field of an account as the ledger holds it: the upper-case hex of the text. */
export const hexOf = (text: string): string => Buffer.from(text, 'latin1').toString('hex').toUpperCase();

/** `ledger_index * 2^32 + tx_index * 2^16 + node_index` as decimal text, as the parser writes it. */
export const versionOf = (ledger: number, tx = 0, node = 0): string =>
  ((BigInt(ledger) << 32n) | (BigInt(tx) << 16n) | BigInt(node)).toString();

/**
 * The Domain of `account` after a transaction of ledger `ledger`, as one insert, so as a part of its own: of two rows of an
 * account the newer is the one of the larger ledger, whatever was inserted last. `hex` is the Domain as the ledger holds it.
 */
export async function setAccountDomain(
  h: Harness,
  account: string,
  ledger: number,
  hex: string,
  deleted: 0 | 1 = 0,
): Promise<void> {
  await h.ch.insert(Table.AccountDomains, [
    { account, ledger_index: ledger, tx_index: 0, node_index: 0, version: versionOf(ledger), domain_hex: hex, deleted },
  ]);
}

/** The account holds `domain` from ledger `ledger` on. */
export const holds = (h: Harness, account: string, domain: string, ledger = 1000): Promise<void> =>
  setAccountDomain(h, account, ledger, hexOf(domain));

/** Every instant a toml is checked at is later than the one before it. */
let checkedAt = Math.floor(Date.now() / 1000) - 100_000;
const nextCheck = (): number => (checkedAt += 10);

/** The accounts a toml lists, as a toml text: the entries of `[[ACCOUNTS]]`, with the network as a string or a number. */
export function tomlOf(...entries: { address: string; network?: string | number; desc?: string }[]): string {
  return entries
    .map((e) =>
      [
        '[[ACCOUNTS]]',
        `address = "${e.address}"`,
        ...(e.network === undefined
          ? []
          : [`network = ${typeof e.network === 'number' ? e.network : `"${e.network}"`}`]),
        ...(e.desc === undefined ? [] : [`desc = "${e.desc}"`]),
        '',
      ].join('\n'),
    )
    .join('\n');
}

/**
 * The toml of `domain` read as the tomls worker reads it, an `ok` row checked (and fetched) at `fetchedAt`, by default now
 * (later than the one before). A suite that must name the instant, to compare the answer with it, gives it.
 */
export async function putToml(
  h: Harness,
  profile: Pick<NetworkProfile, 'name' | 'tomlPath'>,
  domain: string,
  text: string,
  fetchedAt: number = nextCheck(),
): Promise<void> {
  await recordToml(h.ch, {
    domain,
    tomlUrl: tomlUrlOf(domain, profile),
    text,
    fetchedAt,
    recheckMs: 86_400_000,
    profile,
  });
}

/** A definite failure of the check of `domain`, as the worker stores it: no content in effect. */
export async function failToml(h: Harness, domain: string): Promise<void> {
  const at = nextCheck();
  const row: DomainTomlsRow = {
    domain,
    toml_url: tomlUrlOf(domain, XRPL),
    status: 'failed',
    reason: 'http_status',
    status_code: 404,
    checked_at: at,
    fetched_at: null,
    next_check_at: at + 86_400,
    failures: 1,
    ...EMPTY_TOML_CONTENT,
  };
  await h.ch.insert(Table.DomainTomls, [row]);
}

/** The operator's insert of an account name (the shared database, the same on every network). */
export async function nameAddress(h: Harness, address: string, name: string): Promise<void> {
  await h.ch.command(
    `INSERT INTO ${h.sharedDatabase}.account_names (address, name, added_by) VALUES ({address:String}, {name:String}, 'ops@gatehub.net')`,
    { address, name },
  );
}

/** The operator's insert of an account network name (the network database of `h`). */
export async function nameOnNetwork(h: Harness, address: string, name: string): Promise<void> {
  await h.ch.command(
    `INSERT INTO ${h.database}.account_network_names (address, name, added_by) VALUES ({address:String}, {name:String}, 'ops@gatehub.net')`,
    { address, name },
  );
}
