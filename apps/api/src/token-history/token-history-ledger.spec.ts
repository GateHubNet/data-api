import { DATE_TOO_OLD } from '../accounts/account-ledger';
import { RippleHttpError } from '../common/errors';
import { LedgerLookups, resolveTokenHistoryLedger } from './token-history-ledger';

const LIVE = { generation: 1, through: 1_000, close_time: 1_700_000_000, coverage_from: 500 };
const HASH = 'AB'.repeat(32);

function lookups(): LedgerLookups & { atOrBefore: jest.Mock; byHash: jest.Mock } {
  return {
    atOrBefore: jest.fn(async (d: Date) => (d.getTime() < Date.UTC(2015, 0, 1) ? undefined : 900)),
    byHash: jest.fn(async (h: string) => (h === HASH ? 700 : undefined)),
  };
}

async function messageOf(p: Promise<unknown>, status = 400): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RippleHttpError);
    expect((e as RippleHttpError).getStatus()).toBe(status);
    return ((e as RippleHttpError).getResponse() as { message: string }).message;
  }
  throw new Error('expected a rejection');
}

describe('resolveTokenHistoryLedger', () => {
  it('is the live generation through ledger when none is named, and for the node words', async () => {
    expect(await resolveTokenHistoryLedger({}, LIVE, lookups())).toBe(1_000);
    for (const word of ['validated', 'closed', 'current']) {
      expect(await resolveTokenHistoryLedger({ ledger_index: word }, LIVE, lookups())).toBe(1_000);
    }
  });

  it('reads ledger_index, its alias ledger, a hash and a date', async () => {
    const l = lookups();
    expect(await resolveTokenHistoryLedger({ ledger_index: '800' }, LIVE, l)).toBe(800);
    expect(await resolveTokenHistoryLedger({ ledger: '801' }, LIVE, l)).toBe(801);
    expect(await resolveTokenHistoryLedger({ ledger_hash: HASH.toLowerCase() }, LIVE, l)).toBe(700);
    expect(await resolveTokenHistoryLedger({ date: '2020-01-01T00:00:00Z' }, LIVE, l)).toBe(900);
    expect(l.byHash).toHaveBeenCalledWith(HASH);
  });

  it('a ledger is required where the route says so, before the selector is read', async () => {
    const l = lookups();
    expect(await messageOf(resolveTokenHistoryLedger({}, LIVE, l, { required: true }))).toBe('a ledger is required');
    expect(await messageOf(resolveTokenHistoryLedger({ ledger_index: 'abc' }, LIVE, l, { required: true }))).toBe(
      'a ledger is required',
    );
    expect(await resolveTokenHistoryLedger({ ledger_index: '900' }, LIVE, l, { required: true })).toBe(900);
  });

  it('the selector messages come before any read', async () => {
    const l = lookups();
    expect(await messageOf(resolveTokenHistoryLedger({ date: 'yesterday' }, LIVE, l))).toBe('invalid date format');
    expect(await messageOf(resolveTokenHistoryLedger({ ledger_hash: 'XYZ' }, LIVE, l))).toBe('invalid ledger hash');
    expect(l.atOrBefore).not.toHaveBeenCalled();
    expect(l.byHash).not.toHaveBeenCalled();
  });

  it('a ledger above through is ledger is not in the token history yet', async () => {
    expect(await messageOf(resolveTokenHistoryLedger({ ledger_index: '1001' }, LIVE, lookups()))).toBe(
      'ledger is not in the token history yet',
    );
  });

  it('a ledger below coverage_from is the date provided is too old', async () => {
    const l = lookups();
    expect(await messageOf(resolveTokenHistoryLedger({ ledger_index: '499' }, LIVE, l))).toBe(DATE_TOO_OLD);
    expect(await resolveTokenHistoryLedger({ ledger_index: '500' }, LIVE, l)).toBe(500);
    // a date no stored ledger is old enough for, and a hash that is not stored
    expect(await messageOf(resolveTokenHistoryLedger({ date: '2013-01-01' }, LIVE, l))).toBe(DATE_TOO_OLD);
    expect(await messageOf(resolveTokenHistoryLedger({ ledger_hash: 'CD'.repeat(32) }, LIVE, l))).toBe(DATE_TOO_OLD);
  });
});
