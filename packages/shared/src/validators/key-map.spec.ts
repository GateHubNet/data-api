import { Table } from '../clickhouse/tables';
import { keyMapParams, MANIFEST_MAP_SQL } from './key-map';

describe('keyMapParams', () => {
  it('gives the ephemeral keys and their masters side by side, in the order of the rows', () => {
    expect(
      keyMapParams([
        { ephemeral_key: 'n9B', master_key: 'nHB' },
        { ephemeral_key: 'n9A', master_key: 'nHA' },
        { ephemeral_key: 'n9C', master_key: 'nHA' },
      ]),
    ).toEqual({ ephemerals: ['n9B', 'n9A', 'n9C'], masters: ['nHB', 'nHA', 'nHA'] });
  });

  it('gives two empty lists for no rows', () => {
    expect(keyMapParams([])).toEqual({ ephemerals: [], masters: [] });
  });

  it('ignores the other columns of a row and does not change the rows', () => {
    const rows = [{ ephemeral_key: 'n9A', master_key: 'nHA', seq: 3 }];
    const frozen = JSON.stringify(rows);
    expect(keyMapParams(rows)).toEqual({ ephemerals: ['n9A'], masters: ['nHA'] });
    expect(JSON.stringify(rows)).toBe(frozen);
  });
});

describe('MANIFEST_MAP_SQL', () => {
  it('reads the master of the highest seq per ephemeral key from the manifests table, with no parameter', () => {
    expect(MANIFEST_MAP_SQL).toContain(`FROM ${Table.ValidatorManifests}`);
    expect(MANIFEST_MAP_SQL).toContain('argMax(master_key, seq)');
    expect(MANIFEST_MAP_SQL).toContain('GROUP BY ephemeral_key');
    expect(MANIFEST_MAP_SQL).not.toMatch(/\{\w+:/);
  });
});
