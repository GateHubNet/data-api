import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { gunzipSync } from 'zlib';
import { LedgerNotAvailableError, LedgerSource } from './ledger-source';
import { normalizeLedgerResponse, RawLedger } from './raw-ledger';

/** `<index>.json`, `<index>-<label>.json` and the same with `.gz`; other files in a fixture dir are not ledgers. */
const LEDGER_FILE = /^\d+(?:-[^/\\]*)?\.json(?:\.gz)?$/;

/** A `LedgerSource` backed by an in-memory list of ledgers, for tests and offline replays. */
export class FixtureLedgerSource implements LedgerSource {
  private readonly ledgers: RawLedger[];
  private readonly byIndex = new Map<number, RawLedger>();

  constructor(ledgers: RawLedger[]) {
    this.ledgers = [...ledgers].sort((a, b) => a.header.ledger_index - b.header.ledger_index);
    for (const ledger of this.ledgers) {
      if (this.byIndex.has(ledger.header.ledger_index)) {
        throw new Error(`Duplicate ledger ${ledger.header.ledger_index} in fixture ledgers`);
      }
      this.byIndex.set(ledger.header.ledger_index, ledger);
    }
  }

  /**
   * Load every `<index>[-label].json` and `<index>[-label].json.gz` file in `dir`. A file holds either a bare ledger
   * (the Ripple mock format) or a full rippled `ledger` result with the ledger under `ledger` (what
   * `record-fixtures` writes).
   */
  static fromDir(dir: string): FixtureLedgerSource {
    const ledgers = readdirSync(dir)
      .filter((name) => LEDGER_FILE.test(name))
      .sort()
      .map((name) => {
        try {
          const file = readFileSync(join(dir, name));
          const parsed = JSON.parse((name.endsWith('.gz') ? gunzipSync(file) : file).toString('utf8')) as Record<
            string,
            unknown
          >;
          const ledger = typeof parsed.ledger === 'object' && parsed.ledger !== null ? parsed.ledger : parsed;
          return normalizeLedgerResponse(ledger as Record<string, unknown>);
        } catch (err) {
          throw new Error(`Cannot load ledger fixture ${join(dir, name)}: ${(err as Error).message}`);
        }
      });
    return new FixtureLedgerSource(ledgers);
  }

  async validatedHead(): Promise<number> {
    if (this.ledgers.length === 0) throw new Error('FixtureLedgerSource has no ledgers');
    return this.ledgers[this.ledgers.length - 1].header.ledger_index;
  }

  async fetch(index: number): Promise<RawLedger> {
    const ledger = this.byIndex.get(index);
    if (!ledger) throw new LedgerNotAvailableError(index);
    return ledger;
  }

  /** All ledgers, ascending by index. */
  list(): RawLedger[] {
    return [...this.ledgers];
  }
}
