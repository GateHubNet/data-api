import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subject } from 'rxjs';
import { Client, LedgerStream } from 'xrpl';
import { SYNCER_CONFIG, SyncerConfig } from '../config/syncer.config';

/**
 * Owns the XRPL websocket connection. Fixes review findings around the old
 * implementation: it no longer uses `assert` from 'console' (which never throws
 * in production), it awaits/guards reconnects, and it re-subscribes to the ledger
 * stream after a reconnect so the live feed is not silently lost.
 */
@Injectable()
export class XrplConnectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(XrplConnectionService.name);
  private client!: Client;
  private liveSubscribed = false;

  public readonly ledger$ = new Subject<LedgerStream>();

  constructor(@Inject(SYNCER_CONFIG) private readonly config: SyncerConfig) {}

  async onModuleInit(): Promise<void> {
    this.logger.log(`Connecting to XRPL node ${this.config.xrplEndpoint}`);
    this.client = new Client(this.config.xrplEndpoint, { connectionTimeout: 20_000 });

    this.client.on('connected', () => this.logger.log('Connected to XRPL node.'));
    this.client.on('ledgerClosed', (ledger: LedgerStream) => this.ledger$.next(ledger));

    this.client.on('disconnected', (code) => {
      this.logger.warn(`Disconnected from XRPL node (code ${code}). The xrpl client will auto-reconnect.`);
    });
    // xrpl.js auto-reconnects internally; when it does we must re-subscribe.
    this.client.on('connected', () => {
      if (this.liveSubscribed) {
        void this.subscribeToLedgers().catch((err) => this.logger.error('Re-subscribe failed', err));
      }
    });
    this.client.on('error', (code, message) => this.logger.error(`XRPL error ${code}: ${message}`));

    await this.client.connect();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client?.isConnected()) {
      await this.client.disconnect();
    }
  }

  async subscribeToLedgers(): Promise<void> {
    const response = await this.client.request({ command: 'subscribe', streams: ['ledger'] });
    if (!response.result) {
      throw new Error('Failed to subscribe to the ledger stream.');
    }
    this.liveSubscribed = true;
    this.logger.log('Subscribed to ledger stream.');
  }

  get xrplClient(): Client {
    return this.client;
  }
}
