import { Table } from '../clickhouse/tables';
import { KEY_MAP_WITH, MANIFEST_MAP_SQL, mappedKey, NEWEST_MANIFEST_ORDER } from './key-map';

describe('MANIFEST_MAP_SQL', () => {
  it('reads the master of the highest seq per ephemeral key from the manifests table, with no parameter', () => {
    expect(MANIFEST_MAP_SQL).toContain(`FROM ${Table.ValidatorManifests}`);
    expect(MANIFEST_MAP_SQL).toContain('argMax(master_key, seq) AS map_master');
    expect(MANIFEST_MAP_SQL).toContain('GROUP BY ephemeral_key');
    expect(MANIFEST_MAP_SQL).not.toMatch(/\{\w+:/);
  });

  it('leaves out a row without a master key', () => {
    expect(MANIFEST_MAP_SQL).toMatch(/WHERE master_key != ''/);
  });

  it('does not name an aggregate after the column it reads', () => {
    expect(MANIFEST_MAP_SQL).not.toMatch(/\bAS master_key\b/);
  });
});

describe('KEY_MAP_WITH', () => {
  it('is the map as one scalar of two aligned arrays, named key_map, read from MANIFEST_MAP_SQL in one pass', () => {
    expect(KEY_MAP_WITH).toBe(
      `(SELECT tuple(groupArray(ephemeral_key), groupArray(map_master)) FROM (${MANIFEST_MAP_SQL})) AS key_map`,
    );
  });

  it('has no parameter: the map travels in no URL', () => {
    expect(KEY_MAP_WITH).not.toMatch(/\{\w+:/);
  });
});

describe('mappedKey', () => {
  it('maps a column through key_map, leaving a key the map does not know as it is', () => {
    expect(mappedKey('validation_public_key')).toBe(
      'transform(validation_public_key, key_map.1, key_map.2, validation_public_key)',
    );
  });
});

describe('NEWEST_MANIFEST_ORDER', () => {
  it('orders by seq, and among rows of one seq puts the one with the raw manifest last (argMax takes it)', () => {
    expect(NEWEST_MANIFEST_ORDER).toBe('(seq, notEmpty(manifest))');
  });
});
