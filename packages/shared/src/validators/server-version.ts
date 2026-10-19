/** A node's software version, decoded from the `sfServerVersion` of a validation (F3, F4). */
export interface ServerVersion {
  /** `major.minor.patch`, with `-rcN` or `-bN` for a release candidate or a beta. */
  version: string;
  /** The build number after the `+` (xahaud only, and only when not zero). */
  build?: number;
  /** The numbers of `version`, as compared by `compareTriples`. */
  triple: [number, number, number];
  /** A release build: not a release candidate, not a beta and, on rippled, the release byte `0xC0` exactly. */
  release: boolean;
  /** Release 3, release candidate 2, beta 1, anything else 0. */
  stage: number;
}

type Triple = [number, number, number];

/** Bits 48-63 of every server version. */
const PREFIX = 0x183bn;
const RELEASE_CANDIDATE = 0x80;
const BETA = 0x40;
const STAGE_BITS = 0xc0;
const NUMBER_BITS = 0x3f;
/** Xahau counts the major from 2023, the year of its launch. */
const XAHAU_YEAR_OFFSET = 2023;

/**
 * Decode a server version: the UInt64 the `validations` stream carries as decimal text. Bits 48-63 are `0x183B`, 40-47
 * the major, 32-39 the minor, 24-31 the patch, 16-23 the release byte and, on xahaud, 0-15 the build number. Anything
 * else (another prefix, text that is not decimal digits) has no version. On rippled only the byte `0xC0` is a release;
 * on xahaud every byte that is neither a release candidate (`0x80 | n`) nor a beta (`0x40 | n`) is, because xahaud's
 * `release` is a pre-release identifier of its own.
 */
export function decodeServerVersion(raw: string | bigint, software: 'rippled' | 'xahaud'): ServerVersion | undefined {
  if (typeof raw === 'string' && !/^\d+$/.test(raw)) return undefined;
  const value = BigInt(raw);
  if (value < 0n || value >> 48n !== PREFIX) return undefined;

  const field = (shift: bigint): number => Number((value >> shift) & 0xffn);
  const xahaud = software === 'xahaud';
  const triple: Triple = [field(40n) + (xahaud ? XAHAU_YEAR_OFFSET : 0), field(32n), field(24n)];
  const byte = field(16n);
  const kind = byte & STAGE_BITS;
  const number = byte & NUMBER_BITS;

  let suffix = '';
  let stage = 0;
  let release = false;
  if (kind === RELEASE_CANDIDATE) {
    suffix = `-rc${number}`;
    stage = 2;
  } else if (kind === BETA) {
    suffix = `-b${number}`;
    stage = 1;
  } else if (xahaud || byte === STAGE_BITS) {
    release = true;
    stage = 3;
  }

  const decoded: ServerVersion = { version: `${triple.join('.')}${suffix}`, triple, release, stage };
  const build = Number(value & 0xffffn);
  if (xahaud && build !== 0) decoded.build = build;
  return decoded;
}

/** `major.minor.patch` as three numbers; undefined for any other text (`v1`, `1.2`, `1.2.3-rc1`). */
export function parseVersionTriple(text: string): Triple | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!match) return undefined;
  const triple: Triple = [Number(match[1]), Number(match[2]), Number(match[3])];
  return triple.every(Number.isSafeInteger) ? triple : undefined;
}

function sign(difference: number): number {
  return difference < 0 ? -1 : difference > 0 ? 1 : 0;
}

/** Ascending, as numbers: negative when `a` is the older triple, positive when it is the newer, 0 when equal. */
export function compareTriples(a: Triple, b: Triple): number {
  return sign(a[0] - b[0]) || sign(a[1] - b[1]) || sign(a[2] - b[2]);
}

/** The number of a release candidate or beta, from the suffix of its `version`; 0 without one. */
function preReleaseNumber(version: ServerVersion): number {
  const match = /-(?:rc|b)(\d+)$/.exec(version.version);
  return match ? Number(match[1]) : 0;
}

/**
 * Newest first, for `Array.prototype.sort`: the higher triple, then the higher stage (release, release candidate, beta,
 * other), then the higher release candidate or beta number. Negative when `a` is the newer version. The build number
 * does not count.
 */
export function compareVersions(a: ServerVersion, b: ServerVersion): number {
  return (
    compareTriples(b.triple, a.triple) || sign(b.stage - a.stage) || sign(preReleaseNumber(b) - preReleaseNumber(a))
  );
}
