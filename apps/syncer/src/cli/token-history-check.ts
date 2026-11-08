import { isMptIssuanceId } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Client } from 'xrpl';

/**
 * The `token-history-check` command (issuer analytics, PR 3): compares the token history the api serves with a node, for an operator
 * on mainnet, not in CI. For each token and ledger it walks `/v2/tokens/{token}/snapshot` and the issuer's `account_lines` at the
 * ledger, and compares every holder's balance exactly, and the snapshot's supply with the issuer's `gateway_balances`. One request is
 * in flight at a time, to the api and to the node (public nodes take one). The report goes to stdout.
 */

export const USAGE = `Usage: token-history-check --api <url> --key-env <NAME> --node <wss://…> --tokens <file> --ledgers <n,…>

Compares /v2/tokens/{token}/snapshot of the api at <url> (its key in the environment variable <NAME>) with the node's account_lines
and gateway_balances of the token's issuer, for every token of <file> (one {currency}.{issuer} a line; # starts a comment) at every
ledger of the list. One request at a time. Exit status: 0 when every sample matched or was skipped, 1 when one differed, 2 for a
wrong command line.`;

export class CheckUsageError extends Error {}

export interface CheckArgs {
  api: string;
  keyEnv: string;
  node: string;
  tokens: string;
  ledgers: number[];
}

/** The command line, or `CheckUsageError` for a missing option or a ledger list that is not one. */
export function parseTokenHistoryCheckArgs(argv: string[]): CheckArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      api: { type: 'string' },
      'key-env': { type: 'string' },
      node: { type: 'string' },
      tokens: { type: 'string' },
      ledgers: { type: 'string' },
    },
    strict: true,
  });
  for (const name of ['api', 'key-env', 'node', 'tokens', 'ledgers'] as const) {
    if (values[name] === undefined || values[name] === '') throw new CheckUsageError(`--${name} is required`);
  }
  const ledgers = values.ledgers!.split(',').map((l) => (/^\d{1,10}$/.test(l) ? Number(l) : NaN));
  if (ledgers.some((l) => !Number.isInteger(l)))
    throw new CheckUsageError('--ledgers is a comma-separated list of ledger numbers');
  return { api: values.api!, keyEnv: values['key-env']!, node: values.node!, tokens: values.tokens!, ledgers };
}

/** A page of the api's snapshot, or the error it answered. */
export type SnapshotPage =
  | { error: string }
  | { currency: string; supply: string; balances: { holder: string; balance: string }[]; marker?: string };

export interface CheckApi {
  snapshotPage(token: string, ledger: number, marker?: string): Promise<SnapshotPage>;
}

/** The node's view: the issuer's lines from its own side (a holder's balance is negative there), and its obligations by currency. */
export interface CheckNode {
  accountLines(
    issuer: string,
    ledger: number,
    marker?: string,
  ): Promise<{ lines: { account: string; currency: string; balance: string }[]; marker?: string }>;
  gatewayBalances(issuer: string, ledger: number): Promise<{ obligations: Record<string, string> }>;
}

export interface CheckReport {
  matched: number;
  different: number;
  skipped: number;
}

const text = (n: BigNumber): string => (n.isZero() ? '0' : n.toFixed());

