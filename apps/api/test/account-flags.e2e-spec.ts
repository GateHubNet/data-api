import { AccountsCreatedRow, STATE_PARSER_VERSION, Table } from '@gatehub/data-api-shared';
import { ApiClient, Harness, rippledError, startHarness } from './harness';
import { liveNode, NodeRequest } from './support/live-node';

/**
 * `GET /v2/accounts/:address?flags=true`: the account flags of an account, at a ledger named by `date`, `ledger_index` or
 * `ledger_hash` from the account state history in ClickHouse (ADR-0015), and without one from the live node.
 *
 * The recorded ledgers activate almost nobody, and the route answers 404 without an activation, so each account a test
 * looks up gets an `accounts_created` row by hand: the lookup itself is not what these tests are about.
 */

/** An activation of each account that the lookup finds: the ledger it names does not matter to the flags. */
async function activate(h: Harness, ...accounts: string[]): Promise<void> {
  const rows: AccountsCreatedRow[] = accounts.map((account, i) => ({
    account,
    parent: 'rrrrrrrrrrrrrrrrrrrrBZbvji',
    initial_balance: '100',
    ledger_index: 1000 + i,
    tx_index: 0,
    tx_hash: 'A'.repeat(64),
    inception: 1_600_000_000,
    genesis_balance: null,
    genesis_index: null,
  }));
  await h.ch.insert(Table.AccountsCreated, rows);
}

/**
 * A `ledgers` row written by a parser that did not record state yet: a copy of the first ledger of the table with this
 * index, a hash of its own and this close time (unix seconds).
 */
async function insertOlderParserLedger(h: Harness, ledger: number, closeTime: number): Promise<void> {
  await h.ch.command(
    `INSERT INTO ${Table.Ledgers}
     SELECT tpl.* REPLACE (toUInt32({ledger:UInt32}) AS ledger_index, toDateTime({time:UInt32}, 'UTC') AS close_time,
                           {hash:String} AS ledger_hash, toUInt16({version:UInt16}) AS parser_version)
       FROM (SELECT * FROM ${Table.Ledgers} ORDER BY ledger_index LIMIT 1) AS tpl`,
    {
      ledger,
      time: closeTime,
      hash: ledger.toString(16).toUpperCase().padStart(64, '0'),
      version: STATE_PARSER_VERSION - 1,
    },
  );
}

/** What a node answers for `account_info`: the account with these `Flags`, on the validated ledger 70000000. */
function accountInfo(req: NodeRequest, flags: number): Record<string, unknown> {
  return {
    account_data: { Account: req.account, Balance: '100000000', Flags: flags, LedgerEntryType: 'AccountRoot' },
    ledger_index: 70_000_000,
    validated: true,
  };
}

const TOO_OLD = { result: 'error', message: 'the date provided is too old' };

/** The account flags of Xahau, every one false: the names of xahaud's `LedgerFormats.h`, in the order of their bits. */
const XAHAU_NONE = {
  AllowTrustLineClawback: false,
  PasswordSpent: false,
  RequireDestTag: false,
  RequireAuth: false,
  DisallowXRP: false,
  DisableMaster: false,
  NoFreeze: false,
  GlobalFreeze: false,
  DefaultRipple: false,
  DepositAuth: false,
  TshCollect: false,
  DisallowIncomingNFTokenOffer: false,
  DisallowIncomingCheck: false,
  DisallowIncomingPayChan: false,
  DisallowIncomingTrustline: false,
  URITokenIssuer: false,
  DisallowIncomingRemit: false,
};

/** The account flags of the XRP Ledger, every one false: `LEDGER_ENTRY_FLAGS.AccountRoot` of its definitions, by bit. */
const XRPL_NONE = {
  PasswordSpent: false,
  RequireDestTag: false,
  RequireAuth: false,
  DisallowXRP: false,
  DisableMaster: false,
  NoFreeze: false,
  GlobalFreeze: false,
  DefaultRipple: false,
  DepositAuth: false,
  DisallowIncomingNFTokenOffer: false,
  DisallowIncomingCheck: false,
  DisallowIncomingPayChan: false,
  DisallowIncomingTrustline: false,
  AllowTrustLineLocking: false,
  AllowTrustLineClawback: false,
};

