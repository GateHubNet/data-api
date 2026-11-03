import { ClickHouseService, coverageFrom, NetworkProfile } from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { NETWORK_PROFILE } from '../config/api.config';
import { AmendmentsService } from '../validators/amendments.service';
import { CacheService } from './cache.service';
import { COVERAGE_FEATURES, CoverageFeature, CoverageFeatureName } from './coverage-features';

/** The `coverage` of an answer (spec §4). `from_ledger_index` is left out when no ledger is stored. */
export interface Coverage {
  from_ledger_index?: number;
  complete: boolean;
}

/** The keys of `Coverage`, in the order an answer writes them (tests pin the order with it). */
export const COVERAGE_KEYS = ['from_ledger_index', 'complete'] as const;

/**
 * How long the coverage of a feature is kept. It moves only when ledgers are written or rewritten by an older parser (a
 * reprocess, a backfill), or when an amendment is enabled, never with the live ingest.
 */
export const FEATURE_COVERAGE_CACHE_MS = 60_000;

/**
 * Whether the history a feature's rows are read from is whole (spec §4): the one coverage service of program 2. Features
 * are registered in `COVERAGE_FEATURES`; a route asks for its feature by name and defines no rule of its own.
 *
 * `from_ledger_index` is where the rows of the feature's parser start (`coverageFrom`: one above the newest stored ledger
 * an older parser wrote, else the oldest stored ledger). `complete` is that ledger being at or below the ledger the feature
 * starts at (E):
 *  - an amendment's E is the ledger it was enabled in, as `AmendmentsService` reports it (the indexed `EnableAmendment`,
 *    else, on a mainnet, the metadata file; a testnet ignores the file's enable ledgers, so there only an indexed one
 *    counts). With no E known the feature is incomplete;
 *  - a feature as old as the network starts at `NetworkProfile.firstLedger`, none on a testnet;
 *  - a feature the network cannot have is complete: nothing can be missing.
 *
 * With no stored ledger the answer is `{ complete: false }`. A failed read rejects (the route answers its 500) and is not kept.
 */
@Injectable()
export class FeatureCoverageService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly cache: CacheService,
    private readonly amendments: AmendmentsService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  /** The coverage of a registered feature, kept 60 s under `feature-coverage:<name>`. */
  coverage(name: CoverageFeatureName): Promise<Coverage> {
    return this.coverageOf(name, COVERAGE_FEATURES[name]);
  }

  /** The rule itself, for a feature that is not registered (tests): kept 60 s under `feature-coverage:<key>`. */
  coverageOf(key: string, feature: CoverageFeature): Promise<Coverage> {
    return this.cache.wrap(`feature-coverage:${key}`, FEATURE_COVERAGE_CACHE_MS, () => this.compute(feature));
  }

  /**
   * The coverage of one item (an NFT, an object) created in `createdLedger`: the feature's, and complete also when the
   * item's creation is indexed (its ledger is at or above `from_ledger_index`), whatever came before it.
   */
  async itemCoverage(name: CoverageFeatureName, createdLedger: number | undefined): Promise<Coverage> {
    const coverage = await this.coverage(name);
    const from = coverage.from_ledger_index;
    if (coverage.complete || from === undefined || createdLedger === undefined || createdLedger < from) return coverage;
    return { from_ledger_index: from, complete: true };
  }

  /** Whether the network can have the feature at all: a route of a feature it cannot have reads no table. */
  isAvailable(name: CoverageFeatureName): boolean {
    // widened: the registry's own types are the narrow ones of its entries (`satisfies`), a feature may start any way
    const feature: CoverageFeature = COVERAGE_FEATURES[name];
    return feature.startOf(this.profile).kind !== 'unavailable';
  }

  private async compute(feature: CoverageFeature): Promise<Coverage> {
    const from = await coverageFrom(this.ch, feature.parserVersion);
    if (from === null) return { complete: false };
    const start = feature.startOf(this.profile);
    if (start.kind === 'unavailable') return { from_ledger_index: from, complete: true };
    const enabledAt =
      start.kind === 'first_ledger' ? this.profile.firstLedger : await this.enableLedgerOf(start.amendment);
    return { from_ledger_index: from, complete: enabledAt !== undefined && from <= enabledAt };
  }

  /** The ledger the amendment was enabled in, `undefined` when none is known. */
  private async enableLedgerOf(amendment: string): Promise<number | undefined> {
    const assembly = await this.amendments.get();
    return this.amendments.find(assembly, amendment)?.enabled?.ledgerIndex;
  }
}
