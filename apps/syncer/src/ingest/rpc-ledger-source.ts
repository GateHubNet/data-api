import {
  LedgerNotAvailableError,
  LedgerSource,
  NodeClient,
  normalizeLedgerResponse,
  RawLedger,
} from '@gatehub/data-api-shared';

/** Thrown by `RpcLedgerSource.fetch` when the node returns the ledger but has not validated it (yet). */
export class LedgerNotValidatedError extends Error {
  constructor(readonly ledgerIndex: number) {
    super(`Ledger ${ledgerIndex} is not validated`);
    this.name = 'LedgerNotValidatedError';
  }
}

export interface RpcLedgerSourceOptions {
  /** Timeout for one expanded `ledger` fetch (`GH_LEDGER_FETCH_TIMEOUT_MS`, default 120000). */
  fetchTimeoutMs: number;
}

/** A `LedgerSource` that reads validated ledgers from a rippled / xahaud node through `NodeClient`. */
export class RpcLedgerSource implements LedgerSource {
  constructor(
    private readonly client: NodeClient,
    private readonly opts: RpcLedgerSourceOptions,
  ) {}

  async validatedHead(): Promise<number> {
    const result = await this.client.request<{ ledger_index?: unknown }>({
      command: 'ledger',
      ledger_index: 'validated',
    });
    return parseLedgerIndex(result?.ledger_index);
  }

  async fetch(index: number): Promise<RawLedger> {
    let result: { ledger?: unknown; validated?: unknown };
    try {
      result = await this.client.request(
        { command: 'ledger', ledger_index: index, transactions: true, expand: true },
        { timeoutMs: this.opts.fetchTimeoutMs },
      );
    } catch (err) {
      if (isRippledError(err, 'lgrNotFound')) throw new LedgerNotAvailableError(index);
      throw err;
    }
    // rippled omits `validated` (or sends false) for a ledger that consensus has not validated yet.
    if (result?.validated !== true) throw new LedgerNotValidatedError(index);
    if (typeof result.ledger !== 'object' || result.ledger === null || Array.isArray(result.ledger)) {
      throw new Error(`Ledger ${index}: the node's response has no ledger object`);
    }
    const ledger = normalizeLedgerResponse(result.ledger as Record<string, unknown>);
    if (ledger.header.ledger_index !== index) {
      throw new Error(`Ledger ${index} was requested but the node returned ledger ${ledger.header.ledger_index}`);
    }
    return ledger;
  }
}

/**
 * xrpl.js carries the full rippled error response in `RippledError.data`, with the rippled error code in `.error`.
 * It is read structurally so that the check does not depend on which copy of `xrpl` created the error.
 */
function isRippledError(err: unknown, code: string): boolean {
  const data = (err as { data?: { error?: unknown } } | null | undefined)?.data;
  return typeof data === 'object' && data !== null && data.error === code;
}

/** A positive safe integer, given as a number or (some servers) a decimal string. */
function parseLedgerIndex(value: unknown): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`The node returned an invalid validated ledger_index: ${JSON.stringify(value) ?? String(value)}`);
  }
  return parsed;
}
