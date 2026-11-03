import { ClickHouseService, unlAt, UnlListsRow } from '@gatehub/data-api-shared';
import { testKey } from '../../../../packages/shared/src/test-utils/validator-keys';
import { loadListContext } from './stored-lists';
import { localListRow } from './unl-fetcher';

const NOW = Date.parse('2026-10-19T12:00:00.000Z') / 1000;
const HOUR = 3600;

const K = [0, 1, 2, 3].map((i) => testKey(`fixed-${i}`).base58);
const PUBLISHER = testKey('stored-lists-publisher');
const URL = 'https://unl.example';
const ID = 'unl.example';

/** A ClickHouse that answers the read of `unl_lists` from rows, by the `publishers` of the query, in the shape of its columns. */
function fakeClickHouse(rows: UnlListsRow[]) {
  const query = jest.fn(async (_sql: string, params: Record<string, unknown> = {}) => {
    const wanted = params.publishers as string[];
    return rows
      .filter((row) => wanted.includes(row.publisher))
      .map((row) => ({
        publisher: row.publisher,
        publisher_key: row.publisher_key,
        sequence: Number(row.sequence),
        version: row.version,
        effective: row.effective,
        expiration: row.expiration,
        validators: row.validators,
        fetched_ms: Math.round(row.fetched_at * 1000),
      }));
  });
  return { ch: { query } as unknown as Pick<ClickHouseService, 'query'>, query };
}

const publishersOf = (query: jest.Mock) =>
  query.mock.calls.map((call) => (call[1] as { publishers: string[] }).publishers);

describe('loadListContext', () => {
  it('reads the fixed list beside the publishers, and trusts its validators at threshold 1', async () => {
    const { ch, query } = fakeClickHouse([localListRow(K, 1, NOW - HOUR)]);

    const context = await loadListContext(ch, { unlPublishers: '', unlValidators: K.join(','), unlThreshold: 0 });

    expect(context.publishers).toEqual(['local']);
    expect(context.threshold).toBe(1);
    expect(publishersOf(query)).toEqual([['local']]);
    expect(context.lists).toEqual([
      {
        publisher: 'local',
        publisherKey: '',
        sequence: 1,
        version: 1,
        effective: Math.floor(NOW - HOUR),
        expiration: 4_294_967_295,
        validators: [...K].sort(),
        fetchedAt: NOW - HOUR,
      },
    ]);
    expect([...unlAt(context.lists, context.publishers, context.threshold, NOW)].sort()).toEqual([...K].sort());
  });

  it('counts the fixed list beside the publishers: the configured ids, then local', async () => {
    const { ch, query } = fakeClickHouse([]);

    const context = await loadListContext(ch, {
      unlPublishers: `${URL}=${PUBLISHER.publicKeyHex}`,
      unlValidators: K[0],
      unlThreshold: 0,
    });

    expect(context.publishers).toEqual([ID, 'local']);
    expect(publishersOf(query)).toEqual([[ID, 'local']]);
    expect(context.threshold).toBe(1);
  });

  it('counts the fixed list as a list: at threshold 2 a validator needs the publisher to name it too', async () => {
    const publisherList: UnlListsRow = {
      publisher: ID,
      publisher_key: PUBLISHER.publicKeyHex,
      sequence: 4,
      version: 1,
      effective: null,
      expiration: NOW + 30 * 86_400,
      validators: [K[0], K[1]],
      blob_sha256: 'AB'.repeat(32),
      fetched_at: NOW - HOUR,
      response: '{}',
    };
    const { ch } = fakeClickHouse([publisherList, localListRow([K[0], K[2]], 1, NOW - HOUR)]);

    const context = await loadListContext(ch, {
      unlPublishers: `${URL}=${PUBLISHER.publicKeyHex}`,
      unlValidators: [K[0], K[2]].join(','),
      unlThreshold: 2,
    });

    // two lists, both name K[0]; K[1] and K[2] are on one list each
    expect([...unlAt(context.lists, context.publishers, context.threshold, NOW)]).toEqual([K[0]]);
  });

  it('leaves local out when the fixed list is empty', async () => {
    const { ch, query } = fakeClickHouse([localListRow(K, 1, NOW - HOUR)]);

    const context = await loadListContext(ch, {
      unlPublishers: `${URL}=${PUBLISHER.publicKeyHex}`,
      unlValidators: '',
      unlThreshold: 0,
    });

    expect(context.publishers).toEqual([ID]);
    expect(publishersOf(query)).toEqual([[ID]]);
    expect(context.lists).toEqual([]);
    expect(context.threshold).toBe(1);
  });

  it('reads nothing when there is neither a publisher nor a fixed list', async () => {
    const { ch, query } = fakeClickHouse([localListRow(K, 1, NOW - HOUR)]);

    const context = await loadListContext(ch, { unlPublishers: '', unlValidators: '', unlThreshold: 0 });

    expect(context).toEqual({ lists: [], publishers: [], threshold: 1 });
    expect(query).not.toHaveBeenCalled();
  });
});
