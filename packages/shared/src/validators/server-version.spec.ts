import {
  compareTriples,
  compareVersions,
  decodeServerVersion,
  parseVersionTriple,
  ServerVersion,
} from './server-version';

/** The UInt64 of `sfServerVersion` (F3, F4) as the decimal text the `validations` stream carries. */
function encode(major: number, minor: number, patch: number, release: number, build = 0, prefix = 0x183bn): string {
  return (
    (prefix << 48n) |
    (BigInt(major) << 40n) |
    (BigInt(minor) << 32n) |
    (BigInt(patch) << 24n) |
    (BigInt(release) << 16n) |
    BigInt(build)
  ).toString();
}

function rippled(raw: string): ServerVersion {
  const decoded = decodeServerVersion(raw, 'rippled');
  if (!decoded) throw new Error(`not decoded: ${raw}`);
  return decoded;
}

describe('decodeServerVersion', () => {
  it('decodes rippled releases, release candidates and betas (F3)', () => {
    expect(decodeServerVersion('1745992596280311808', 'rippled')).toMatchObject({ version: '3.4.1', release: true });
    expect(decodeServerVersion('1745991501042745344', 'rippled')).toMatchObject({
      version: '2.5.0-rc1',
      release: false,
    });
    expect(decodeServerVersion('1745991501038682112', 'rippled')).toMatchObject({
      version: '2.5.0-b3',
      release: false,
    });
  });

  it('gives the triple and the stage of a rippled build', () => {
    expect(rippled('1745992596280311808')).toEqual({ version: '3.4.1', triple: [3, 4, 1], release: true, stage: 3 });
    expect(rippled('1745991501042745344')).toEqual({
      version: '2.5.0-rc1',
      triple: [2, 5, 0],
      release: false,
      stage: 2,
    });
    expect(rippled('1745991501038682112')).toEqual({
      version: '2.5.0-b3',
      triple: [2, 5, 0],
      release: false,
      stage: 1,
    });
  });

  it('decodes xahaud with the year offset and the build number (F4)', () => {
    expect(decodeServerVersion('1745992622238863383', 'xahaud')).toMatchObject({
      version: '2026.10.13',
      build: 4119,
      release: true,
    });
    expect(decodeServerVersion('1745992622238863383', 'xahaud')).toEqual({
      version: '2026.10.13',
      build: 4119,
      triple: [2026, 10, 13],
      release: true,
      stage: 3,
    });
  });

  it('accepts the value as a bigint', () => {
    expect(decodeServerVersion(1745992596280311808n, 'rippled')).toMatchObject({ version: '3.4.1' });
    expect(decodeServerVersion(1745992622238863383n, 'xahaud')).toMatchObject({ version: '2026.10.13', build: 4119 });
  });

  it('is undefined unless the top 16 bits are 0x183B', () => {
    expect(decodeServerVersion('1311676707215769600', 'rippled')).toBeUndefined(); // prefix 0x1234
    expect(decodeServerVersion('1311676707215769600', 'xahaud')).toBeUndefined();
    expect(decodeServerVersion(encode(3, 4, 1, 0xc0, 0, 0x183an), 'rippled')).toBeUndefined();
    expect(decodeServerVersion(encode(3, 4, 1, 0xc0, 0, 0x183cn), 'rippled')).toBeUndefined();
    expect(decodeServerVersion('0', 'rippled')).toBeUndefined();
    expect(decodeServerVersion(0n, 'xahaud')).toBeUndefined();
    expect(decodeServerVersion(-1n, 'rippled')).toBeUndefined();
    expect(decodeServerVersion('18446744073709551615', 'rippled')).toBeUndefined(); // 2^64 - 1
    expect(decodeServerVersion('18446744073709551616', 'rippled')).toBeUndefined(); // 2^64
  });

  it('is undefined unless the text is decimal digits', () => {
    const digits = '1745992596280311808';
    for (const raw of [
      '',
      ' ',
      ` ${digits}`,
      `${digits} `,
      `-${digits}`,
      `+${digits}`,
      `${digits}.0`,
      '0x183B030401C00000',
      '1e18',
      'abc',
    ]) {
      expect(decodeServerVersion(raw, 'rippled')).toBeUndefined();
    }
  });

  describe('release byte, rippled', () => {
    it('suffixes rc and beta with their number from the low six bits', () => {
      expect(rippled(encode(2, 5, 0, 0x80)).version).toBe('2.5.0-rc0');
      expect(rippled(encode(2, 5, 0, 0x80 | 12)).version).toBe('2.5.0-rc12');
      expect(rippled(encode(2, 5, 0, 0x80 | 63)).version).toBe('2.5.0-rc63');
      expect(rippled(encode(2, 5, 0, 0x40 | 1)).version).toBe('2.5.0-b1');
      expect(rippled(encode(2, 5, 0, 0x40 | 63)).version).toBe('2.5.0-b63');
    });

    it('is a release only for the byte 0xC0', () => {
      expect(rippled(encode(2, 5, 0, 0xc0))).toMatchObject({ version: '2.5.0', release: true, stage: 3 });
      expect(rippled(encode(2, 5, 0, 0xc1))).toMatchObject({ version: '2.5.0', release: false, stage: 0 });
      expect(rippled(encode(2, 5, 0, 0xff))).toMatchObject({ version: '2.5.0', release: false, stage: 0 });
      expect(rippled(encode(2, 5, 0, 0x00))).toMatchObject({ version: '2.5.0', release: false, stage: 0 });
      expect(rippled(encode(2, 5, 0, 0x20))).toMatchObject({ version: '2.5.0', release: false, stage: 0 });
    });

    it('has no build number, whatever the low bits hold', () => {
      const decoded = rippled(encode(3, 4, 1, 0xc0, 4119));
      expect(decoded.version).toBe('3.4.1');
      expect(decoded).not.toHaveProperty('build');
    });

    it('reads each of the three numbers from its own byte', () => {
      expect(rippled(encode(255, 254, 253, 0xc0))).toMatchObject({ version: '255.254.253', triple: [255, 254, 253] });
      expect(rippled(encode(0, 0, 0, 0xc0))).toMatchObject({ version: '0.0.0', triple: [0, 0, 0] });
    });
  });

  describe('release byte, xahaud', () => {
    const xahaud = (raw: string) => decodeServerVersion(raw, 'xahaud');

    it('adds 2023 to the major', () => {
      expect(xahaud(encode(0, 1, 2, 0))).toMatchObject({ version: '2023.1.2', triple: [2023, 1, 2] });
      expect(xahaud(encode(3, 10, 13, 0))).toMatchObject({ version: '2026.10.13', triple: [2026, 10, 13] });
    });

    it('treats every byte that is neither rc nor beta as a release', () => {
      for (const byte of [0x00, 0x20, 0xc0, 0xc1, 0xff]) {
        expect(xahaud(encode(3, 10, 13, byte))).toMatchObject({ version: '2026.10.13', release: true, stage: 3 });
      }
    });

    it('suffixes rc and beta like rippled', () => {
      expect(xahaud(encode(3, 10, 13, 0x82))).toMatchObject({ version: '2026.10.13-rc2', release: false, stage: 2 });
      expect(xahaud(encode(3, 10, 13, 0x41))).toMatchObject({ version: '2026.10.13-b1', release: false, stage: 1 });
    });

    it('has a build only when bits 0-15 are not zero', () => {
      expect(xahaud(encode(3, 10, 13, 0, 1))).toMatchObject({ build: 1 });
      expect(xahaud(encode(3, 10, 13, 0, 0xffff))).toMatchObject({ build: 65535 });
      expect(xahaud(encode(3, 10, 13, 0, 0))).not.toHaveProperty('build');
    });
  });
});

