import {
  ClickHouseService,
  getNetworkProfile,
  NetworkName,
  NFT_PARSER_VERSION,
  OBJECT_PARSER_VERSION,
} from '@gatehub/data-api-shared';
import { AmendmentsAssembly, AmendmentView, findAmendment } from '../validators/amendment-status';
import { AmendmentsService } from '../validators/amendments.service';
import { CacheService } from './cache.service';
import { COVERAGE_FEATURES, CoverageFeature } from './coverage-features';
import { COVERAGE_KEYS, FEATURE_COVERAGE_CACHE_MS, FeatureCoverageService } from './feature-coverage.service';

const NFTS_ENABLED = 75_443_457;
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

/** The ledgers of the `ledgers` table, each `[ledger_index, parser_version]`. */
type Stored = [number, number][];

/**
 * The stored ledgers from which the rows of parser `version` start at `from`: an older ledger right below it (none when
 * `from` is the first ledger there is), and the ledger of the version itself.
 */
const startingAt = (from: number, version: number = NFT_PARSER_VERSION): Stored =>
  from > 1
    ? [
        [from - 1, version - 1],
        [from, version],
      ]
    : [[from, version]];

/** A ClickHouse that answers the two reads of the coverage the way their SQL defines them, over `ledgers`. */
function fakeClickHouse(ledgers: Stored) {
  const query = jest.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    const indexes = (rows: Stored) => rows.map(([index]) => index);
    if (sql.includes('parser_version <')) {
      const older = indexes(ledgers.filter(([, version]) => version < (params.version as number)));
      return [{ ledger_index: older.length === 0 ? null : Math.max(...older) }];
    }
    if (sql.includes('minOrNull(ledger_index)')) {
      return [{ first_ledger: ledgers.length === 0 ? null : Math.min(...indexes(ledgers)) }];
    }
    throw new Error(`unexpected read: ${sql}`);
  });
  return { query, queryOne: async (sql: string, params?: Record<string, unknown>) => (await query(sql, params))[0] };
}

/** How many reads of the stored ledgers reached ClickHouse. */
const ledgerReads = (ch: ReturnType<typeof fakeClickHouse>): number => ch.query.mock.calls.length;

/** An amendment of the assembly, enabled in `ledgerIndex` (never, when it is left out). */
function amendment(name: string, ledgerIndex?: number, source: 'ledger' | 'metadata' = 'ledger'): AmendmentView {
  return {
    id: name.length.toString(16).padStart(64, 'A'),
    name,
    status: ledgerIndex === undefined ? 'voting' : 'enabled',
    history: [],
    ...(ledgerIndex !== undefined && { enabled: { ledgerIndex, source } }),
  };
}

function assemblyOf(...amendments: AmendmentView[]): AmendmentsAssembly {
  return {
    amendments,
    byId: new Map(amendments.map((each) => [each.id, each])),
  } as unknown as AmendmentsAssembly;
}

interface Setup {
  network: NetworkName;
  ledgers: Stored;
  amendments: AmendmentView[];
}

function setup(options: Partial<Setup> = {}) {
  const { network = 'xrpl', ledgers = startingAt(NFTS_ENABLED), amendments = [] } = options;
  const ch = fakeClickHouse(ledgers);
  const cache = new CacheService();
  const service = { get: jest.fn(async () => assemblyOf(...amendments)), find: findAmendment };
  const svc = new FeatureCoverageService(
    ch as unknown as ClickHouseService,
    cache,
    service as unknown as AmendmentsService,
    getNetworkProfile(network),
  );
  return { svc, ch, cache, amendmentsGet: service.get };
}

