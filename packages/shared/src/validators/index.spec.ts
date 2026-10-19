import * as validators from './index';

describe('validators index', () => {
  it('exports the rules of the validators and amendments data', () => {
    expect(Object.keys(validators).sort()).toEqual(
      [
        'ManifestError',
        'RECORD_LIFETIME_SECONDS',
        'REVOKED_SEQUENCE',
        'UnlListError',
        'amendmentNeeded',
        'amendmentPasses',
        'amendmentThreshold',
        'classifyUnlBlob',
        'compareTriples',
        'compareVersions',
        'decodeManifest',
        'decodeServerVersion',
        'isNodePublicKey',
        'isProperlyFormedTomlDomain',
        'isVotingLedger',
        'listInUse',
        'nextFlagLedger',
        'nodePublicKeyFromHex',
        'nodePublicKeyToHex',
        'parseVersionTriple',
        'quorumOf',
        'recordOf',
        'trustedUnl',
        'verifyManifest',
        'verifyUnlList',
        'votingLedgerAtOrAfter',
      ].sort(),
    );
  });
});
