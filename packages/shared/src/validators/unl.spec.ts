import { listInUse, StoredUnlList, trustedUnl } from './unl';

const DAY = 86_400;

function list(publisher: string, sequence: number, over: Partial<StoredUnlList> = {}): StoredUnlList {
  return {
    publisher,
    sequence,
    version: 2,
    expiration: 10 * DAY,
    validators: [],
    fetchedAt: sequence * 100,
    ...over,
  };
}

describe('listInUse (spec 2.1)', () => {
  it('is undefined without a row of the publisher', () => {
    expect(listInUse([], 'vl.ripple.com', 1_000)).toBeUndefined();
    expect(listInUse([list('unl.xrplf.org', 1)], 'vl.ripple.com', 1_000)).toBeUndefined();
  });

  it('takes the lowest sequence before the first fetch of the publisher', () => {
    const lists = [
      list('p', 7, { fetchedAt: 700 }),
      list('p', 5, { fetchedAt: 500 }),
      list('p', 6, { fetchedAt: 600 }),
    ];
    expect(listInUse(lists, 'p', 499)).toEqual({ list: lists[1], expired: false });
    expect(listInUse(lists, 'p', 0)).toEqual({ list: lists[1], expired: false });
  });

  it('reports the stand-in list as expired when its expiration has passed', () => {
    const lists = [list('p', 5, { fetchedAt: 500, expiration: 100 })];
    expect(listInUse(lists, 'p', 99)).toEqual({ list: lists[0], expired: false });
    expect(listInUse(lists, 'p', 100)).toEqual({ list: lists[0], expired: true });
  });

  it('is, from the first fetch on, the highest sequence that is in effect and has not expired', () => {
    const lists = [
      list('p', 5, { fetchedAt: 500 }),
      list('p', 7, { fetchedAt: 700 }),
      list('p', 6, { fetchedAt: 600 }),
    ];
    expect(listInUse([lists[0]], 'p', 500)).toEqual({ list: lists[0], expired: false });
    expect(listInUse(lists, 'p', 5_000)).toEqual({ list: lists[1], expired: false });
  });

  it('leaves the stand-in at the instant of the first fetch', () => {
    const lists = [
      list('p', 4, { fetchedAt: 500, expiration: 400 }),
      list('p', 5, { fetchedAt: 500, expiration: 9_999 }),
    ];
    expect(listInUse(lists, 'p', 499)).toEqual({ list: lists[0], expired: true });
    expect(listInUse(lists, 'p', 500)).toEqual({ list: lists[1], expired: false });
  });

  it('skips a list whose effective time is still ahead', () => {
    const lists = [
      list('p', 5, { fetchedAt: 500 }),
      list('p', 6, { fetchedAt: 600, effective: 2_000 }),
      list('p', 7, { fetchedAt: 700, effective: 3_000 }),
    ];
    expect(listInUse(lists, 'p', 1_999)?.list.sequence).toBe(5);
    expect(listInUse(lists, 'p', 2_000)?.list.sequence).toBe(6); // effective <= t
    expect(listInUse(lists, 'p', 2_999)?.list.sequence).toBe(6);
    expect(listInUse(lists, 'p', 3_000)?.list.sequence).toBe(7);
  });

  it('treats a list without an effective time as effective always', () => {
    const lists = [list('p', 5, { fetchedAt: 500 })];
    expect(listInUse(lists, 'p', 500)?.list.sequence).toBe(5);
  });

  it('skips a list whose expiration is at or before t', () => {
    const lists = [
      list('p', 5, { fetchedAt: 500, expiration: 10_000 }),
      list('p', 6, { fetchedAt: 600, expiration: 2_000 }),
    ];
    expect(listInUse(lists, 'p', 1_999)?.list.sequence).toBe(6);
    expect(listInUse(lists, 'p', 2_000)).toEqual({ list: lists[0], expired: false });
  });

  it('falls back to the newest list, flagged expired, when every list has expired', () => {
    const lists = [
      list('p', 5, { fetchedAt: 500, expiration: 1_000 }),
      list('p', 7, { fetchedAt: 700, expiration: 2_000 }),
      list('p', 6, { fetchedAt: 600, expiration: 3_000 }),
    ];
    expect(listInUse(lists, 'p', 3_000)).toEqual({ list: lists[1], expired: true });
    expect(listInUse(lists, 'p', 9_999_999)).toEqual({ list: lists[1], expired: true });
  });

  it('looks only at the rows of the publisher asked for', () => {
    const lists = [list('a', 9, { fetchedAt: 900 }), list('b', 2, { fetchedAt: 200 })];
    expect(listInUse(lists, 'a', 1_000)?.list.sequence).toBe(9);
    expect(listInUse(lists, 'b', 1_000)?.list.sequence).toBe(2);
    expect(listInUse(lists, 'b', 100)?.list.sequence).toBe(2);
  });
});

