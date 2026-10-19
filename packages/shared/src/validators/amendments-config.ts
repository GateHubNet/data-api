import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NetworkName, NetworkProfile } from '../network';

/** One amendment of the metadata file (spec 2.6). `id` is computed from `name` and never written in the file. */
export interface AmendmentMeta {
  name: string;
  /** SHA-512Half of `name`, upper-case hex (F9). */
  id: string;
  /** The software version that first carried it: a rippled version on XRPL, a xahaud date version on Xahau. */
  introduced?: string;
  /** `XLS-<n>`. */
  xls?: string;
  /** The address of the standard, under `https://github.com/XRPLF/XRPL-Standards/` (G2). */
  xls_url?: string;
  /** One line, at most 200 characters. */
  description?: string;
  /** For an amendment enabled before the indexed history; an indexed `EnableAmendment` wins over it. */
  enabled?: { ledger_index?: number; date?: string };
  /** The amendment can no longer be voted in by current software. */
  obsolete?: true;
  /** Xahau only: behaviour that is always on although the ledger does not list the amendment. */
  retired?: true;
}

export interface AmendmentsConfig {
  network: NetworkName;
  /** `YYYY-MM-DD`: when the file was last brought up to date. */
  updated: string;
  amendments: AmendmentMeta[];
  byId: ReadonlyMap<string, AmendmentMeta>;
  byName: ReadonlyMap<string, AmendmentMeta>;
}

// `src/validators` and `dist/validators` are both two levels below the package root, which ships `config/` in `files`.
const DEFAULT_AMENDMENTS_DIR = join(__dirname, '..', '..', 'config', 'amendments');

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const XLS = /^XLS-\d+$/;
/** rippled's semantic version. */
const RIPPLED_VERSION = /^\d{1,2}\.\d{1,2}\.\d{1,2}$/;
/** xahaud's date version: `<year>.<month>.<day>`. */
const XAHAUD_VERSION = /^\d{4}\.\d{1,2}\.\d{1,2}$/;
const MAX_DESCRIPTION = 200;
const XLS_URL_PATH = '/XRPLF/XRPL-Standards/';

const ENTRY_KEYS = ['name', 'introduced', 'xls', 'xls_url', 'description', 'enabled', 'obsolete', 'retired'];
const ENABLED_KEYS = ['ledger_index', 'date'];
const TOP_KEYS = ['network', 'updated', 'amendments'];

/** An amendment's ID: SHA-512Half of its name, upper-case hex (F9). */
export function amendmentId(name: string): string {
  return createHash('sha512').update(name, 'utf8').digest().subarray(0, 32).toString('hex').toUpperCase();
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function refuse(where: string, why: string): never {
  throw new Error(`Invalid amendments config: ${where}: ${why}`);
}

/** `YYYY-MM-DD` that is a day of the calendar. */
function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/**
 * Why `url` is not an address of a standard (G2), or `undefined` when it is: `https:`, host `github.com`, no port,
 * user or password, a path under `/XRPLF/XRPL-Standards/`, and written the way the URL parser would write it (so a
 * `:443`, a backslash or a stripped control character cannot hide in it).
 */
function xlsUrlProblem(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'not a URL';
  }
  if (parsed.protocol !== 'https:') return 'must use https:';
  if (parsed.hostname !== 'github.com') return 'must be on github.com';
  if (parsed.port !== '') return 'must not name a port';
  if (parsed.username !== '' || parsed.password !== '') return 'must not carry a user or password';
  if (!parsed.pathname.startsWith(XLS_URL_PATH)) return `must be under https://github.com${XLS_URL_PATH}`;
  if (parsed.href !== url) return `must be written as ${parsed.href}`;
  return undefined;
}

function parseEnabled(value: unknown, where: string): NonNullable<AmendmentMeta['enabled']> {
  if (!isObject(value)) return refuse(where, 'enabled: expected an object');
  for (const key of Object.keys(value)) {
    if (!ENABLED_KEYS.includes(key)) return refuse(where, `enabled: unknown key "${key}"`);
  }
  const enabled: NonNullable<AmendmentMeta['enabled']> = {};
  if (value.ledger_index !== undefined) {
    const index = value.ledger_index;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 1) {
      return refuse(where, 'enabled: ledger_index must be a positive integer');
    }
    enabled.ledger_index = index;
  }
  if (value.date !== undefined) {
    if (!isDay(value.date)) return refuse(where, 'enabled: date must be a day, YYYY-MM-DD');
    enabled.date = value.date;
  }
  if (enabled.ledger_index === undefined && enabled.date === undefined) {
    return refuse(where, 'enabled: needs a ledger_index or a date');
  }
  return enabled;
}

