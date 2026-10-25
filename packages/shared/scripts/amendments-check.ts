/**
 * Check the amendment metadata file of a network (spec 2.6) against a public node, and optionally against what the
 * syncer indexed.
 *
 *   pnpm --filter @gatehub/data-api-shared amendments:check -- \
 *     --network xrpl|xahau|xrpl-testnet|xahau-testnet [--endpoint <wss url>] [--clickhouse]
 *
 * It loads `config/amendments/<family>.json` (`xrpl.json` for XRPL and XRPL Testnet, `xahau.json` for Xahau and Xahau
 * Testnet; a file that does not pass the loader's checks fails the run), checks that the node is of that network
 * (`server_info.network_id` is one the network's profile accepts: a node of another network fails the run), asks the node
 * for `feature` and for the `Amendments` ledger object (`ledger_entry`, the validated ledger), and prints:
 *
 *   - the names the node knows that the file lacks (add an entry for each);
 *   - the IDs of the ledger (enabled, or with a majority) and of the current votes that neither the file nor the node
 *     names (the node may lack a name, F10: find it in the newest `features.macro` and add it);
 *   - the entries whose `enabled.ledger_index` differs from the indexed `EnableAmendment` (fix or drop the `enabled`); always
 *     empty on a testnet, whose loader drops the family file's `enabled` entries.
 *
 * `--endpoint` defaults to the first default endpoint of the network. `--clickhouse` adds the voted IDs of the newest
 * round (`amendment_tallies`) and the indexed `EnableAmendment` transactions with flags 0 (`tx_by_type`, then
 * `transactions`), read from the database the `GH_CLICKHOUSE_*` variables name. Exit status 1 when any list is not empty.
 */
import { clickHouseConfigFromEnv } from '../src/clickhouse/clickhouse.config';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { Table } from '../src/clickhouse/tables';
import { getNetworkProfile, isNetworkName, networkChoiceText, NetworkName, NetworkProfile } from '../src/network';
import {
  AMENDMENTS_OBJECT_INDEX,
  AmendmentsCheckFindings,
  amendmentsCheckFindings,
  loadAmendmentsConfig,
} from '../src/validators';
import { assertNetwork, NodeClient } from '../src/xrpl/node-client';
import { redactEndpoint } from '../src/xrpl/node-throttle';

export interface Options {
  network: NetworkName;
  endpoint: string;
  clickhouse: boolean;
}

/** How long to wait for the first connection before giving up. */
const CONNECT_TIMEOUT_MS = 60_000;

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    'usage: amendments-check --network xrpl|xahau|xrpl-testnet|xahau-testnet [--endpoint <wss url>] [--clickhouse]',
  );
  process.exit(2);
}

