import * as validators from './index';

describe('validators index', () => {
  it('exports the rules of the validators and amendments data', () => {
    expect(Object.keys(validators).sort()).toEqual(
      [
        'RECORD_LIFETIME_SECONDS',
        'amendmentNeeded',
        'amendmentPasses',
        'amendmentThreshold',
        'compareTriples',
        'compareVersions',
        'decodeServerVersion',
        'isVotingLedger',
        'listInUse',
        'nextFlagLedger',
        'parseVersionTriple',
        'quorumOf',
        'recordOf',
        'trustedUnl',
        'votingLedgerAtOrAfter',
      ].sort(),
    );
  });
});
