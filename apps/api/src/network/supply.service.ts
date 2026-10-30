import { ClickHouseService, NetworkProfile, newestSnapshot } from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { notFound } from '../common/errors';
import { FeatureCoverageService } from '../common/feature-coverage.service';
import { NETWORK_PROFILE } from '../config/api.config';
import { SupplyAnswer, SupplyCoverages, supplyFeaturesOf, supplyObject } from './supply-object';

/**
 * The supply of the network (spec 5.1): the newest snapshot the syncer's `supply` job wrote (`newestSnapshot`, two reads of the end
 * of the key of `network_supply`), and the coverage of each part of it that is read from history. A request with no snapshot yet
 * is 404 `supply not computed yet`, before any coverage is read. The coverage of every part the snapshot has is asked at once
 * (`FeatureCoverageService` keeps each 60 s, and a failed read fails the route with its 500); a part the snapshot does not have,
 * the reserves of a snapshot with no reserve values, say, is not asked.
 */
@Injectable()
export class SupplyService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly coverage: FeatureCoverageService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  /** The answer for the newest snapshot; throws 404 `supply not computed yet` before the first. */
  async snapshot(): Promise<SupplyAnswer> {
    const row = await newestSnapshot(this.ch);
    if (row === undefined) throw notFound('supply not computed yet');
    const features = supplyFeaturesOf(row, this.profile.hasMinting);
    // `escrows` is always among the features, so the object is whole once they are all in
    const coverages: Partial<SupplyCoverages> = {};
    await Promise.all(
      features.map(async (feature) => {
        coverages[feature] = await this.coverage.coverage(feature);
      }),
    );
    return supplyObject(row, this.profile.nativeCurrency, coverages as SupplyCoverages);
  }
}
