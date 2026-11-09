import {
  ClickHouseService,
  readLease,
  TOKEN_HISTORY_LEASE_TTL_MS,
  workerLeaseName,
  writeLease,
} from '@gatehub/data-api-shared';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/**
 * The lease of the `token_history` worker (spec 4.1): the `syncer_lease` row `<network>:token_history`, so that two workers never
 * write one database's token history, and the `token-history-build` command can tell that a worker runs (it needs its live windows).
 * Read and written as the live runner's lease is, aged on the server's clock, with its TTL (30 s); the worker renews it every 10 s.
 */
export class TokenHistoryLease {
  private readonly name: string;

  constructor(
    private readonly ch: Pick<ClickHouseService, 'queryOne' | 'command'>,
    network: string,
    readonly holder = `token_history:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    private readonly ttlMs = TOKEN_HISTORY_LEASE_TTL_MS,
  ) {
    this.name = workerLeaseName(network);
  }

  /** Takes the lease; refused (throws) while another holder's lease is fresh. Taking it again as its holder renews it. */
  async take(): Promise<void> {
    const lease = await readLease(this.ch as ClickHouseService, this.name);
    if (lease.holder !== '' && lease.holder !== this.holder && lease.ageMs < this.ttlMs) {
      throw new Error(`another token_history worker holds the lease (${lease.holder})`);
    }
    await writeLease(this.ch as ClickHouseService, this.name, this.holder);
  }

  /** Renews the lease while it is ours; resolves false, writing nothing, once another holder has it. */
  async heartbeat(): Promise<boolean> {
    const lease = await readLease(this.ch as ClickHouseService, this.name);
    if (lease.holder !== this.holder) return false;
    await writeLease(this.ch as ClickHouseService, this.name, this.holder);
    return true;
  }

  /** Gives the lease up, if it is still ours, so that the next worker takes it at once. */
  async release(): Promise<void> {
    const lease = await readLease(this.ch as ClickHouseService, this.name);
    if (lease.holder === this.holder) await writeLease(this.ch as ClickHouseService, this.name, '');
  }
}
