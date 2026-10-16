import { NetworkProfile } from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  coreTypes,
  decode,
  DEFAULT_DEFINITIONS,
  encode,
  XrplDefinitions,
  XrplDefinitionsBase,
} from 'ripple-binary-codec';
import { NETWORK_PROFILE } from '../config/api.config';
import { XrplService } from '../xrpl/xrpl.service';

/** The wait for `server_definitions` at boot: the node is optional here, so it must not hold the boot up for long. */
export const DEFINITIONS_TIMEOUT_MS = 3_000;
/** While the definitions are a fallback, the node is asked again this often. */
export const DEFINITIONS_RETRY_MS = 30_000;

/** Where the definitions in use came from: the node, the network profile's bundled file, or the codec itself. */
export type DefinitionsSource = 'node' | 'profile' | 'builtin';

/** The enums a `server_definitions` result (and the bundled definitions files) must hold for the codec to use them. */
const OBJECT_ENUMS = ['TYPES', 'LEDGER_ENTRY_TYPES', 'TRANSACTION_RESULTS', 'TRANSACTION_TYPES'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * rippled and xahaud add `DeliverMax`, a JSON alias of `Amount`, to the Payments they serve. It is not part of the
 * serialization, and the codec rejects every field it does not know that starts with a capital: the serialized
 * transaction is the one without it. (The lower case JSON-only fields, `hash`, `date`, `delivered_amount`, ..., the
 * codec skips by itself.)
 */
function serializable(json: object): object {
  if (!('DeliverMax' in json)) return json;
  const { DeliverMax, ...rest } = json as Record<string, unknown>;
  return 'Amount' in rest ? rest : { ...rest, Amount: DeliverMax };
}

/** The transaction without `DeliverMax` when `Amount` says the same; it is left as it is otherwise. */
export function withoutDeliverMax<T extends object>(tx: T): T {
  if (!('DeliverMax' in tx) || !('Amount' in tx)) return tx;
  const { DeliverMax, ...rest } = tx as Record<string, unknown>;
  return rest as T;
}

/**
 * Stand-ins for an empty AccountID: 20 bytes nobody holds the key of (SHA-256 of a fixed text and a counter), with their
 * classic address. A JSON that already holds the first one (it never does) gets the next.
 */
const EMPTY_ACCOUNT_SENTINELS: ReadonlyArray<{ hex: string; address: string }> = Array.from({ length: 4 }, (_, i) => {
  const hex = createHash('sha256')
    .update(`gatehub data api: empty AccountID ${i}`)
    .digest()
    .subarray(0, 20)
    .toString('hex')
    .toUpperCase();
  return { hex, address: String(coreTypes.AccountID.from(hex).toJSON()) };
});

type Sentinel = (typeof EMPTY_ACCOUNT_SENTINELS)[number];

/**
 * `json` with every AccountID field whose value is `""` replaced by `address`, and how many there were; `json` itself
 * when there is none. Nested objects and arrays (metadata nodes, `ActiveValidators`, ...) are walked too. Copies only
 * what it changes.
 */
function substituteEmptyAccounts(
  json: unknown,
  isAccountField: (name: string) => boolean,
  address: string,
): { value: unknown; count: number } {
  if (Array.isArray(json)) {
    let count = 0;
    const items = json.map((item) => {
      const sub = substituteEmptyAccounts(item, isAccountField, address);
      count += sub.count;
      return sub.value;
    });
    return count === 0 ? { value: json, count } : { value: items, count };
  }
  if (!isPlainObject(json)) return { value: json, count: 0 };
  let count = 0;
  const entries = Object.entries(json).map(([key, value]): [string, unknown] => {
    if (value === '' && isAccountField(key)) {
      count += 1;
      return [key, address];
    }
    const sub = substituteEmptyAccounts(value, isAccountField, address);
    count += sub.count;
    return [key, sub.value];
  });
  return count === 0 ? { value: json, count } : { value: Object.fromEntries(entries), count };
}

/** `json` (decoded) with every string that is `address` put back as `""`. */
function restoreEmptyAccounts(json: unknown, address: string): unknown {
  if (Array.isArray(json)) return json.map((item) => restoreEmptyAccounts(item, address));
  if (!isPlainObject(json)) return json === address ? '' : json;
  return Object.fromEntries(Object.entries(json).map(([key, value]) => [key, restoreEmptyAccounts(value, address)]));
}

/** Definitions built from a `server_definitions` shaped JSON, or `undefined` when it is not usable. */
function definitionsFrom(json: unknown): XrplDefinitions | undefined {
  if (!isPlainObject(json) || !Array.isArray(json.FIELDS) || !OBJECT_ENUMS.every((key) => isPlainObject(json[key]))) {
    return undefined;
  }
  try {
    return new XrplDefinitions(json as unknown as ConstructorParameters<typeof XrplDefinitions>[0]);
  } catch {
    return undefined;
  }
}

/**
 * The XRPL binary codec with the definitions of the network the API serves: `binary=true` responses are the node's own
 * serialization, which includes the transaction types and fields that an amendment added after the codec was
 * released (and everything Xahau has that XRPL has not). Xahau and the newest XRPL amendments therefore need the
 * definitions of the node:
 *
 *  1. `server_definitions` of the node (`XrplDefinitions`), asked once at boot;
 *  2. else the network profile's bundled definitions (`definitionsFallback()`: the file recorded from a public node of
 *     the network, `config/definitions/<network>.json`);
 *  3. else the codec's built-in `DEFAULT_DEFINITIONS` (a file that is missing or corrupt is logged, not fatal).
 *
 * Only (1) follows a network that has moved on. While it is missing the node is asked again every
 * `DEFINITIONS_RETRY_MS`, and the definitions are replaced as soon as it answers.
 *
 * The codec is `ripple-binary-codec` 2.x, which knows the types that 1.x lacked (Hash192, Number, Int32, MPT amounts),
 * with a direct dependency of this app: `xrpl` stays on 2.14, whose own codec is 1.11.
 */
@Injectable()
export class BinaryCodecService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BinaryCodecService.name);
  private definitions: XrplDefinitionsBase = DEFAULT_DEFINITIONS;
  private source: DefinitionsSource = 'builtin';
  private retry?: NodeJS.Timeout;
  private destroyed = false;
  private generationNo = 0;

  constructor(
    private readonly xrpl: XrplService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  async onModuleInit(): Promise<void> {
    if (await this.fromNode()) return;
    const fallback = this.bundled();
    if (fallback) {
      this.use(fallback, 'profile');
      this.logger.warn(`The node gave no server_definitions: using the bundled ${this.profile.name} definitions`);
    } else {
      this.logger.warn("The node gave no server_definitions: using the codec's built-in definitions");
    }
    this.scheduleRetry();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    clearTimeout(this.retry);
    this.retry = undefined;
  }

  /**
   * Changes each time other definitions are put to use. What was serialized under an earlier generation may differ
   * (a field that is now known, a different order), so a cache of serializations is only good for one.
   */
  get generation(): number {
    return this.generationNo;
  }

  /** Where the definitions in use came from. */
  get definitionsSource(): DefinitionsSource {
    return this.source;
  }

  /**
   * The serialization of a transaction or of its metadata, as upper case hex: the bytes the node serialized. Throws what
   * the codec cannot serialize.
   *
   * An AccountID field whose JSON value is `""` (Xahau's `UNLReport` has `Account: ""`: an AccountID the node never
   * set) is a zero-length field, `<field header> 00` (`81 00` for `Account`), as xahaud writes it. The codec cannot
   * write that: it encodes `""` like the zero account, as 20 zero bytes, and the blob would not hash to the
   * transaction's hash (ruling R97). Such a field is therefore encoded with a sentinel address, unique to it, whose
   * `14 <20 bytes>` (length and value) is then cut down to `00`.
   */
  encode(json: object): string {
    const input = serializable(json);
    const substituted = this.withSentinel(input);
    if (!substituted) return encode(input, this.definitions);
    const { value, count, sentinel } = substituted;
    const hex = encode(value as object, this.definitions);
    const field = `14${sentinel.hex}`;
    let spliced = '';
    let found = 0;
    let from = 0;
    for (let at = hex.indexOf(field); at >= 0; at = hex.indexOf(field, at + field.length)) {
      if (at % 2 !== 0) continue; // not on a byte boundary: not the field
      spliced += `${hex.slice(from, at)}00`;
      from = at + field.length;
      found += 1;
    }
    if (found !== count) {
      throw new Error(`Cannot serialize ${count} empty AccountID field(s): found ${found} in the serialization`);
    }
    return spliced + hex.slice(from);
  }

  /**
   * `decode(encode(json))`, the canonical JSON of a stored transaction or metadata, except that an AccountID field whose
   * value is `""` stays `""`, as the node shows it (the codec decodes a zero-length AccountID as the zero account,
   * `rrrrrrrrrrrrrrrrrrrrrhoLvTp`). Throws what the codec cannot serialize.
   */
  roundTrip(json: object): Record<string, unknown> {
    const substituted = this.withSentinel(serializable(json));
    if (!substituted) return this.decode(this.encode(json));
    const { value, sentinel } = substituted;
    const decoded = this.decode(encode(value as object, this.definitions));
    return restoreEmptyAccounts(decoded, sentinel.address) as Record<string, unknown>;
  }

  /**
   * The codec's decode with the definitions in use. A zero-length AccountID (`81 00`) comes back as the zero account:
   * use `roundTrip` for the JSON of a stored transaction.
   */
  decode(hex: string): Record<string, unknown> {
    return decode(hex, this.definitions) as Record<string, unknown>;
  }

  /** The transaction types of the definitions (`Payment`, `OfferCreate`, ...). */
  transactionTypes(): string[] {
    return [...this.definitions.transactionNames];
  }

  /** The transaction result codes of the definitions (`tesSUCCESS`, `tecPATH_DRY`, ...). */
  transactionResults(): string[] {
    // The lookup holds every code twice, by name and by ordinal, and its own `ordinalWidth`.
    const entries: unknown[] = Object.values(this.definitions.transactionResult);
    const names = entries.flatMap((entry) => {
      const name = isPlainObject(entry) ? entry.name : undefined;
      return typeof name === 'string' ? [name] : [];
    });
    return [...new Set(names)];
  }

  /**
   * `json` with its empty AccountID fields replaced by a sentinel address that `json` does not hold anywhere else, or
   * undefined when it has no empty AccountID field (nearly always).
   */
  private withSentinel(json: object): { value: unknown; count: number; sentinel: Sentinel } | undefined {
    const fields = this.definitions.field as unknown as Record<
      string,
      { type?: { name?: string }; isVariableLengthEncoded?: boolean } | undefined
    >;
    const isAccountField = (name: string): boolean => {
      const field = Object.prototype.hasOwnProperty.call(fields, name) ? fields[name] : undefined;
      return field?.type?.name === 'AccountID' && field.isVariableLengthEncoded === true;
    };
    const probe = substituteEmptyAccounts(json, isAccountField, EMPTY_ACCOUNT_SENTINELS[0].address);
    if (probe.count === 0) return undefined;
    const text = JSON.stringify(json);
    const sentinel = EMPTY_ACCOUNT_SENTINELS.find(
      (s) => !text.includes(s.address) && !text.toUpperCase().includes(s.hex),
    );
    if (!sentinel) throw new Error('Cannot serialize an empty AccountID: every sentinel occurs in the JSON');
    const { value, count } = substituteEmptyAccounts(json, isAccountField, sentinel.address);
    return { value, count, sentinel };
  }

  /** The definitions the network profile bundles. A file that cannot be read or built is logged, never fatal. */
  private bundled(): XrplDefinitions | undefined {
    try {
      return definitionsFrom(this.profile.definitionsFallback());
    } catch (err) {
      this.logger.warn(
        `Cannot read the bundled ${this.profile.name} definitions (${err instanceof Error ? err.message : String(err)})`,
      );
      return undefined;
    }
  }

  /** Ask the node; true when its definitions are now in use. */
  private async fromNode(): Promise<boolean> {
    try {
      const answer = await this.xrpl.request<unknown>(
        { command: 'server_definitions' },
        { timeoutMs: DEFINITIONS_TIMEOUT_MS, retries: 0 },
      );
      const definitions = definitionsFrom(answer);
      if (!definitions) return false;
      this.use(definitions, 'node');
      return true;
    } catch {
      return false;
    }
  }

  private use(definitions: XrplDefinitionsBase, source: DefinitionsSource): void {
    this.definitions = definitions;
    this.source = source;
    this.generationNo += 1;
  }

  private scheduleRetry(): void {
    if (this.destroyed) return;
    this.retry = setTimeout(() => {
      void this.fromNode().then((found) => {
        if (found) this.logger.log('Using the server_definitions of the node');
        else this.scheduleRetry();
      });
    }, DEFINITIONS_RETRY_MS);
    this.retry.unref();
  }
}
