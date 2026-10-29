import { stableStringify } from './stable-json';

describe('stableStringify', () => {
  it('sorts the keys of an object at every depth, arrays keep their order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [{ f: 1, e: 2 }] } })).toBe('{"a":{"c":[{"e":2,"f":1}],"d":2},"b":1}');
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('is the same text for two objects that differ only in key order', () => {
    expect(stableStringify({ x: 1, y: { q: [1, 2], p: null } })).toBe(
      stableStringify({ y: { p: null, q: [1, 2] }, x: 1 }),
    );
  });

  it('writes the values as JSON.stringify does', () => {
    expect(stableStringify('text')).toBe('"text"');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(7)).toBe('7');
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableStringify([undefined])).toBe('[null]');
    expect(stableStringify({ a: new Date(0) })).toBe('{"a":"1970-01-01T00:00:00.000Z"}');
    expect(stableStringify(undefined)).toBeUndefined();
  });

  it('sorts keys by the default string order, so "10" comes before "2" (an object literal would list "2" first)', () => {
    expect(Object.keys({ b: 1, a: 1, B: 1, 10: 1, 2: 1 })).toEqual(['2', '10', 'b', 'a', 'B']);
    expect(stableStringify({ b: 1, a: 1, B: 1, 10: 1, 2: 1 })).toBe('{"10":1,"2":1,"B":1,"a":1,"b":1}');
  });
});
