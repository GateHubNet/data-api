import { ParsedTransaction, ParsingService, retry, XrplTx } from '@gatehub/data-api-shared';
import { Injectable, Logger } from '@nestjs/common';
import * as xrpl from 'xrpl';
import { Ledger } from 'xrpl/dist/npm/models/ledger';
import { XrplConnectionService } from '../xrpl/xrpl-connection.service';

export interface FetchedLedger {
  ledger: Ledger;
  parsed: ParsedTransaction[];
}

/**
 * Fetches a single ledger (with expanded transactions) and parses every transaction.
 * Fetch + parse only — writing is buffered/batched by the data processor, so this is
 * the parallelizable, network-bound unit of work. The fetch is retried so a transient
 * node error does not create a permanent gap (review H5).
 */
@Injectable()
export class LedgerIngestor {
  private readonly logger = new Logger(LedgerIngestor.name);

  constructor(
    private readonly xrpl: XrplConnectionService,
    private readonly parsing: ParsingService,
  ) {}

  async fetchAndParse(ledgerIndex: number): Promise<FetchedLedger> {
    const ledger = await retry(() => this.fetchLedger(ledgerIndex), {
      attempts: 5,
      onRetry: (err, attempt) => this.logger.warn(`Fetch ledger ${ledgerIndex} failed (attempt ${attempt}): ${String(err)}`),
    });

    // close_time on the wire is ripple time (seconds since ripple epoch); convert
    // once here to unix seconds so every parser sees a consistent `date`.
    const closeTimeUnix = xrpl.rippleTimeToUnixTime(ledger.close_time) / 1000;
    const parentCloseUnix = xrpl.rippleTimeToUnixTime(ledger.parent_close_time) / 1000;
    const normalizedLedger = {
      ...ledger,
      ledger_index: Number(ledger.ledger_index),
      close_time: closeTimeUnix,
      parent_close_time: parentCloseUnix,
    } as unknown as Ledger;

    const ledgerTransactions = (ledger.transactions ?? []) as Array<xrpl.Transaction & { metaData?: xrpl.TransactionMetadata; hash: string }>;

    const parsed = ledgerTransactions.map((tx) => {
      const enriched: XrplTx = {
        ...tx,
        meta: tx.metaData,
        hash: tx.hash,
        date: closeTimeUnix,
        ledger_index: Number(ledger.ledger_index),
        client: this.parsing.parseClient(tx),
      } as XrplTx;
      return this.parsing.parseTransaction(enriched);
    });

    return { ledger: normalizedLedger, parsed };
  }

  private async fetchLedger(ledgerIndex: number): Promise<Ledger & { transactions?: unknown[] }> {
    const response = await this.xrpl.xrplClient.request({
      command: 'ledger',
      ledger_index: ledgerIndex,
      transactions: true,
      expand: true,
      binary: false,
    });
    const ledger = response.result?.ledger as (Ledger & { transactions?: unknown[] }) | undefined;
    if (!ledger) {
      throw new Error(`Ledger ${ledgerIndex} not found in node response.`);
    }
    return ledger;
  }
}