/** Checks every sample, one request at a time, writing a line a sample (and one a differing holder) to `out`. */
export async function runTokenHistoryCheck(o: {
  api: CheckApi;
  node: CheckNode;
  samples: { token: string; ledger: number }[];
  out: (line: string) => void;
}): Promise<CheckReport> {
  const report: CheckReport = { matched: 0, different: 0, skipped: 0 };
  for (const { token, ledger } of o.samples) {
    const at = `${token} @ ${ledger}`;
    const issuerPart = token.split(/[.+|]/);
    if (isMptIssuanceId(issuerPart[0])) {
      o.out(`${at}: skipped: an MPT has no trust lines to compare`);
      report.skipped += 1;
      continue;
    }
    const issuer = token.slice(Math.max(token.lastIndexOf('.'), token.lastIndexOf('+'), token.lastIndexOf('|')) + 1);
    // the api's holders, every page
    const served = new Map<string, BigNumber>();
    let currency = '';
    let supply = '0';
    let marker: string | undefined;
    let error: string | undefined;
    do {
      const page = await o.api.snapshotPage(token, ledger, marker);
      if ('error' in page) {
        error = page.error;
        break;
      }
      currency = page.currency;
      supply = page.supply;
      for (const b of page.balances) served.set(b.holder, new BigNumber(b.balance));
      marker = page.marker;
    } while (marker !== undefined);
    if (error !== undefined) {
      o.out(`${at}: skipped: ${error}`);
      report.skipped += 1;
      continue;
    }
    // the node's holders of the currency: the lines where the issuer owes, the holder's balance the negated issuer side
    const held = new Map<string, BigNumber>();
    let nodeMarker: string | undefined;
    do {
      const page = await o.node.accountLines(issuer, ledger, nodeMarker);
      for (const l of page.lines) {
        const owed = new BigNumber(l.balance).negated();
        if (l.currency === currency && owed.gt(0)) held.set(l.account, owed);
      }
      nodeMarker = page.marker;
    } while (nodeMarker !== undefined);
    const { obligations } = await o.node.gatewayBalances(issuer, ledger);

    const lines: string[] = [];
    for (const holder of [...new Set([...served.keys(), ...held.keys()])].sort()) {
      const a = served.get(holder) ?? new BigNumber(0);
      const b = held.get(holder) ?? new BigNumber(0);
      if (!a.eq(b)) lines.push(`  ${holder}: api ${text(a)}, node ${text(b)}`);
    }
    const gateway = new BigNumber(obligations[currency] ?? 0);
    const supplyDiffers = !gateway.eq(supply);
    if (lines.length === 0 && !supplyDiffers) {
      o.out(`${at}: match (${served.size} holders, supply ${supply})`);
      report.matched += 1;
      continue;
    }
    o.out(
      `${at}: DIFFERENT: ${lines.length} holder(s) differ; supply api ${supply}, gateway_balances ${text(gateway)}` +
        ` (${served.size} holders by the api, ${held.size} by the node)`,
    );
    for (const l of lines) o.out(l);
    report.different += 1;
  }
  o.out(`summary: ${report.matched} matched, ${report.different} different, ${report.skipped} skipped`);
  return report;
}

/** The api over HTTP, with the key in `X-API-Key`. */
export function httpCheckApi(base: string, key: string): CheckApi {
  return {
    async snapshotPage(token, ledger, marker) {
      const url = new URL(`/v2/tokens/${encodeURIComponent(token)}/snapshot`, base);
      url.searchParams.set('ledger_index', String(ledger));
      url.searchParams.set('limit', '10000');
      if (marker !== undefined) url.searchParams.set('marker', marker);
      const res = await fetch(url, { headers: { 'X-API-Key': key } });
      const body = (await res.json()) as {
        message?: string;
        token?: { currency: string };
        supply?: string;
        balances?: { holder: string; balance: string }[];
        marker?: string;
      };
      if (!res.ok) return { error: body.message ?? `status ${res.status}` };
      return { currency: body.token!.currency, supply: body.supply!, balances: body.balances!, marker: body.marker };
    },
  };
}

/** The node over its WebSocket, one request at a time. */
export function xrplCheckNode(client: Client): CheckNode {
  return {
    async accountLines(issuer, ledger, marker) {
      const res = await client.request({
        command: 'account_lines',
        account: issuer,
        ledger_index: ledger,
        limit: 400,
        ...(marker !== undefined && { marker }),
      });
      return {
        lines: res.result.lines.map((l) => ({ account: l.account, currency: l.currency, balance: l.balance })),
        marker: res.result.marker === undefined ? undefined : String(res.result.marker),
      };
    },
    async gatewayBalances(issuer, ledger) {
      const res = await client.request({ command: 'gateway_balances', account: issuer, ledger_index: ledger });
      return { obligations: (res.result.obligations ?? {}) as Record<string, string> };
    },
  };
}

/** The tokens of a file: one a line, blank lines and `#` comments left out. */
export function tokensOf(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter((l) => l !== '');
}

/** Runs the command; resolves to the exit status. */
export async function main(argv: string[]): Promise<number> {
  let args: CheckArgs;
  try {
    args = parseTokenHistoryCheckArgs(argv);
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const key = process.env[args.keyEnv];
  if (key === undefined || key === '') {
    console.error(`the environment variable ${args.keyEnv} holds no key`);
    return 2;
  }
  const client = new Client(args.node);
  await client.connect();
  try {
    const samples = tokensOf(args.tokens).flatMap((token) => args.ledgers.map((ledger) => ({ token, ledger })));
    const report = await runTokenHistoryCheck({
      api: httpCheckApi(args.api, key),
      node: xrplCheckNode(client),
      samples,
      out: (line) => console.log(line),
    });
    return report.different > 0 ? 1 : 0;
  } finally {
    await client.disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