describe('GET /v2/accounts/:address?flags=true', () => {
  describe('the XRP Ledger (xrpl-account-state)', () => {
    /** Created in 93663329; an AccountSet sets DefaultRipple in 93663330; SetRegularKey and DisableMaster in 93663334. */
    const ISSUER = 'rKqSPjN6okYt7iPk3xzWvuW9oN1Nk7vSUV';
    /** PasswordSpent in 107872956; a Payment of XRP to it clears the flag in 107872958. */
    const SPENT = 'rheEvN3wAWbnPwnnsisiJzUqqKqoUC14tw';
    /** Changed last in 107670694; deletes itself with AccountDelete in 107671593. */
    const DELETED = 'r3CgerzsDtZhh3ejvDjZJUKqXqRVWQcnNC';
    const node = liveNode();
    let h: Harness;
    let api: ApiClient;

    beforeAll(async () => {
      h = await startHarness({ seed: 'xrpl-account-state', xrplStub: node.stub, env: { GH_LIVE_CACHE_TTL_MS: '0' } });
      api = await h.api();
      await activate(h, ISSUER, SPENT, DELETED);
    });
    afterAll(async () => {
      await h?.close();
    });
    beforeEach(() => node.serve((req) => accountInfo(req, 0)));

    const flagsAt = async (account: string, ledger: number): Promise<Record<string, boolean>> => {
      const res = await api.get(`/v2/accounts/${account}?flags=true&ledger_index=${ledger}`);
      expect({ account, ledger, status: res.status }).toEqual({ account, ledger, status: 200 });
      expect(res.body.ledger_index).toBe(ledger);
      return res.body.account_data.flags;
    };

    it('flags before and after an AccountSet that sets DefaultRipple', async () => {
      expect(await flagsAt(ISSUER, 93663329)).toEqual(XRPL_NONE);
      expect(await flagsAt(ISSUER, 93663330)).toEqual({ ...XRPL_NONE, DefaultRipple: true });
      expect(await flagsAt(ISSUER, 93663334)).toEqual({
        ...XRPL_NONE,
        DefaultRipple: true,
        PasswordSpent: true,
        DisableMaster: true,
      });
      expect(node.requests()).toEqual([]);
    });

    it('names the flags of the XRP Ledger, from its definitions, in the order of their bits', async () => {
      expect(Object.keys(await flagsAt(ISSUER, 93663330))).toEqual(Object.keys(XRPL_NONE));
    });

    it('the date of the AccountSet answers with its ledger and close time', async () => {
      const res = await api.get(`/v2/accounts/${ISSUER}?flags=true&date=2025-01-24T00:36:55Z`);
      expect(res.status).toBe(200);
      expect(res.body.ledger_index).toBe(93663330);
      expect(res.body.close_time).toBe('2025-01-24T00:36:50Z');
      expect(res.body.account_data.flags).toEqual({ ...XRPL_NONE, DefaultRipple: true });
    });

    it('a flag changed by another transaction type: a Payment of XRP clears PasswordSpent', async () => {
      expect(await flagsAt(SPENT, 107872956)).toEqual({ ...XRPL_NONE, PasswordSpent: true });
      expect(await flagsAt(SPENT, 107872958)).toEqual(XRPL_NONE);
    });

    it('a deleted account has flags before its AccountDelete, and is 404 account not found from it on', async () => {
      expect(await flagsAt(DELETED, 107670694)).toEqual(XRPL_NONE);
      for (const query of ['ledger_index=107671593', 'ledger_index=107872958', 'date=2026-10-20T00:00:00Z']) {
        const res = await api.get(`/v2/accounts/${DELETED}?flags=true&${query}`);
        expect({ query, status: res.status, body: res.body }).toEqual({
          query,
          status: 404,
          body: { result: 'error', message: 'account not found' },
        });
      }
    });
  });

  describe("Xahau's flags (xahau-recorded)", () => {
    /** Xahau ledger 26540188: a GenesisMint pays it, with DepositAuth and DisallowIncomingRemit (0x81000000) set. */
    const REMIT_SHY = 'rD74dUPRFNfgnY2NzrxxYRXN4BrfGSN6Mv';
    const LEDGER = 26540188;
    const CLOSED = '2026-10-15T09:45:31Z';
    /** Ledger 26540711 (closed 10:17:01): a Cron runs on this hook account, which has TshCollect (0x2000000) set. */
    const HOOKED = 'rLqimfBcsc4x9Gy9jTfZUNktvJFLzTnv2n';
    const LATER = 26540711;
    const LATER_HASH = '2554EA8EE1580604506F81837B9102FAA202444E1FC00176F0C3E936781E5B49';
    const LATER_CLOSED = '2026-10-15T10:17:01Z';
    /** Not an address, and never activated. */
    const NOBODY = 'rNeverActivatedNeverActivatedNeve';
    const node = liveNode();
    let h: Harness;
    let api: ApiClient;

    beforeAll(async () => {
      h = await startHarness({ seed: 'xahau-recorded', xrplStub: node.stub, env: { GH_LIVE_CACHE_TTL_MS: '0' } });
      api = await h.api();
      await activate(h, REMIT_SHY, HOOKED);
    });
    afterAll(async () => {
      await h?.close();
    });
    beforeEach(() => node.serve((req) => accountInfo(req, 0x02000000)));

    it("names the flags of Xahau: bit 0x80000000 is DisallowIncomingRemit there (XRPL's AllowTrustLineClawback)", async () => {
      const res = await api.get(`/v2/accounts/${REMIT_SHY}?flags=true&ledger_index=${LEDGER}`);
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('success');
      expect(res.body.ledger_index).toBe(LEDGER);
      expect(res.body.close_time).toBe(CLOSED);
      expect(res.body.account_data.flags).toEqual({ ...XAHAU_NONE, DepositAuth: true, DisallowIncomingRemit: true });
      expect(Object.keys(res.body.account_data.flags)).toEqual(Object.keys(XAHAU_NONE));
      expect(node.requests()).toEqual([]);
    });

    it('a hook account has TshCollect, a flag the XRP Ledger does not have', async () => {
      const res = await api.get(`/v2/accounts/${HOOKED}?flags=true&ledger_index=${LATER}`);
      expect(res.status).toBe(200);
      expect(res.body.account_data.flags).toEqual({ ...XAHAU_NONE, TshCollect: true });
    });

    it('the answer is the ledger it was read at, then the account with its flags last', async () => {
      const res = await api.get(`/v2/accounts/${REMIT_SHY}?flags=true&ledger_index=${LEDGER}`);
      expect(Object.keys(res.body)).toEqual(['result', 'ledger_index', 'close_time', 'account_data']);
      expect(Object.keys(res.body.account_data)).toEqual([
        'account',
        'parent',
        'initial_balance',
        'inception',
        'ledger_index',
        'tx_hash',
        'flags',
      ]);
    });

    it('the flags at a later ledger are those of the last change at or before it', async () => {
      const res = await api.get(`/v2/accounts/${REMIT_SHY}?flags=true&ledger_index=${LATER}`);
      expect(res.status).toBe(200);
      expect(res.body.ledger_index).toBe(LATER);
      expect(res.body.close_time).toBe(LATER_CLOSED);
      expect(res.body.account_data.flags).toEqual({ ...XAHAU_NONE, DepositAuth: true, DisallowIncomingRemit: true });
    });

    it('a date reads the last ledger closed at or before it', async () => {
      const res = await api.get(`/v2/accounts/${REMIT_SHY}?flags=true&date=2026-10-15T09:50:00Z`);
      expect(res.status).toBe(200);
      expect(res.body.ledger_index).toBe(LEDGER);
      expect(res.body.close_time).toBe(CLOSED);
    });

    it('close_time is an alias of date, and ledger of ledger_index', async () => {
      const byCloseTime = await api.get(`/v2/accounts/${REMIT_SHY}?flags=true&close_time=2026-10-15T09:45:31Z`);
      expect(byCloseTime.body.ledger_index).toBe(LEDGER);
      const byLedger = await api.get(`/v2/accounts/${REMIT_SHY}?flags=true&ledger=${LATER}`);
      expect(byLedger.body.ledger_index).toBe(LATER);
    });

    it('a ledger hash names its ledger, in any case', async () => {
      const res = await api.get(`/v2/accounts/${REMIT_SHY}?flags=true&ledger_hash=${LATER_HASH.toLowerCase()}`);
      expect(res.status).toBe(200);
      expect(res.body.ledger_index).toBe(LATER);
      expect(res.body.close_time).toBe(LATER_CLOSED);
    });

    it('the precedence of /balances: a hash wins over a date, a date over a ledger number', async () => {
      const all = await api.get(
        `/v2/accounts/${REMIT_SHY}?flags=true&ledger_hash=${LATER_HASH}&date=2026-10-15T09:50:00Z&ledger_index=${LEDGER}`,
      );
      expect(all.body.ledger_index).toBe(LATER);
      const dateAndIndex = await api.get(
        `/v2/accounts/${REMIT_SHY}?flags=true&date=2026-10-15T09:50:00Z&ledger_index=${LATER}`,
      );
      expect(dateAndIndex.body.ledger_index).toBe(LEDGER);
    });

    it('a ledger this API does not hold, or a date before the first one, is 400 the date provided is too old', async () => {
      for (const query of ['ledger_index=26540189', `ledger_hash=${'AB'.repeat(32)}`, 'date=2020-01-01T00:00:00Z']) {
        const res = await api.get(`/v2/accounts/${REMIT_SHY}?flags=true&${query}`);
        expect({ query, status: res.status, body: res.body }).toEqual({ query, status: 400, body: TOO_OLD });
      }
      expect(node.requests()).toEqual([]);
    });

    it('an account with no state at the ledger is 404 account not found', async () => {
      // HOOKED changes first in ledger 26540711: at 26540188 the state tables know nothing of it
      const res = await api.get(`/v2/accounts/${HOOKED}?flags=true&ledger_index=${LEDGER}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ result: 'error', message: 'account not found' });
    });

    it('a malformed date or hash is 400, before the lookup', async () => {
      const date = await api.get(`/v2/accounts/${REMIT_SHY}?flags=true&date=yesterday`);
      expect(date.status).toBe(400);
      expect(date.body).toEqual({ result: 'error', message: 'invalid date format' });
      const hash = await api.get(`/v2/accounts/${NOBODY}?flags=true&ledger_hash=ABC`);
      expect(hash.status).toBe(400);
      expect(hash.body).toEqual({ result: 'error', message: 'invalid ledger hash' });
    });

    it('without a ledger the flags come from account_info of the validated ledger on the node', async () => {
      const res = await api.get(`/v2/accounts/${HOOKED}?flags=true`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        result: 'success',
        ledger_index: 70_000_000,
        account_data: expect.objectContaining({ account: HOOKED, flags: { ...XAHAU_NONE, TshCollect: true } }),
      });
      expect(node.requests()).toEqual([{ command: 'account_info', account: HOOKED, ledger_index: 'validated' }]);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('validated, closed and current are read on the node too', async () => {
      for (const word of ['validated', 'closed', 'current']) {
        node.serve((req) => accountInfo(req, 0));
        const res = await api.get(`/v2/accounts/${HOOKED}?flags=true&ledger_index=${word}`);
        expect({ word, status: res.status }).toEqual({ word, status: 200 });
        expect(node.requests()).toEqual([{ command: 'account_info', account: HOOKED, ledger_index: word }]);
      }
    });

    it('an account the node does not have is 404 account not found', async () => {
      node.serve(() => {
        throw rippledError('actNotFound', 'Account not found.');
      });
      const res = await api.get(`/v2/accounts/${HOOKED}?flags=true`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ result: 'error', message: 'account not found' });
    });

    it('without flags=true the route answers as before and reads nothing new', async () => {
      for (const query of ['', '?flags=false', `?ledger_index=${LEDGER}`, '?date=yesterday', '?ledger_hash=ABC']) {
        const res = await api.get(`/v2/accounts/${REMIT_SHY}${query}`);
        expect({ query, status: res.status }).toEqual({ query, status: 200 });
        expect(Object.keys(res.body)).toEqual(['result', 'account_data']);
        expect(res.body.account_data.flags).toBeUndefined();
      }
      expect(node.requests()).toEqual([]);
    });

    it('an address without an activation is still 404 Account not found, and no flag is read', async () => {
      const res = await api.get(`/v2/accounts/${NOBODY}?flags=true`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ result: 'error', message: 'Account not found' });
      expect(node.requests()).toEqual([]);
    });
  });

  describe('the coverage of the state tables (xahau-recorded, and a ledger an older parser wrote)', () => {
    /** The recorded ledgers are 26540187, 26540188, 26540613, 26540711, 26541051 and 26541060. */
    const REMIT_SHY = 'rD74dUPRFNfgnY2NzrxxYRXN4BrfGSN6Mv';
    /** Written by parser version 2, between the recorded ledgers: the coverage starts above it. */
    const OLDER = 26540500;
    let h: Harness;
    let api: ApiClient;

    beforeAll(async () => {
      h = await startHarness({ seed: 'xahau-recorded' });
      api = await h.api();
      await activate(h, REMIT_SHY);
      // closed at 10:00:00, between 26540188 (09:45:31) and 26540613
      await insertOlderParserLedger(h, OLDER, 1_792_058_400);
    });
    afterAll(async () => {
      await h?.close();
    });

    it('a ledger at or below the newest one an older parser wrote is too old, even one the newer parser wrote', async () => {
      for (const ledger of [26540187, 26540188, OLDER]) {
        const res = await api.get(`/v2/accounts/${REMIT_SHY}?flags=true&ledger_index=${ledger}`);
        expect({ ledger, status: res.status, body: res.body }).toEqual({ ledger, status: 400, body: TOO_OLD });
      }
    });

    it('a date before the coverage is too old', async () => {
      const res = await api.get(`/v2/accounts/${REMIT_SHY}?flags=true&date=2026-10-15T10:05:00Z`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual(TOO_OLD);
    });

    it('a ledger above it is covered, whatever gap lies between the two', async () => {
      const res = await api.get(`/v2/accounts/${REMIT_SHY}?flags=true&ledger_index=26540613`);
      expect(res.status).toBe(200);
      expect(res.body.ledger_index).toBe(26540613);
    });
  });
});