describe('FeatureCoverageService', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW }));
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('the nfts feature', () => {
    it('is complete when the feature starts at or below the enable ledger', async () => {
      const amendments = [amendment('NonFungibleTokensV1_1', NFTS_ENABLED)];
      const same = setup({ ledgers: startingAt(NFTS_ENABLED), amendments });
      expect(await same.svc.coverage('nfts')).toEqual({ from_ledger_index: NFTS_ENABLED, complete: true });

      const below = setup({ ledgers: startingAt(NFTS_ENABLED - 1000), amendments });
      expect(await below.svc.coverage('nfts')).toEqual({ from_ledger_index: NFTS_ENABLED - 1000, complete: true });

      const above = setup({ ledgers: startingAt(NFTS_ENABLED + 1), amendments });
      expect(await above.svc.coverage('nfts')).toEqual({ from_ledger_index: NFTS_ENABLED + 1, complete: false });
    });

    it('reads the enable ledger the amendments assembly reports, from the ledger or the metadata file', async () => {
      const fromLedger = setup({
        ledgers: startingAt(NFTS_ENABLED),
        amendments: [amendment('NonFungibleTokensV1_1', NFTS_ENABLED, 'ledger')],
      });
      expect((await fromLedger.svc.coverage('nfts')).complete).toBe(true);

      const fromFile = setup({
        ledgers: startingAt(NFTS_ENABLED),
        amendments: [amendment('NonFungibleTokensV1_1', NFTS_ENABLED, 'metadata')],
      });
      expect((await fromFile.svc.coverage('nfts')).complete).toBe(true);

      // the enable ledger is the assembly's, never a constant: an amendment enabled later moves the answer
      const later = setup({
        ledgers: startingAt(NFTS_ENABLED),
        amendments: [amendment('NonFungibleTokensV1_1', NFTS_ENABLED - 1)],
      });
      expect(await later.svc.coverage('nfts')).toEqual({ from_ledger_index: NFTS_ENABLED, complete: false });
    });

    it('is complete: false when the assembly knows no enable ledger for the amendment', async () => {
      const voting = setup({ amendments: [amendment('NonFungibleTokensV1_1')] });
      expect(await voting.svc.coverage('nfts')).toEqual({ from_ledger_index: NFTS_ENABLED, complete: false });

      const unknown = setup({ amendments: [amendment('SomethingElse', 1)] });
      expect(await unknown.svc.coverage('nfts')).toEqual({ from_ledger_index: NFTS_ENABLED, complete: false });
    });

    it('a testnet is complete: false without an indexed EnableAmendment', async () => {
      // a testnet ignores the metadata file's enable ledgers, so its assembly has no enabled for the amendment
      const without = setup({ network: 'xrpl-testnet', amendments: [amendment('NonFungibleTokensV1_1')] });
      expect(await without.svc.coverage('nfts')).toEqual({ from_ledger_index: NFTS_ENABLED, complete: false });

      // with an indexed one, the rule is the same as on a mainnet
      const early = setup({
        network: 'xrpl-testnet',
        ledgers: startingAt(5),
        amendments: [amendment('NonFungibleTokensV1_1', 7)],
      });
      expect(await early.svc.coverage('nfts')).toEqual({ from_ledger_index: 5, complete: true });
    });

    it('xahau URIToken is complete from ledger 1', async () => {
      const amendments = [amendment('URIToken', 1, 'metadata'), amendment('NonFungibleTokensV1_1')];
      const first = setup({ network: 'xahau', ledgers: startingAt(1), amendments });
      expect(await first.svc.coverage('nfts')).toEqual({ from_ledger_index: 1, complete: true });

      const second = setup({ network: 'xahau', ledgers: startingAt(2), amendments });
      expect(await second.svc.coverage('nfts')).toEqual({ from_ledger_index: 2, complete: false });
    });

    it('takes the amendment of the family on a testnet: URIToken on xahau-testnet', async () => {
      const amendments = [amendment('URIToken', 100), amendment('NonFungibleTokensV1_1', 1)];
      const xahau = setup({ network: 'xahau-testnet', ledgers: startingAt(100), amendments });
      expect(await xahau.svc.coverage('nfts')).toEqual({ from_ledger_index: 100, complete: true });

      const xrpl = setup({ network: 'xrpl-testnet', ledgers: startingAt(100), amendments });
      expect(await xrpl.svc.coverage('nfts')).toEqual({ from_ledger_index: 100, complete: false });
    });

    it('answers { complete: false } without from_ledger_index when no ledger is stored', async () => {
      const { svc, amendmentsGet } = setup({ ledgers: [], amendments: [amendment('NonFungibleTokensV1_1', 1)] });
      const answer = await svc.coverage('nfts');
      expect(answer).toEqual({ complete: false });
      expect(Object.keys(answer)).toEqual(['complete']);
      // nothing is known to compare with: the amendments are not even read
      expect(amendmentsGet).not.toHaveBeenCalled();
    });

    it('starts above the newest ledger an older parser wrote, and at the oldest stored ledger when none did', async () => {
      const amendments = [amendment('NonFungibleTokensV1_1', NFTS_ENABLED)];
      const rewritten = setup({
        ledgers: [
          [10, 3],
          [NFTS_ENABLED + 5, 4],
          [20, NFT_PARSER_VERSION],
          [NFTS_ENABLED + 9, NFT_PARSER_VERSION],
        ],
        amendments,
      });
      expect(await rewritten.svc.coverage('nfts')).toEqual({ from_ledger_index: NFTS_ENABLED + 6, complete: false });

      const allNew = setup({
        ledgers: [
          [NFTS_ENABLED - 3, NFT_PARSER_VERSION],
          [NFTS_ENABLED + 9, NFT_PARSER_VERSION],
        ],
        amendments,
      });
      expect(await allNew.svc.coverage('nfts')).toEqual({ from_ledger_index: NFTS_ENABLED - 3, complete: true });
    });
  });

  describe('the features of D5', () => {
    // Escrow and PayChan are retired amendments: the assembly gives them an `enabled` object only when the ledger lists them
    // (the metadata file's ledger then), so a test that wants them enabled names the ledger
    const ESCROW_ENABLED = 28_685_313;
    const OBJECTS = OBJECT_PARSER_VERSION;

    it('xahau escrows are complete from ledger 1 and xrpl escrows from 28685313', async () => {
      // Xahau lists neither Escrow nor PayChan: its escrows start at its first ledger, with no amendment read
      const first = setup({ network: 'xahau', ledgers: startingAt(1, OBJECTS) });
      expect(await first.svc.coverage('escrows')).toEqual({ from_ledger_index: 1, complete: true });
      expect(first.amendmentsGet).not.toHaveBeenCalled();
      const second = setup({ network: 'xahau', ledgers: startingAt(2, OBJECTS) });
      expect(await second.svc.coverage('escrows')).toEqual({ from_ledger_index: 2, complete: false });

      const amendments = [amendment('Escrow', ESCROW_ENABLED, 'metadata')];
      const at = setup({ ledgers: startingAt(ESCROW_ENABLED, OBJECTS), amendments });
      expect(await at.svc.coverage('escrows')).toEqual({ from_ledger_index: ESCROW_ENABLED, complete: true });
      const after = setup({ ledgers: startingAt(ESCROW_ENABLED + 1, OBJECTS), amendments });
      expect(await after.svc.coverage('escrows')).toEqual({ from_ledger_index: ESCROW_ENABLED + 1, complete: false });
    });

    it('an xrpl-testnet escrow is complete false without an indexed EnableAmendment', async () => {
      const without = setup({
        network: 'xrpl-testnet',
        ledgers: startingAt(5, OBJECTS),
        amendments: [amendment('Escrow')],
      });
      expect(await without.svc.coverage('escrows')).toEqual({ from_ledger_index: 5, complete: false });
      const indexed = setup({
        network: 'xrpl-testnet',
        ledgers: startingAt(5, OBJECTS),
        amendments: [amendment('Escrow', 3, 'ledger')],
      });
      expect(await indexed.svc.coverage('escrows')).toEqual({ from_ledger_index: 5, complete: false });
      const early = setup({
        network: 'xrpl-testnet',
        ledgers: startingAt(5, OBJECTS),
        amendments: [amendment('Escrow', 7, 'ledger')],
      });
      expect(await early.svc.coverage('escrows')).toEqual({ from_ledger_index: 5, complete: true });
    });

    it('a testnet of Xahau is complete false for escrows and complete true for delegations, which it cannot have', async () => {
      const { svc, amendmentsGet } = setup({ network: 'xahau-testnet', ledgers: startingAt(9, OBJECTS) });
      expect(await svc.coverage('escrows')).toEqual({ from_ledger_index: 9, complete: false });
      expect(await svc.coverage('delegations')).toEqual({ from_ledger_index: 9, complete: true });
      expect(amendmentsGet).not.toHaveBeenCalled();
      expect(svc.isAvailable('delegations')).toBe(false);
      expect(svc.isAvailable('escrows')).toBe(true);
    });

    it('delegations follow PermissionDelegationV1_1 where the network has it, and are complete on Xahau', async () => {
      const enabled = 107_524_865;
      const amendments = [amendment('PermissionDelegationV1_1', enabled, 'metadata')];
      const xrpl = setup({ ledgers: startingAt(enabled, OBJECTS), amendments });
      expect(await xrpl.svc.coverage('delegations')).toEqual({ from_ledger_index: enabled, complete: true });
      const later = setup({ ledgers: startingAt(enabled + 1, OBJECTS), amendments });
      expect(await later.svc.coverage('delegations')).toEqual({ from_ledger_index: enabled + 1, complete: false });
      const xahau = setup({ network: 'xahau', ledgers: startingAt(8_852_809, OBJECTS) });
      expect(await xahau.svc.coverage('delegations')).toEqual({ from_ledger_index: 8_852_809, complete: true });
    });

    it('checks and payment channels follow their amendments', async () => {
      const checks = setup({ ledgers: startingAt(56_219_905, OBJECTS), amendments: [amendment('Checks', 56_219_905)] });
      expect(await checks.svc.coverage('checks')).toEqual({ from_ledger_index: 56_219_905, complete: true });
      const channels = setup({
        ledgers: startingAt(ESCROW_ENABLED + 1, OBJECTS),
        amendments: [amendment('PayChan', ESCROW_ENABLED, 'metadata')],
      });
      expect(await channels.svc.coverage('payment_channels')).toEqual({
        from_ledger_index: ESCROW_ENABLED + 1,
        complete: false,
      });
    });

    it('is the parser of the objects that decides where the rows start, not the NFT parser', async () => {
      // ledgers of the NFT parser (5) but not of the object parser (7) lie below 100: the escrows start above them
      const { svc } = setup({
        network: 'xahau',
        ledgers: [
          [90, NFT_PARSER_VERSION],
          [100, OBJECTS],
        ],
      });
      expect(await svc.coverage('escrows')).toEqual({ from_ledger_index: 91, complete: false });
    });

    it("an escrow created at or above the coverage is complete whatever came before; the feature's is kept", async () => {
      const { svc } = setup({ network: 'xahau', ledgers: startingAt(2_000, OBJECTS) });
      expect(await svc.itemCoverage('escrows', 2_000)).toEqual({ from_ledger_index: 2_000, complete: true });
      expect(await svc.itemCoverage('escrows', 1_999)).toEqual({ from_ledger_index: 2_000, complete: false });
      expect(await svc.itemCoverage('escrows', undefined)).toEqual({ from_ledger_index: 2_000, complete: false });
    });
  });

  describe('coverageOf', () => {
    const FIRST_LEDGER: CoverageFeature = { parserVersion: 3, startOf: () => ({ kind: 'first_ledger' }) };

    it('a feature without an amendment starts at firstLedger', async () => {
      const xrplFrom = setup({ ledgers: startingAt(32570, 3) });
      expect(await xrplFrom.svc.coverageOf('t', FIRST_LEDGER)).toEqual({ from_ledger_index: 32570, complete: true });

      const xrplLater = setup({ ledgers: startingAt(32571, 3) });
      expect(await xrplLater.svc.coverageOf('t', FIRST_LEDGER)).toEqual({ from_ledger_index: 32571, complete: false });

      const xahau = setup({ network: 'xahau', ledgers: startingAt(1, 3) });
      expect(await xahau.svc.coverageOf('t', FIRST_LEDGER)).toEqual({ from_ledger_index: 1, complete: true });

      // a testnet has no first ledger of its history that is indexed: never complete
      const testnet = setup({ network: 'xahau-testnet', ledgers: startingAt(1, 3) });
      expect(await testnet.svc.coverageOf('t', FIRST_LEDGER)).toEqual({ from_ledger_index: 1, complete: false });
      expect(testnet.amendmentsGet).not.toHaveBeenCalled();
    });

    it('a feature the network cannot have is complete with its from_ledger_index', async () => {
      const unavailable: CoverageFeature = { parserVersion: 3, startOf: () => ({ kind: 'unavailable' }) };
      const { svc, amendmentsGet } = setup({ network: 'xrpl-testnet', ledgers: startingAt(500, 3) });
      expect(await svc.coverageOf('t', unavailable)).toEqual({ from_ledger_index: 500, complete: true });
      expect(amendmentsGet).not.toHaveBeenCalled();
    });

    it('a feature that cannot be had answers { complete: false } too when no ledger is stored', async () => {
      const unavailable: CoverageFeature = { parserVersion: 3, startOf: () => ({ kind: 'unavailable' }) };
      const { svc } = setup({ ledgers: [] });
      expect(await svc.coverageOf('t', unavailable)).toEqual({ complete: false });
    });

    it('hands the profile of the network to the feature', async () => {
      const startOf = jest.fn(() => ({ kind: 'first_ledger' }) as const);
      const { svc } = setup({ network: 'xahau-testnet', ledgers: startingAt(9, 3) });
      await svc.coverageOf('t', { parserVersion: 3, startOf });
      expect(startOf).toHaveBeenCalledWith(getNetworkProfile('xahau-testnet'));
    });
  });

  describe('keeping an answer', () => {
    it('keeps an answer 60 s per feature', async () => {
      const { svc, ch, amendmentsGet } = setup({ amendments: [amendment('NonFungibleTokensV1_1', NFTS_ENABLED)] });
      const first = await svc.coverage('nfts');
      const second = await svc.coverage('nfts');
      expect(second).toBe(first);
      expect(ledgerReads(ch)).toBe(1);
      expect(amendmentsGet).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(FEATURE_COVERAGE_CACHE_MS - 1);
      await svc.coverage('nfts');
      expect(ledgerReads(ch)).toBe(1);
      expect(amendmentsGet).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1);
      await svc.coverage('nfts');
      expect(ledgerReads(ch)).toBe(2);
      expect(amendmentsGet).toHaveBeenCalledTimes(2);
    });

    it('is 60 s', () => expect(FEATURE_COVERAGE_CACHE_MS).toBe(60_000));

    it('keeps the answer under feature-coverage:<name>, and coverageOf under its own key', async () => {
      const { svc, cache, ch } = setup({ amendments: [amendment('NonFungibleTokensV1_1', NFTS_ENABLED)] });
      const answer = await svc.coverage('nfts');
      expect(cache.get('feature-coverage:nfts')).toBe(answer);

      // coverageOf with the name of a registered feature is the very same entry
      expect(await svc.coverageOf('nfts', COVERAGE_FEATURES.nfts)).toBe(answer);
      expect(ledgerReads(ch)).toBe(1);

      await svc.coverageOf('other', { parserVersion: 3, startOf: () => ({ kind: 'unavailable' }) });
      expect(cache.get('feature-coverage:other')).toBeDefined();
      expect(ledgerReads(ch)).toBeGreaterThan(1); // the other key is a read of its own
    });

    it('rejects when the stored ledgers cannot be read, and keeps nothing of the failure', async () => {
      const { svc, ch, cache } = setup({ amendments: [amendment('NonFungibleTokensV1_1', NFTS_ENABLED)] });
      ch.query.mockRejectedValueOnce(new Error('clickhouse is down'));
      await expect(svc.coverage('nfts')).rejects.toThrow('clickhouse is down');
      expect(cache.get('feature-coverage:nfts')).toBeUndefined();
      expect(await svc.coverage('nfts')).toEqual({ from_ledger_index: NFTS_ENABLED, complete: true });
    });

    it('rejects when the amendments cannot be read, and keeps nothing of the failure', async () => {
      const { svc, amendmentsGet, cache } = setup({ amendments: [amendment('NonFungibleTokensV1_1', NFTS_ENABLED)] });
      amendmentsGet.mockRejectedValueOnce(new Error('amendments are down'));
      await expect(svc.coverage('nfts')).rejects.toThrow('amendments are down');
      expect(cache.get('feature-coverage:nfts')).toBeUndefined();
      expect((await svc.coverage('nfts')).complete).toBe(true);
    });
  });

  describe('itemCoverage', () => {
    it('is complete for an item created at or above from_ledger_index', async () => {
      // the feature is incomplete: it starts above the enable ledger
      const { svc } = setup({
        ledgers: startingAt(NFTS_ENABLED + 1),
        amendments: [amendment('NonFungibleTokensV1_1', NFTS_ENABLED)],
      });
      const from = NFTS_ENABLED + 1;
      expect(await svc.itemCoverage('nfts', from + 2)).toEqual({ from_ledger_index: from, complete: true });
      expect(await svc.itemCoverage('nfts', from)).toEqual({ from_ledger_index: from, complete: true });
      expect(await svc.itemCoverage('nfts', from - 1)).toEqual({ from_ledger_index: from, complete: false });
      expect(await svc.itemCoverage('nfts', undefined)).toEqual({ from_ledger_index: from, complete: false });
    });

    it('is the feature coverage for an item of a complete feature, whatever it was created in', async () => {
      const { svc } = setup({ amendments: [amendment('NonFungibleTokensV1_1', NFTS_ENABLED)] });
      expect(await svc.itemCoverage('nfts', undefined)).toEqual({ from_ledger_index: NFTS_ENABLED, complete: true });
      expect(await svc.itemCoverage('nfts', 1)).toEqual({ from_ledger_index: NFTS_ENABLED, complete: true });
    });

    it('is complete: false with no stored ledger, even for an item with a creation ledger', async () => {
      const { svc } = setup({ ledgers: [] });
      expect(await svc.itemCoverage('nfts', 75_443_460)).toEqual({ complete: false });
    });

    it('does not change the answer kept for the feature', async () => {
      const { svc, cache } = setup({
        ledgers: startingAt(NFTS_ENABLED + 1),
        amendments: [amendment('NonFungibleTokensV1_1', NFTS_ENABLED)],
      });
      await svc.itemCoverage('nfts', NFTS_ENABLED + 50);
      expect(cache.get('feature-coverage:nfts')).toEqual({ from_ledger_index: NFTS_ENABLED + 1, complete: false });
      expect(await svc.coverage('nfts')).toEqual({ from_ledger_index: NFTS_ENABLED + 1, complete: false });
    });
  });

  describe('isAvailable', () => {
    it.each(['xrpl', 'xahau', 'xrpl-testnet', 'xahau-testnet'] as const)('has nfts on %s', (network) => {
      expect(setup({ network }).svc.isAvailable('nfts')).toBe(true);
    });

    it('has no feature whose start is unavailable on the network', () => {
      const unavailable = { parserVersion: 3, startOf: () => ({ kind: 'unavailable' }) };
      jest.replaceProperty(COVERAGE_FEATURES, 'nfts', unavailable as unknown as typeof COVERAGE_FEATURES.nfts);
      expect(setup().svc.isAvailable('nfts')).toBe(false);
    });
  });

  describe('the answer', () => {
    it('writes from_ledger_index before complete', async () => {
      const { svc } = setup({ amendments: [amendment('NonFungibleTokensV1_1', NFTS_ENABLED)] });
      expect(COVERAGE_KEYS).toEqual(['from_ledger_index', 'complete']);
      expect(Object.keys(await svc.coverage('nfts'))).toEqual([...COVERAGE_KEYS]);
      expect(Object.keys(await svc.itemCoverage('nfts', 1))).toEqual([...COVERAGE_KEYS]);

      const incomplete = setup({
        ledgers: startingAt(NFTS_ENABLED + 1),
        amendments: [amendment('NonFungibleTokensV1_1', NFTS_ENABLED)],
      });
      expect(Object.keys(await incomplete.svc.itemCoverage('nfts', NFTS_ENABLED + 2))).toEqual([...COVERAGE_KEYS]);
    });
  });

  describe('the registry', () => {
    it('registers nfts with the NFT parser, the amendment of the family', () => {
      expect(COVERAGE_FEATURES.nfts.parserVersion).toBe(NFT_PARSER_VERSION);
      expect(COVERAGE_FEATURES.nfts.startOf(getNetworkProfile('xrpl'))).toEqual({
        kind: 'amendment',
        amendment: 'NonFungibleTokensV1_1',
      });
      expect(COVERAGE_FEATURES.nfts.startOf(getNetworkProfile('xrpl-testnet'))).toEqual({
        kind: 'amendment',
        amendment: 'NonFungibleTokensV1_1',
      });
      expect(COVERAGE_FEATURES.nfts.startOf(getNetworkProfile('xahau'))).toEqual({
        kind: 'amendment',
        amendment: 'URIToken',
      });
      expect(COVERAGE_FEATURES.nfts.startOf(getNetworkProfile('xahau-testnet'))).toEqual({
        kind: 'amendment',
        amendment: 'URIToken',
      });
    });
  });
});
