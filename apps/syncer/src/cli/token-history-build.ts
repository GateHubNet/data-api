import {
  BuildRefused,
  BuildStopped,
  ClickHouseConfig,
  clickHouseConfigFromEnv,
  ClickHouseService,
  NetworkProfile,
  getNetworkProfile,
  runTokenHistoryBuild,
  TOKEN_HISTORY_BUILD_THREADS,
} from '@gatehub/data-api-shared';
import { Logger } from '@nestjs/common';
import { parseArgs } from 'node:util';
import { loadSyncerConfig } from '../config/syncer.config';
import { migrateOnBoot } from '../core/migrate-on-boot';

/**
 * The `token-history-build` command (issuer analytics, spec 4.6): builds a generation of the token history, or finishes the one that
 * is building, then exits. It runs beside the syncer, whose `token_history` worker writes the live windows above the build's start,
 * once a `range-ingest` fill is done.
 */

export const USAGE = `Usage: pnpm token-history:build [--threads <n>]

Builds the token history (the change log, checkpoints, hourly rollups and DEX history of every issued token and MPT) of the
network's database, in ClickHouse, from the state history. It resumes the build that is in progress, if there is one. The network
and ClickHouse come from the same GH_* environment as the syncer.

  --threads <n>     max_threads of every statement of the build (default ${TOKEN_HISTORY_BUILD_THREADS}); more is faster and loads
                    the ClickHouse server more
  --help            print this text

It refuses to start while another build runs, while a range-ingest runs, and while no syncer runs the token_history worker.
Ctrl-C stops it after the statement in flight; run it again to resume.

Exit status: 0 when the build is done (the worker then catches it up to the head and promotes it), 1 when it failed or was
interrupted (run it again to resume), 2 when it refused to start or the command line is wrong, 3 when a range-ingest started
while it ran (the generation is retired: build again once the fill is done).`;

/** The command line is wrong. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The options of the build from the command line (without `node` and the script), or 'help'. */
export function parseTokenHistoryBuildArgs(argv: string[]): { threads: number } | 'help' {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: { threads: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    }));
  } catch (err) {
    throw new UsageError(describe(err));
  }
  if (values.help) return 'help';
  if (values.threads === undefined) return { threads: TOKEN_HISTORY_BUILD_THREADS };
  const raw = values.threads as string;
  const threads = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(threads) || threads < 1) {
    throw new UsageError(`--threads must be a whole number from 1, got "${raw}"`);
  }
  return { threads };
}

/** The request timeout of the build's client unless `GH_CLICKHOUSE_REQUEST_TIMEOUT` says otherwise: a batch can take long. */
export const BUILD_REQUEST_TIMEOUT_MS = 6 * 3_600_000;

/**
 * The ClickHouse config of the build: the syncer's (`GH_CLICKHOUSE_*`), but without its 30 s guards, which no statement of a
 * mainnet build stays under: the request timeout is `BUILD_REQUEST_TIMEOUT_MS` and `max_execution_time` is off, unless
 * `GH_CLICKHOUSE_REQUEST_TIMEOUT` or `GH_CLICKHOUSE_MAX_EXECUTION_TIME` sets them.
 */
export function buildClickHouseConfig(env: NodeJS.ProcessEnv, profile: NetworkProfile): ClickHouseConfig {
  const base = clickHouseConfigFromEnv(env, profile);
  return {
    ...base,
    requestTimeout: env.GH_CLICKHOUSE_REQUEST_TIMEOUT === undefined ? BUILD_REQUEST_TIMEOUT_MS : base.requestTimeout,
    maxExecutionTime: env.GH_CLICKHOUSE_MAX_EXECUTION_TIME === undefined ? 0 : base.maxExecutionTime,
  };
}

/** The exit status of a build that threw: 2 refused, 3 stopped by a range-ingest, 1 anything else (an interrupt included). */
export function exitCodeOf(err: unknown): number {
  if (err instanceof BuildRefused) return 2;
  if (err instanceof BuildStopped) return 3;
  return 1;
}

/** Runs the CLI; resolves to the exit status. */
export async function main(argv: string[]): Promise<number> {
  let parsed: { threads: number } | 'help';
  try {
    parsed = parseTokenHistoryBuildArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed === 'help') {
    console.log(USAGE);
    return 0;
  }

  const logger = new Logger('TokenHistoryBuild');
  const cfg = await loadSyncerConfig();
  const profile = getNetworkProfile(cfg.network);
  const clickHouse = buildClickHouseConfig(process.env, profile);
  const ch = new ClickHouseService(clickHouse);
  const abort = new AbortController();
  const onSigint = (): void => {
    if (abort.signal.aborted) process.exit(130);
    logger.warn('Interrupted: stopping after the statement in flight (Ctrl-C again to quit at once); run again to resume');
    abort.abort(new Error('interrupted'));
  };
  process.on('SIGINT', onSigint);
  try {
    await migrateOnBoot(cfg, clickHouse, logger);
    logger.log(
      `Building the token history of ${profile.name} in database "${clickHouse.database}" at ${clickHouse.url}, ` +
        `${parsed.threads} thread(s)`,
    );
    const done = await runTokenHistoryBuild(ch, {
      network: profile.name,
      hasMpt: profile.hasMpt,
      threads: parsed.threads,
      log: { info: (m) => logger.log(m) },
      signal: abort.signal,
    });
    logger.log(`Generation ${done.generation} is built; the token_history worker catches it up to the head and promotes it`);
    return 0;
  } catch (err) {
    const code = exitCodeOf(err);
    if (code === 1) logger.error(`token-history-build failed: ${describe(err)}`, err instanceof Error ? err.stack : undefined);
    else logger.warn(describe(err));
    return code;
  } finally {
    process.off('SIGINT', onSigint);
    await ch.close().catch((err: unknown) => logger.warn(`Closing ClickHouse failed: ${describe(err)}`));
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      new Logger('TokenHistoryBuild').error(`Fatal: ${describe(err)}`, err instanceof Error ? err.stack : undefined);
      process.exit(1);
    },
  );
}