describe('trustedUnl', () => {
  const a1 = list('a', 1, { validators: ['n1', 'n2', 'n3'], fetchedAt: 100 });
  const b1 = list('b', 1, { validators: ['n2', 'n3', 'n4'], fetchedAt: 100 });

  it('is the union of the lists at a threshold of 1', () => {
    expect([...trustedUnl([a1, b1], ['a', 'b'], 1, 1_000)].sort()).toEqual(['n1', 'n2', 'n3', 'n4']);
  });

  it('is the intersection of two lists at a threshold of 2', () => {
    expect([...trustedUnl([a1, b1], ['a', 'b'], 2, 1_000)].sort()).toEqual(['n2', 'n3']);
  });

  it('is empty when the threshold is more than the lists in use', () => {
    expect(trustedUnl([a1, b1], ['a', 'b'], 3, 1_000).size).toBe(0);
    expect(trustedUnl([a1], ['a', 'b'], 2, 1_000).size).toBe(0);
  });

  it('is empty without publishers or without lists', () => {
    expect(trustedUnl([a1, b1], [], 1, 1_000).size).toBe(0);
    expect(trustedUnl([], ['a', 'b'], 1, 1_000).size).toBe(0);
  });

  it('counts only the publishers it is given', () => {
    expect([...trustedUnl([a1, b1], ['a'], 1, 1_000)].sort()).toEqual(['n1', 'n2', 'n3']);
    expect(trustedUnl([a1, b1], ['a'], 2, 1_000).size).toBe(0);
  });

  it('counts a validator once per list, however often the list names it', () => {
    const repeated = list('a', 1, { validators: ['n1', 'n1', 'n1'], fetchedAt: 100 });
    expect(trustedUnl([repeated], ['a'], 2, 1_000).size).toBe(0);
    expect([...trustedUnl([repeated], ['a'], 1, 1_000)]).toEqual(['n1']);
  });

  it('reads each publisher at the list in use at t', () => {
    const a2 = list('a', 2, { validators: ['n9'], fetchedAt: 500, effective: 600 });
    expect([...trustedUnl([a1, a2], ['a'], 1, 599)].sort()).toEqual(['n1', 'n2', 'n3']);
    expect([...trustedUnl([a1, a2], ['a'], 1, 600)].sort()).toEqual(['n9']);
  });

  it('still trusts the validators of an expired list: an old UNL is better than none', () => {
    const old = list('a', 1, { validators: ['n1'], fetchedAt: 100, expiration: 500 });
    expect([...trustedUnl([old], ['a'], 1, 9_999)]).toEqual(['n1']);
  });

  it('stands the oldest list in for a time before the first fetch', () => {
    expect([...trustedUnl([a1], ['a'], 1, 10)].sort()).toEqual(['n1', 'n2', 'n3']);
  });
});

describe('the publisher key of a stored list', () => {
  const OLD_KEY = `ED${'11'.repeat(32)}`;
  const NEW_KEY = `ED${'22'.repeat(32)}`;

  it('is carried by the list and not looked at by listInUse and trustedUnl', () => {
    const lists = [
      list('p', 7, { publisherKey: OLD_KEY, validators: ['nHa'] }),
      list('p', 3, { publisherKey: NEW_KEY, validators: ['nHb'], fetchedAt: 700 }),
    ];
    // the readers pick by sequence whatever the key; a caller that keeps the rows of one key filters them first
    expect(listInUse(lists, 'p', 800)?.list.publisherKey).toBe(OLD_KEY);
    expect(trustedUnl(lists, ['p'], 1, 800)).toEqual(new Set(['nHa']));
    const own = lists.filter((l) => l.publisherKey === NEW_KEY);
    expect(listInUse(own, 'p', 800)?.list.publisherKey).toBe(NEW_KEY);
    expect(trustedUnl(own, ['p'], 1, 800)).toEqual(new Set(['nHb']));
  });
});