function parseEntry(raw: unknown, index: number, profile: NetworkProfile): AmendmentMeta {
  const named = isObject(raw) && typeof raw.name === 'string' ? ` (${raw.name})` : '';
  const where = `amendments[${index}]${named}`;
  if (!isObject(raw)) return refuse(where, 'expected an object');
  for (const key of Object.keys(raw)) {
    if (!ENTRY_KEYS.includes(key)) return refuse(where, `${key}: unknown key`);
  }

  const { name } = raw;
  if (name === undefined) return refuse(where, 'name: required');
  if (typeof name !== 'string' || !NAME.test(name)) {
    return refuse(where, `name: must match ${NAME}`);
  }
  const entry: AmendmentMeta = { name, id: amendmentId(name) };

  if (raw.introduced !== undefined) {
    const pattern = profile.software === 'xahaud' ? XAHAUD_VERSION : RIPPLED_VERSION;
    const form = profile.software === 'xahaud' ? 'a xahaud date version (YYYY.M.D)' : 'a rippled version (X.Y.Z)';
    if (typeof raw.introduced !== 'string' || !pattern.test(raw.introduced)) {
      return refuse(where, `introduced: must be ${form}`);
    }
    entry.introduced = raw.introduced;
  }
  if (raw.xls !== undefined) {
    if (typeof raw.xls !== 'string' || !XLS.test(raw.xls)) return refuse(where, `xls: must match ${XLS}`);
    entry.xls = raw.xls;
  }
  if (raw.xls_url !== undefined) {
    if (typeof raw.xls_url !== 'string') return refuse(where, 'xls_url: must be a string');
    const problem = xlsUrlProblem(raw.xls_url);
    if (problem) return refuse(where, `xls_url: ${problem}`);
    entry.xls_url = raw.xls_url;
  }
  if (raw.description !== undefined) {
    const text = raw.description;
    if (typeof text !== 'string' || text === '' || /[\r\n]/.test(text)) {
      return refuse(where, 'description: must be one non-empty line');
    }
    if ([...text].length > MAX_DESCRIPTION) {
      return refuse(where, `description: must be at most ${MAX_DESCRIPTION} characters`);
    }
    entry.description = text;
  }
  if (raw.enabled !== undefined) entry.enabled = parseEnabled(raw.enabled, where);
  if (raw.obsolete !== undefined) {
    if (raw.obsolete !== true) return refuse(where, 'obsolete: can only be true');
    entry.obsolete = true;
  }
  if (raw.retired !== undefined) {
    if (raw.retired !== true) return refuse(where, 'retired: can only be true');
    if (profile.software !== 'xahaud') return refuse(where, 'retired: is for Xahau only');
    entry.retired = true;
  }
  return entry;
}

/**
 * Check a metadata file (spec 2.6) for `profile` and index it. Throws `Error('Invalid amendments config: <where>: <why>')`
 * where `<where>` is the top-level key or `amendments[<i>] (<name>)`.
 */
export function parseAmendmentsConfig(raw: unknown, profile: NetworkProfile): AmendmentsConfig {
  if (!isObject(raw)) return refuse('top level', 'expected an object');
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.includes(key)) return refuse(key, 'unknown key');
  }
  if (raw.network === undefined) return refuse('network', 'required');
  if (raw.network !== profile.name) {
    return refuse('network', `"${String(raw.network)}" is not the network of this deployment, "${profile.name}"`);
  }
  if (raw.updated === undefined) return refuse('updated', 'required');
  if (!isDay(raw.updated)) return refuse('updated', 'must be a day, YYYY-MM-DD');
  if (raw.amendments === undefined) return refuse('amendments', 'required');
  if (!Array.isArray(raw.amendments)) return refuse('amendments', 'must be a list');

  const amendments: AmendmentMeta[] = [];
  const byId = new Map<string, AmendmentMeta>();
  const byName = new Map<string, AmendmentMeta>();
  const positions = new Map<string, number>();
  raw.amendments.forEach((item: unknown, index: number) => {
    const entry = parseEntry(item, index, profile);
    const first = positions.get(entry.name);
    if (first !== undefined)
      return refuse(`amendments[${index}] (${entry.name})`, `name: duplicate of amendments[${first}]`);
    positions.set(entry.name, index);
    amendments.push(entry);
    byId.set(entry.id, entry);
    byName.set(entry.name, entry);
  });
  return { network: profile.name, updated: raw.updated, amendments, byId, byName };
}

/**
 * Load the amendment metadata of a network. The path defaults to the bundled `config/amendments/<network>.json`, next
 * to `config/markets`. An invalid file throws with its path and the entry at fault.
 */
export function loadAmendmentsConfig(profile: NetworkProfile, path?: string): AmendmentsConfig {
  const file = path ?? join(DEFAULT_AMENDMENTS_DIR, `${profile.name}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return refuse(file, (err as Error).message);
  }
  try {
    return parseAmendmentsConfig(raw, profile);
  } catch (err) {
    throw new Error(`${(err as Error).message} (${file})`);
  }
}