export function parseArgs(argv: string[]): Options {
  const values: Record<string, string> = {};
  let clickhouse = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) usage(`unexpected argument "${arg}"`);
    const name = arg.slice(2);
    if (name === 'clickhouse') {
      clickhouse = true;
      continue;
    }
    if (name !== 'network' && name !== 'endpoint') usage(`unknown option --${name}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) usage(`--${name} needs a value`);
    values[name] = value;
  }
  const network = values.network;
  if (!isNetworkName(network)) usage(networkChoiceText('--network'));
  const endpoint = values.endpoint ?? getNetworkProfile(network).defaultNodeEndpoints[0];
  if (!/^wss?:\/\//.test(endpoint)) usage('--endpoint must be a ws:// or wss:// URL');
  return { network, endpoint, clickhouse };
}

/** What the node says (`askNode`). */
export interface NodeAnswers {
  nodeFeatures: { id: string; name?: string }[];
  ledgerIds: string[];
}

/**
 * What the node says: the entries of `feature`, and the IDs of the `Amendments` object of the validated ledger. The node must
 * be of the network of the file (`server_info.network_id`, as the syncer checks it): the file of one network is never checked
 * against a node of the other.
 */
export async function askNode(
  profile: NetworkProfile,
  node: Pick<NodeClient, 'serverInfo' | 'request'>,
): Promise<NodeAnswers> {
  assertNetwork(await node.serverInfo(), profile);
  const { features } = await node.request<{ features: Record<string, { name?: string }> }>({ command: 'feature' });
  const { node: object } = await node.request<{
    node: { Amendments?: string[]; Majorities?: { Majority: { Amendment: string } }[] };
  }>({ command: 'ledger_entry', index: AMENDMENTS_OBJECT_INDEX, ledger_index: 'validated' });
  return {
    nodeFeatures: Object.entries(features).map(([id, feature]) => ({ id, name: feature.name })),
    ledgerIds: [...(object.Amendments ?? []), ...(object.Majorities ?? []).map((entry) => entry.Majority.Amendment)],
  };
}

/** Connects to `endpoint` and asks it (`askNode`). */
async function askEndpoint(profile: NetworkProfile, endpoint: string): Promise<NodeAnswers> {
  const node = new NodeClient({
    endpoints: [endpoint],
    // The report goes to stdout; the node client's own chatter (connects, retries) would only bury it.
    logger: { log: () => undefined, warn: (m) => console.error(m), error: (m) => console.error(m) },
  });
  const started = node.start();
  started.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      started,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no connection to ${redactEndpoint(endpoint)} within ${CONNECT_TIMEOUT_MS / 1000} s`)),
          CONNECT_TIMEOUT_MS,
        );
      }),
    ]);
    return await askNode(profile, node);
  } catch (err) {
    throw new Error(`${profile.name} node ${redactEndpoint(endpoint)}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
    await node.stop();
  }
}

/** The IDs voted for in the newest stored round: the rows of its newest version, whose sentinel row (`''`) is last. */
async function votedIds(clickhouse: ClickHouseService): Promise<string[]> {
  const round = await clickhouse.queryOne<{ ledger_index: number; version: string }>(
    `SELECT ledger_index, version FROM ${Table.AmendmentTallies}
     WHERE amendment_id = '' ORDER BY ledger_index DESC, version DESC LIMIT 1`,
  );
  if (!round) return [];
  const rows = await clickhouse.query<{ amendment_id: string }>(
    `SELECT amendment_id FROM ${Table.AmendmentTallies}
     WHERE ledger_index = {ledger:UInt32} AND version = {version:UInt64} AND amendment_id != '' AND yes > 0`,
    { ledger: round.ledger_index, version: round.version },
  );
  return rows.map((row) => row.amendment_id);
}

/** The indexed `EnableAmendment` transactions that enabled an amendment (flags 0), with the ledger of each. */
async function enabledEvents(clickhouse: ClickHouseService): Promise<{ id: string; ledgerIndex: number }[]> {
  const rows = await clickhouse.query<{ ledger_index: number; amendment: string }>(
    `SELECT t.ledger_index AS ledger_index, JSONExtractString(t.tx_json, 'Amendment') AS amendment
     FROM ${Table.Transactions} AS t
     WHERE (t.ledger_index, t.tx_index) IN
       (SELECT ledger_index, tx_index FROM ${Table.TxByType} WHERE tx_type = {type:String})
       AND JSONExtractUInt(t.tx_json, 'Flags') = 0
     ORDER BY t.ledger_index, t.tx_index`,
    { type: 'EnableAmendment' },
  );
  return rows.map((row) => ({ id: row.amendment, ledgerIndex: row.ledger_index }));
}

export function report(findings: AmendmentsCheckFindings): { text: string; clean: boolean } {
  const lines: string[] = [];
  const section = (title: string, items: string[]) => {
    lines.push(`${title}: ${items.length}`);
    for (const item of items) lines.push(`  ${item}`);
  };
  section('names the node knows that the file lacks', findings.missingNames);
  section('IDs in the ledger or the votes that no one names', findings.unnamedIds);
  section(
    'entries whose enabled.ledger_index contradicts the index',
    findings.contradictions.map((c) => `${c.name}: file ${c.file}, indexed ${c.indexed}`),
  );
  const clean =
    findings.missingNames.length === 0 && findings.unnamedIds.length === 0 && findings.contradictions.length === 0;
  return { text: lines.join('\n'), clean };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const profile = getNetworkProfile(options.network);
  const config = loadAmendmentsConfig(profile);
  const { nodeFeatures, ledgerIds } = await askEndpoint(profile, options.endpoint);

  let votes: string[] | undefined;
  let events: { id: string; ledgerIndex: number }[] | undefined;
  if (options.clickhouse) {
    const clickhouse = new ClickHouseService(clickHouseConfigFromEnv(process.env, profile));
    try {
      votes = await votedIds(clickhouse);
      events = await enabledEvents(clickhouse);
    } finally {
      await clickhouse.onModuleDestroy();
    }
  }

  const findings = amendmentsCheckFindings({ config, nodeFeatures, ledgerIds, votedIds: votes, enabledEvents: events });
  const { text, clean } = report(findings);
  console.log(
    `${profile.name}: ${config.amendments.length} entries (updated ${config.updated}); node ${redactEndpoint(options.endpoint)} ` +
      `knows ${nodeFeatures.length} amendments, the ledger lists ${new Set(ledgerIds).size}` +
      (votes ? `; ${votes.length} voted in the newest round, ${events?.length} enabled in the index` : ''),
  );
  console.log(text);
  if (!clean) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
