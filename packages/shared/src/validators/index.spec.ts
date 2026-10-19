import * as validators from './index';

describe('validators index', () => {
  it('exports the rules of the validators and amendments data', () => {
    expect(Object.keys(validators).sort()).toEqual(
      [
        'AMENDMENTS_OBJECT_INDEX',
        'FEE_SETTINGS_OBJECT_INDEX',
        'MANIFEST_MAP_SQL',
        'ManifestError',
        'NEGATIVE_UNL_OBJECT_INDEX',
        'NEWEST_MANIFEST_ORDER',
        'RECORD_LIFETIME_SECONDS',
        'REVOKED_SEQUENCE',
        'UnlListError',
        'amendmentId',
        'amendmentNeeded',
        'amendmentPasses',
        'amendmentThreshold',
        'amendmentsCheckFindings',
        'classifyUnlBlob',
        'compareTriples',
        'compareVersions',
        'decodeManifest',
        'decodeServerVersion',
        'isNodePublicKey',
        'isProperlyFormedTomlDomain',
        'isVotingLedger',
        'keyMapParams',
        'listInUse',
        'loadAmendmentsConfig',
        'nextFlagLedger',
        'nodePublicKeyFromHex',
        'nodePublicKeyToHex',
        'parseAmendmentsConfig',
        'parseVersionTriple',
        'quorumOf',
        'recordOf',
        'trustedUnl',
        'unlAt',
        'verifyManifest',
        'verifyUnlList',
        'votingLedgerAtOrAfter',
      ].sort(),
    );
  });
});
