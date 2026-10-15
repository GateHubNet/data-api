import { NetworkProfile } from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { decode, DEFAULT_DEFINITIONS, encode, XrplDefinitions, XrplDefinitionsBase } from 'ripple-binary-codec';
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
 *  2. else the network profile's bundled definitions (`definitionsFallback()`: Xahau ships a recorded file, XRPL none);
 *  3. else the codec's built-in `DEFAULT_DEFINITIONS`.
 *
 * Only (1) is complete for a network that has moved on. While it is missing the node is asked again every
 * `DEFINITIONS_RETRY_MS`, and the definitions are replaced as soon as it answers.
 */
@Injectable()
export class BinaryCodecService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BinaryCodecService.name);
  private definitions: XrplDefinitionsBase = DEFAULT_DEFINITIONS;
  private source: DefinitionsSource = 'builtin';
  private retry?: NodeJS.Timeout;
  private destroyed = false;

  constructor(
    private readonly xrpl: XrplService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  async onModuleInit(): Promise<void> {
    if (await this.fromNode()) return;
    const fallback = definitionsFrom(this.profile.definitionsFallback());
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

  /** Where the definitions in use came from. */
  get definitionsSource(): DefinitionsSource {
    return this.source;
  }

  /** The serialization of a transaction or of its metadata, as upper case hex. */
  encode(json: object): string {
    return encode(json, this.definitions);
  }

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
