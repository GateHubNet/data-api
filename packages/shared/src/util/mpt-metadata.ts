/** One link of an issuance's metadata (XLS-89), in the long names. */
export interface MptMetadataUri {
  uri: string;
  category?: string;
  title?: string;
}

/** An issuance's metadata (XLS-89) as `decodeMptMetadata` reads it: the long names, whichever keys spelled it. */
export interface MptMetadata {
  ticker?: string;
  name?: string;
  desc?: string;
  icon?: string;
  asset_class?: string;
  asset_subclass?: string;
  issuer_name?: string;
  uris?: MptMetadataUri[];
  additional_info?: Record<string, unknown> | string;
}

/** The keys of a decoded object, in this order. */
export const MPT_METADATA_KEYS: readonly (keyof MptMetadata)[] = [
  'ticker',
  'name',
  'desc',
  'icon',
  'asset_class',
  'asset_subclass',
  'issuer_name',
  'uris',
  'additional_info',
];

/** The keys of an item of `uris`, in this order. */
export const MPT_URI_KEYS = ['uri', 'category', 'title'] as const;

/** Code points kept of a ticker in the `ticker` column. */
export const MPT_TICKER_MAX = 16;

/** Code points kept of a name in the `name` column. */
export const MPT_NAME_MAX = 128;

/** `MPTokenMetadata` holds at most this many bytes on the ledger. */
const METADATA_MAX_BYTES = 1024;

/**
 * A string of the decoded object is cut to this many characters. A guard: an object of at most 1024 bytes cannot hold a string
 * this long, so hex that would is `undefined` first.
 */
const METADATA_TEXT_MAX = 1024;

const HEX = /^(?:[0-9a-fA-F]{2})*$/;

const TICKER = /^[A-Z0-9]{1,6}$/;
const ASSET_CLASSES: readonly string[] = ['rwa', 'memes', 'wrapped', 'gaming', 'defi', 'other'];
const ASSET_SUBCLASSES: readonly string[] = [
  'stablecoin',
  'commodity',
  'real_estate',
  'private_credit',
  'equity',
  'treasury',
  'other',
];
const URI_CATEGORIES: readonly string[] = ['website', 'social', 'docs', 'other'];

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `text` cut to `max` code points, so that a character outside the BMP stays whole; `''` for undefined. */
export function cutText(text: string | undefined, max: number): string {
  if (text === undefined) return '';
  return text.length <= max ? text : Array.from(text).slice(0, max).join('');
}

/** A string field: cut as the metadata's strings are; anything else is no value. */
const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' ? cutText(value, METADATA_TEXT_MAX) : undefined;

/** The value of a key written long or short, the long one winning even when it holds the wrong type. */
const read = (object: JsonObject, long: string, short: string): unknown =>
  object[long] !== undefined ? object[long] : object[short];

/** An item of `uris` from the fields already read; `undefined` when it has no string `uri`. */
function uriOf(uri: unknown, category: unknown, title: unknown): MptMetadataUri | undefined {
  const text = textOf(uri);
  if (text === undefined) return undefined;
  const item: MptMetadataUri = { uri: text };
  const categoryText = textOf(category);
  if (categoryText !== undefined) item.category = categoryText;
  const titleText = textOf(title);
  if (titleText !== undefined) item.title = titleText;
  return item;
}

/** The items of `uris` that hold a string `uri`, the others dropped; no value when none is left. */
function urisOf(object: JsonObject): MptMetadataUri[] | undefined {
  const written = read(object, 'uris', 'us');
  // The draft's `urls` counts only when neither key of the final form is there.
  const draft = written === undefined;
  const items = draft ? object.urls : written;
  if (!Array.isArray(items)) return undefined;
  const uris = items
    .filter(isObject)
    .map((item) =>
      draft
        ? uriOf(item.url, item.type, item.title)
        : uriOf(read(item, 'uri', 'u'), read(item, 'category', 'c'), read(item, 'title', 't')),
    )
    .filter((item): item is MptMetadataUri => item !== undefined);
  return uris.length > 0 ? uris : undefined;
}

function additionalInfoOf(value: unknown): Record<string, unknown> | string | undefined {
  return isObject(value) ? value : textOf(value);
}

/**
 * The metadata of an issuance (`MPTokenMetadata`, hex), read leniently because early issuances predate the final keys: long and
 * short keys, the long one winning, and the early draft's `urls`. A field of the wrong type and an unknown key are dropped.
 * `undefined` when the hex is not at most 1024 bytes of UTF-8 holding a JSON object. Never throws: the value is the issuer's.
 */
export function decodeMptMetadata(hex: string): MptMetadata | undefined {
  if (!HEX.test(hex) || hex.length > METADATA_MAX_BYTES * 2) return undefined;
  let object: unknown;
  try {
    object = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex, 'hex')));
  } catch {
    return undefined;
  }
  if (!isObject(object)) return undefined;
  const fields: MptMetadata = {
    ticker: textOf(read(object, 'ticker', 't')),
    name: textOf(read(object, 'name', 'n')),
    desc: textOf(read(object, 'desc', 'd')),
    icon: textOf(read(object, 'icon', 'i')),
    asset_class: textOf(read(object, 'asset_class', 'ac')),
    asset_subclass: textOf(read(object, 'asset_subclass', 'as')),
    issuer_name: textOf(read(object, 'issuer_name', 'in')),
    uris: urisOf(object),
    additional_info: additionalInfoOf(read(object, 'additional_info', 'ai')),
  };
  // A key with no value is absent, and the literal above holds `MPT_METADATA_KEYS`' order.
  for (const key of MPT_METADATA_KEYS) if (fields[key] === undefined) delete fields[key];
  return fields;
}

const present = (text: string | undefined): boolean => text !== undefined && text !== '';

/** Whether every rule of XLS-89 holds, judged on the decoded object, whichever keys spelled it. */
export function mptMetadataConforms(m: MptMetadata): boolean {
  if (m.ticker === undefined || !TICKER.test(m.ticker)) return false;
  if (!present(m.name) || !present(m.icon) || !present(m.issuer_name)) return false;
  if (m.asset_class === undefined || !ASSET_CLASSES.includes(m.asset_class)) return false;
  if (m.asset_subclass === undefined ? m.asset_class === 'rwa' : !ASSET_SUBCLASSES.includes(m.asset_subclass)) {
    return false;
  }
  return (m.uris ?? []).every(
    (item) =>
      present(item.uri) && present(item.title) && item.category !== undefined && URI_CATEGORIES.includes(item.category),
  );
}
