import { LedgerNotAvailableError, NodeClient } from '@gatehub/data-api-shared';
import { readFileSync } from 'fs';
import { join } from 'path';
import { RippledError } from 'xrpl';
import { LedgerNotValidatedError, RpcLedgerSource } from './rpc-ledger-source';

const FIXTURE = join(__dirname, '../../../../packages/shared/test/fixtures/xrpl/ripple-mock/11118827.json');
const LEDGER_INDEX = 11118827;
const FETCH_TIMEOUT_MS = 123_456;

type Handler = (req: Record<string, unknown>, opts?: { timeoutMs?: number; retries?: number }) => Promise<unknown>;

function stubClient(handler: Handler) {
  const request = jest.fn(handler);
  return { client: { request } as unknown as NodeClient, request };
}

/** The same error NodeClient surfaces for a rippled application error: xrpl.js puts the whole response in `data`. */
function rippledError(error: string, errorMessage = error): RippledError {
  return new RippledError(errorMessage, {
    status: 'error',
    type: 'response',
    error,
    error_message: errorMessage,
    request: { command: 'ledger' },
  });
}

function loadFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
}

describe('RpcLedgerSource', () => {
  describe('fetch', () => {
    it('requests the expanded ledger and passes fetchTimeoutMs to request', async () => {
      const { client, request } = stubClient(async () => ({ ledger: loadFixture(), validated: true }));
      const source = new RpcLedgerSource(client, { fetchTimeoutMs: FETCH_TIMEOUT_MS });

      await source.fetch(LEDGER_INDEX);

      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(
        { command: 'ledger', ledger_index: LEDGER_INDEX, transactions: true, expand: true },
        { timeoutMs: FETCH_TIMEOUT_MS },
      );
    });

    it('does not send api_version or binary', async () => {
      const { client, request } = stubClient(async () => ({ ledger: loadFixture(), validated: true }));
      await new RpcLedgerSource(client, { fetchTimeoutMs: FETCH_TIMEOUT_MS }).fetch(LEDGER_INDEX);

      const req = request.mock.calls[0][0];
      expect(req).not.toHaveProperty('api_version');
      expect(req).not.toHaveProperty('binary');
    });

    it('normalizes response', async () => {
      const fixture = loadFixture();
      const { client } = stubClient(async () => ({ ledger: fixture, validated: true }));
      const source = new RpcLedgerSource(client, { fetchTimeoutMs: FETCH_TIMEOUT_MS });

      const ledger = await source.fetch(LEDGER_INDEX);

      expect(ledger.header.ledger_index).toBe(LEDGER_INDEX);
      expect(ledger.header.ledger_hash).toBe(fixture.ledger_hash);
      expect(ledger.transactions).toHaveLength((fixture.transactions as unknown[]).length);
      expect(ledger.transactions.length).toBeGreaterThan(0);
      for (const tx of ledger.transactions) {
        expect(typeof tx.hash).toBe('string');
        expect(tx.meta).toBeDefined();
        expect(tx.tx).not.toHaveProperty('metaData');
      }
      expect(Object.isFrozen(ledger)).toBe(true);
    });

    it.each([
      ['validated is false', { validated: false }],
      ['validated is missing', {}],
      ['validated is the string "true"', { validated: 'true' }],
    ])('rejects unvalidated ledger (%s)', async (_label, extra) => {
      const { client } = stubClient(async () => ({ ledger: loadFixture(), ...extra }));
      const source = new RpcLedgerSource(client, { fetchTimeoutMs: FETCH_TIMEOUT_MS });

      const err = await source.fetch(LEDGER_INDEX).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(LedgerNotValidatedError);
      expect((err as LedgerNotValidatedError).ledgerIndex).toBe(LEDGER_INDEX);
    });

    it('maps lgrNotFound to LedgerNotAvailableError', async () => {
      const { client } = stubClient(async () => {
        throw rippledError('lgrNotFound', 'ledgerNotFound');
      });
      const source = new RpcLedgerSource(client, { fetchTimeoutMs: FETCH_TIMEOUT_MS });

      const err = await source.fetch(LEDGER_INDEX).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(LedgerNotAvailableError);
      expect((err as LedgerNotAvailableError).ledgerIndex).toBe(LEDGER_INDEX);
    });

    it('rethrows other rippled errors unchanged', async () => {
      const failure = rippledError('noNetwork');
      const { client } = stubClient(async () => {
        throw failure;
      });
      const source = new RpcLedgerSource(client, { fetchTimeoutMs: FETCH_TIMEOUT_MS });

      await expect(source.fetch(LEDGER_INDEX)).rejects.toBe(failure);
    });

    it('rethrows transport errors unchanged', async () => {
      const failure = new Error('timed out');
      const { client } = stubClient(async () => {
        throw failure;
      });
      const source = new RpcLedgerSource(client, { fetchTimeoutMs: FETCH_TIMEOUT_MS });

      await expect(source.fetch(LEDGER_INDEX)).rejects.toBe(failure);
    });

    it('rejects a response without a ledger object', async () => {
      const { client } = stubClient(async () => ({ validated: true }));
      const source = new RpcLedgerSource(client, { fetchTimeoutMs: FETCH_TIMEOUT_MS });

      await expect(source.fetch(LEDGER_INDEX)).rejects.toThrow(/no ledger/i);
    });

    it('rejects a ledger whose index differs from the requested one', async () => {
      const { client } = stubClient(async () => ({ ledger: loadFixture(), validated: true }));
      const source = new RpcLedgerSource(client, { fetchTimeoutMs: FETCH_TIMEOUT_MS });

      await expect(source.fetch(LEDGER_INDEX + 1)).rejects.toThrow(/Ledger 11118828 was requested.*ledger 11118827/);
    });
  });

  describe('validatedHead', () => {
    it('asks for the validated ledger without transactions and returns its index', async () => {
      const { client, request } = stubClient(async () => ({ ledger_index: 94_000_001, validated: true }));
      const source = new RpcLedgerSource(client, { fetchTimeoutMs: FETCH_TIMEOUT_MS });

      await expect(source.validatedHead()).resolves.toBe(94_000_001);

      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith({ command: 'ledger', ledger_index: 'validated' });
    });

    it('coerces a numeric string index', async () => {
      const { client } = stubClient(async () => ({ ledger_index: '94000001' }));
      const source = new RpcLedgerSource(client, { fetchTimeoutMs: FETCH_TIMEOUT_MS });

      await expect(source.validatedHead()).resolves.toBe(94_000_001);
    });

    it.each([
      ['missing', undefined],
      ['null', null],
      ['non-numeric string', 'abc'],
      ['empty string', ''],
      ['negative', -5],
      ['fractional', 1.5],
      ['NaN', Number.NaN],
      ['an object', {}],
    ])('rejects an invalid ledger_index (%s)', async (_label, value) => {
      const { client } = stubClient(async () => ({ ledger_index: value }));
      const source = new RpcLedgerSource(client, { fetchTimeoutMs: FETCH_TIMEOUT_MS });

      await expect(source.validatedHead()).rejects.toThrow(/ledger_index/);
    });

    it('propagates request errors', async () => {
      const failure = rippledError('noNetwork');
      const { client } = stubClient(async () => {
        throw failure;
      });
      const source = new RpcLedgerSource(client, { fetchTimeoutMs: FETCH_TIMEOUT_MS });

      await expect(source.validatedHead()).rejects.toBe(failure);
    });
  });
});