describe('parseVersionTriple', () => {
  it('reads three dot separated numbers', () => {
    expect([parseVersionTriple('1.12.0'), parseVersionTriple('2024.4.21'), parseVersionTriple('v1')]).toEqual([
      [1, 12, 0],
      [2024, 4, 21],
      undefined,
    ]);
    expect(parseVersionTriple('0.0.0')).toEqual([0, 0, 0]);
  });

  it('refuses anything else', () => {
    for (const text of [
      '',
      '1',
      '1.2',
      '1.2.3.4',
      'v1.2.3',
      '1.2.3-rc1',
      '1.2.x',
      ' 1.2.3',
      '1.2.3 ',
      '1..3',
      '-1.2.3',
      '1.2.99999999999999999999',
    ]) {
      expect(parseVersionTriple(text)).toBeUndefined();
    }
  });
});

describe('compareTriples', () => {
  it('orders ascending, major first', () => {
    expect(compareTriples([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(compareTriples([1, 2, 3], [1, 2, 4])).toBeLessThan(0);
    expect(compareTriples([1, 2, 4], [1, 2, 3])).toBeGreaterThan(0);
    expect(compareTriples([1, 3, 0], [1, 2, 9])).toBeGreaterThan(0);
    expect(compareTriples([2, 0, 0], [1, 99, 99])).toBeGreaterThan(0);
    expect(compareTriples([2024, 4, 21], [3, 4, 1])).toBeGreaterThan(0);
  });

  it('compares numbers, not text', () => {
    expect(compareTriples([1, 10, 0], [1, 9, 0])).toBeGreaterThan(0);
  });
});

describe('compareVersions', () => {
  const label = (v: ServerVersion) => `${v.version}/${v.stage}`;

  it('sorts newest first: the triple, then release > rc > beta > other, then the higher number', () => {
    const versions = [
      rippled(encode(2, 5, 0, 0x40 | 3)),
      rippled(encode(2, 5, 0, 0x40 | 10)),
      rippled(encode(2, 5, 0, 0x80 | 1)),
      rippled(encode(2, 5, 0, 0x80 | 12)),
      rippled(encode(2, 5, 0, 0xc0)),
      rippled(encode(2, 5, 0, 0x00)),
      rippled(encode(2, 4, 9, 0xc0)),
      rippled(encode(3, 0, 0, 0x40 | 1)),
      rippled(encode(2, 10, 0, 0xc0)),
    ];
    expect([...versions].sort(compareVersions).map(label)).toEqual([
      '3.0.0-b1/1',
      '2.10.0/3',
      '2.5.0/3',
      '2.5.0-rc12/2',
      '2.5.0-rc1/2',
      '2.5.0-b10/1',
      '2.5.0-b3/1',
      '2.5.0/0',
      '2.4.9/3',
    ]);
  });

  it('is negative when the first is newer, positive when the second is, zero when equal', () => {
    const release = rippled(encode(3, 4, 1, 0xc0));
    const older = rippled(encode(3, 4, 0, 0xc0));
    const rc = rippled(encode(3, 4, 1, 0x81));
    expect(compareVersions(release, older)).toBeLessThan(0);
    expect(compareVersions(older, release)).toBeGreaterThan(0);
    expect(compareVersions(release, rc)).toBeLessThan(0);
    expect(compareVersions(rc, release)).toBeGreaterThan(0);
    expect(compareVersions(release, { ...release })).toBe(0);
  });

  it('ignores the build number', () => {
    const a = decodeServerVersion(encode(3, 10, 13, 0, 4119), 'xahaud') as ServerVersion;
    const b = decodeServerVersion(encode(3, 10, 13, 0, 4200), 'xahaud') as ServerVersion;
    expect(compareVersions(a, b)).toBe(0);
  });

  it('sorts a hand-made version by its version text when the number is needed', () => {
    const rc2: ServerVersion = { version: '1.0.0-rc2', triple: [1, 0, 0], release: false, stage: 2 };
    const rc10: ServerVersion = { version: '1.0.0-rc10', triple: [1, 0, 0], release: false, stage: 2 };
    expect([rc2, rc10].sort(compareVersions)).toEqual([rc10, rc2]);
  });
});
