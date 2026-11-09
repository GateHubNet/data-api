import { snapshotDigest } from './digest';

describe('snapshotDigest', () => {
  it('the digest of the empty set is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', () => {
    expect(snapshotDigest([])).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('the digest of rA,1 and rB,2.5 is 7026d968e9ec57f2fee6c54aefb39a9a9ba0124f6900af79799c4e003c0dc589', () => {
    const lines = [
      { holder: 'rA', balance: '1' },
      { holder: 'rB', balance: '2.5' },
    ];
    expect(snapshotDigest(lines)).toBe('7026d968e9ec57f2fee6c54aefb39a9a9ba0124f6900af79799c4e003c0dc589');
    // in the given order: the reverse is another digest
    expect(snapshotDigest([...lines].reverse())).not.toBe(snapshotDigest(lines));
  });

  it('takes any iterable, a generator too', () => {
    function* lines() {
      yield { holder: 'rA', balance: '1' };
      yield { holder: 'rB', balance: '2.5' };
    }
    expect(snapshotDigest(lines())).toBe('7026d968e9ec57f2fee6c54aefb39a9a9ba0124f6900af79799c4e003c0dc589');
  });
});
