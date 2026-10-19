import { getNetworkProfile } from '../network';
import { amendmentsCheckFindings } from './amendments-check';
import { amendmentId, AmendmentsConfig, parseAmendmentsConfig } from './amendments-config';

const config: AmendmentsConfig = parseAmendmentsConfig(
  {
    network: 'xrpl',
    updated: '2026-10-19',
    amendments: [
      { name: 'AMM', enabled: { ledger_index: 86795265, date: '2024-03-22' } },
      { name: 'Clawback', enabled: { date: '2024-02-08' } },
      { name: 'DID' },
    ],
  },
  getNetworkProfile('xrpl'),
);

const AMM = amendmentId('AMM');
const CLAWBACK = amendmentId('Clawback');
const DID = amendmentId('DID');
/** An amendment the file does not name. */
const OTHER = amendmentId('SomethingNew');
const OTHER_TOO = amendmentId('SomethingElse');

const none = { missingNames: [], unnamedIds: [], contradictions: [] };

describe('amendmentsCheckFindings (spec 2.6)', () => {
  it('finds nothing when the file covers the node and the ledger', () => {
    expect(
      amendmentsCheckFindings({
        config,
        nodeFeatures: [
          { id: AMM, name: 'AMM' },
          { id: DID, name: 'DID' },
        ],
        ledgerIds: [AMM, CLAWBACK, DID],
        votedIds: [DID],
        enabledEvents: [{ id: AMM, ledgerIndex: 86795265 }],
      }),
    ).toEqual(none);
  });

  it('works with the node, the ledger and nothing else', () => {
    expect(amendmentsCheckFindings({ config, nodeFeatures: [], ledgerIds: [] })).toEqual(none);
  });

  describe('missingNames', () => {
    it('lists the names the node knows and the file lacks, sorted and once', () => {
      const findings = amendmentsCheckFindings({
        config,
        nodeFeatures: [
          { id: OTHER, name: 'SomethingNew' },
          { id: AMM, name: 'AMM' },
          { id: OTHER_TOO, name: 'SomethingElse' },
          { id: OTHER, name: 'SomethingNew' },
        ],
        ledgerIds: [],
      });
      expect(findings.missingNames).toEqual(['SomethingElse', 'SomethingNew']);
    });

    it('does not list an ID the node has no name for', () => {
      expect(amendmentsCheckFindings({ config, nodeFeatures: [{ id: OTHER }], ledgerIds: [] }).missingNames).toEqual(
        [],
      );
    });
  });

  describe('unnamedIds', () => {
    it('lists an ID of the ledger that neither the file nor the node names', () => {
      const findings = amendmentsCheckFindings({
        config,
        nodeFeatures: [{ id: AMM, name: 'AMM' }],
        ledgerIds: [AMM, OTHER],
      });
      expect(findings.unnamedIds).toEqual([OTHER]);
      expect(findings.missingNames).toEqual([]);
    });

    it('does not list an ID that only the node names (that is a missing name)', () => {
      const findings = amendmentsCheckFindings({
        config,
        nodeFeatures: [{ id: OTHER, name: 'SomethingNew' }],
        ledgerIds: [OTHER],
      });
      expect(findings.unnamedIds).toEqual([]);
      expect(findings.missingNames).toEqual(['SomethingNew']);
    });

    it('does not list an ID that only the file names', () => {
      expect(amendmentsCheckFindings({ config, nodeFeatures: [], ledgerIds: [DID] }).unnamedIds).toEqual([]);
    });

    it('lists an ID the node has an entry for but no name', () => {
      expect(amendmentsCheckFindings({ config, nodeFeatures: [{ id: OTHER }], ledgerIds: [OTHER] }).unnamedIds).toEqual(
        [OTHER],
      );
    });

    it('also takes the IDs of the current votes, and lists each once, sorted', () => {
      const [low, high] = [OTHER, OTHER_TOO].sort();
      const findings = amendmentsCheckFindings({
        config,
        nodeFeatures: [],
        ledgerIds: [high, low],
        votedIds: [high, DID, low],
      });
      expect(findings.unnamedIds).toEqual([low, high]);
    });

    it('compares IDs without regard to case', () => {
      const findings = amendmentsCheckFindings({
        config,
        nodeFeatures: [{ id: OTHER.toLowerCase(), name: 'SomethingNew' }],
        ledgerIds: [AMM.toLowerCase(), OTHER.toLowerCase()],
      });
      expect(findings.unnamedIds).toEqual([]);
    });
  });

  describe('contradictions', () => {
    it('lists a file ledger index that differs from the indexed event', () => {
      const findings = amendmentsCheckFindings({
        config,
        nodeFeatures: [],
        ledgerIds: [],
        enabledEvents: [{ id: AMM, ledgerIndex: 86795266 }],
      });
      expect(findings.contradictions).toEqual([{ name: 'AMM', file: 86795265, indexed: 86795266 }]);
    });

    it('accepts the same ledger index', () => {
      expect(
        amendmentsCheckFindings({
          config,
          nodeFeatures: [],
          ledgerIds: [],
          enabledEvents: [{ id: AMM, ledgerIndex: 86795265 }],
        }).contradictions,
      ).toEqual([]);
    });

    it('leaves out an entry without a ledger index, or without `enabled`, or that the file lacks', () => {
      expect(
        amendmentsCheckFindings({
          config,
          nodeFeatures: [],
          ledgerIds: [],
          enabledEvents: [
            { id: CLAWBACK, ledgerIndex: 85829633 },
            { id: DID, ledgerIndex: 91778561 },
            { id: OTHER, ledgerIndex: 1 },
          ],
        }).contradictions,
      ).toEqual([]);
    });

    it('lists a contradiction once: the same event indexed twice, or under an ID of another case', () => {
      const findings = amendmentsCheckFindings({
        config,
        nodeFeatures: [],
        ledgerIds: [],
        enabledEvents: [
          { id: AMM, ledgerIndex: 86795266 },
          { id: AMM.toLowerCase(), ledgerIndex: 86795266 },
          { id: AMM, ledgerIndex: 86795266 },
          // another indexed ledger is another contradiction
          { id: AMM, ledgerIndex: 86795267 },
        ],
      });
      expect(findings.contradictions).toEqual([
        { name: 'AMM', file: 86795265, indexed: 86795266 },
        { name: 'AMM', file: 86795265, indexed: 86795267 },
      ]);
    });

    it('is sorted by name', () => {
      const wide = parseAmendmentsConfig(
        {
          network: 'xrpl',
          updated: '2026-10-19',
          amendments: [
            { name: 'Zed', enabled: { ledger_index: 2 } },
            { name: 'Alpha', enabled: { ledger_index: 1 } },
          ],
        },
        getNetworkProfile('xrpl'),
      );
      const findings = amendmentsCheckFindings({
        config: wide,
        nodeFeatures: [],
        ledgerIds: [],
        enabledEvents: [
          { id: amendmentId('Zed'), ledgerIndex: 20 },
          { id: amendmentId('Alpha'), ledgerIndex: 10 },
        ],
      });
      expect(findings.contradictions).toEqual([
        { name: 'Alpha', file: 1, indexed: 10 },
        { name: 'Zed', file: 2, indexed: 20 },
      ]);
    });
  });
});
