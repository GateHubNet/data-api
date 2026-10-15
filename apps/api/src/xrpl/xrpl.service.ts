import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Client } from 'xrpl';
import { ApiConfig, endpointList } from '../config/api.config';

/**
 * Lazily-connected XRPL client for endpoints that need *live* ledger state
 * (open orders, current balances) rather than indexed history. Connection is
 * pooled (single client, connect-once) instead of the old per-request connect.
 */
@Injectable()
export class XrplService implements OnModuleDestroy {
  private readonly logger = new Logger(XrplService.name);
  private readonly client: Client;
  private connecting?: Promise<void>;

  constructor(config: ApiConfig) {
    // Task 18 rewrites this service on the NodeClient over every endpoint; until then the first one serves.
    this.client = new Client(endpointList(config.nodeEndpoints)[0], { connectionTimeout: 15_000 });
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.isConnected()) return;
    if (!this.connecting) {
      this.connecting = this.client.connect().then(() => {
        this.logger.log('Connected to XRPL node.');
      });
    }
    await this.connecting;
  }

  async request<T = unknown>(req: Parameters<Client['request']>[0]): Promise<T> {
    await this.ensureConnected();
    return this.client.request(req) as unknown as T;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.isConnected()) await this.client.disconnect();
  }
}
