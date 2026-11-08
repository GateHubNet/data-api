import { LIVE_INTENT_RUN_PREFIX } from '@gatehub/data-api-shared';
import { LIVE_INTENT_PREFIX } from '../ingest/live-runner';
import { TokenHistoryWorker } from './token-history-worker';

describe('TokenHistoryWorker', () => {
  it('a pass does nothing without a committed ledger', async () => {
    const ch = {
      query: jest.fn(async () => []),
      queryOne: jest.fn(async () => ({ checkpoint: null })),
      insert: jest.fn(),
      command: jest.fn(),
      commandSummary: jest.fn(),
    };
    const worker = new TokenHistoryWorker(ch as never, { network: 'xrpl' } as never, { hasMpt: true } as never);
    await expect(worker.pass()).resolves.toEqual({ head: undefined });
    expect(ch.insert).not.toHaveBeenCalled();
    expect(ch.command).not.toHaveBeenCalled();
    expect(ch.commandSummary).not.toHaveBeenCalled();
  });
});

describe('the range-ingest check of the token history', () => {
  it("leaves out the live runner's intents by the live runner's own prefix", () => {
    expect(LIVE_INTENT_RUN_PREFIX).toBe(LIVE_INTENT_PREFIX);
  });
});
