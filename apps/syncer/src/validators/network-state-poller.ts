import {
  AmendmentFeaturesRow,
  AMENDMENTS_OBJECT_INDEX,
  AmendmentsConfig,
  ClickHouseService,
  FEE_SETTINGS_OBJECT_INDEX,
  NEGATIVE_UNL_OBJECT_INDEX,
  NetworkStateRow,
  NodeClient,
  nodePublicKeyFromHex,
  RIPPLE_EPOCH_MS,
  Table,
} from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { NODE_CLIENT } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { describeError, isRippledError, rippledCodeOf } from './describe-error';
import { AMENDMENTS_CONFIG, VALIDATORS_WORKER_OPTIONS, ValidatorsWorkerOptions } from './validators.options';

/** The timeout of each request to the node (spec 2.3). There is no retry: the next poll is the retry. */
export const NETWORK_STATE_REQUEST_TIMEOUT_MS = 5_000;

const RIPPLE_EPOCH_S = RIPPLE_EPOCH_MS / 1000;
const HEX64 = /^[0-9A-Fa-f]{64}$/;
const DIGITS = /^\d+$/;
const HEX_UINT64 = /^[0-9A-Fa-f]{1,16}$/;
const MAX_UINT32 = 4_294_967_295;
const MAX_UINT64 = 18_446_744_073_709_551_615n;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The answer of the node cannot be stored: `what` says why. */
function invalid(what: string): never {
  throw new Error(`Invalid ledger state: ${what}`);
}

const isUInt32 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_UINT32;

/** An amendment ID in upper case. */
function amendmentIdOf(value: unknown, where: string): string {
  if (typeof value !== 'string' || !HEX64.test(value)) return invalid(`${where} is not an amendment ID`);
  return value.toUpperCase();
}

/** The base58 form of a node public key given in hex. */
function keyOf(value: unknown, where: string): string {
  const key = typeof value === 'string' ? nodePublicKeyFromHex(value) : undefined;
  return key ?? invalid(`${where} is not a node public key`);
}

/** An amount of drops (or a count) as the text of its digits: a string of digits or a whole number, at most a `UInt64`. */
function dropsOf(value: unknown, where: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && DIGITS.test(value) && BigInt(value) <= MAX_UINT64) return BigInt(value).toString();
  return invalid(`${where} is not an amount of drops`);
}

/** A `UInt64` the ledger writes as hex (the legacy `BaseFee`), as the text of its digits. */
function hexUInt64Of(value: unknown, where: string): string {
  if (typeof value !== 'string' || !HEX_UINT64.test(value)) return invalid(`${where} is not a UInt64 in hex`);
  return BigInt(`0x${value}`).toString();
}

/** A fee of the FeeSettings object: the `…Drops` field when it has one, else the legacy field (`BaseFee` in hex). */
function feeOf(settings: Json, drops: string, legacy: string, legacyIsHex = false): string {
  if (settings[drops] !== undefined) return dropsOf(settings[drops], drops);
  if (settings[legacy] === undefined) return invalid(`FeeSettings needs ${drops} or ${legacy}`);
  return legacyIsHex ? hexUInt64Of(settings[legacy], legacy) : dropsOf(settings[legacy], legacy);
}

function listOf(node: Json, field: string): unknown[] {
  const list = node[field];
  if (list === undefined) return [];
  return Array.isArray(list) ? list : invalid(`${field} is not a list`);
}

/** The `Majority` entries of the Amendments object: the CloseTime of each, in Ripple time, as unix time. */
function majoritiesOf(node: Json): NetworkStateRow['majorities'] {
  return listOf(node, 'Majorities').map((entry) => {
    const majority = isObject(entry) ? entry.Majority : undefined;
    if (!isObject(majority)) return invalid('Majorities has an entry without a Majority');
    if (!isUInt32(majority.CloseTime)) return invalid('a Majority has a CloseTime that is not a time');
    return {
      amendment: amendmentIdOf(majority.Amendment, 'the Amendment of a Majority'),
      since: majority.CloseTime + RIPPLE_EPOCH_S,
    };
  });
}

/** The `DisabledValidator` entries of the NegativeUNL object, in the order of the object, the keys in base58. */
function disabledValidatorsOf(node: Json): NetworkStateRow['negative_unl'] {
  return listOf(node, 'DisabledValidators').map((entry) => {
    const disabled = isObject(entry) ? entry.DisabledValidator : undefined;
    if (!isObject(disabled)) return invalid('DisabledValidators has an entry without a DisabledValidator');
    if (!isUInt32(disabled.FirstLedgerSequence)) {
      return invalid('a DisabledValidator has a FirstLedgerSequence that is not a ledger sequence');
    }
    return {
      validation_public_key: keyOf(disabled.PublicKey, 'the PublicKey of a DisabledValidator'),
      first_ledger: disabled.FirstLedgerSequence,
    };
  });
}

/**
 * The `network_state` row for the answers of the node (spec 2.3, F11): `amendments` is the `ledger_entry` result for the
 * Amendments object, whose `ledger_index` is the ledger the other two objects were read at; `negativeUnl` and
 * `feeSettings` are the `node` of their `ledger_entry` results, `negativeUnl` none when the node said `entryNotFound` (no
 * validator is disabled). `validationQuorum` is the one of `server_info`, none is 0. `polledAt` is unix seconds with the
 * milliseconds as the fraction. Throws when an answer cannot be stored. Fees are the text of their digits, in drops.
 */
export function networkStateRowFrom(
  amendments: { ledger_index: number; ledger_hash?: string; node?: Record<string, unknown> },
  negativeUnl: Record<string, unknown> | undefined,
  feeSettings: Record<string, unknown>,
  validationQuorum: number | undefined,
  polledAt: number,
): NetworkStateRow {
  const { ledger_index: ledgerIndex, ledger_hash: ledgerHash, node } = amendments;
  if (!isUInt32(ledgerIndex) || ledgerIndex < 1) return invalid('the Amendments answer has no ledger_index');
  if (!isObject(node)) return invalid('the Amendments object is missing from the answer');
  if (!isObject(feeSettings)) return invalid('the FeeSettings object is missing from the answer');
  const unl = negativeUnl ?? {};
  const toDisable = unl.ValidatorToDisable;
  const toReenable = unl.ValidatorToReEnable;
  return {
    ledger_index: ledgerIndex,
    ledger_hash: typeof ledgerHash === 'string' && HEX64.test(ledgerHash) ? ledgerHash.toUpperCase() : '',
    polled_at: polledAt,
    amendments: listOf(node, 'Amendments').map((id) => amendmentIdOf(id, 'an entry of Amendments')),
    majorities: majoritiesOf(node),
    negative_unl: disabledValidatorsOf(unl),
    to_disable: toDisable === undefined ? '' : keyOf(toDisable, 'ValidatorToDisable'),
    to_reenable: toReenable === undefined ? '' : keyOf(toReenable, 'ValidatorToReEnable'),
    base_fee: feeOf(feeSettings, 'BaseFeeDrops', 'BaseFee', true),
    reserve_base: feeOf(feeSettings, 'ReserveBaseDrops', 'ReserveBase'),
    reserve_inc: feeOf(feeSettings, 'ReserveIncrementDrops', 'ReserveIncrement'),
    node_quorum: validationQuorum ?? 0,
  };
}

/**
 * The `amendment_features` rows for the `feature` result of the node: one row per amendment ID, sorted by ID. The name is
 * `''` for an amendment the node has no name for, and `supported` is 1 only for a `supported` of `true`. Throws when the
 * answer is not a list of features.
 */
export function featureRowsFrom(result: unknown, polledAt: number): AmendmentFeaturesRow[] {
  const features = isObject(result) ? result.features : undefined;
  if (!isObject(features)) return invalid('the feature answer has no features');
  return Object.entries(features)
    .map(([id, feature]) => {
      const amendmentId = amendmentIdOf(id, 'a key of features');
      if (!isObject(feature)) return invalid(`the feature ${amendmentId} is not an object`);
      return {
        amendment_id: amendmentId,
        name: typeof feature.name === 'string' ? feature.name : '',
        supported: feature.supported === true ? 1 : 0,
        polled_at: polledAt,
      };
    })
    .sort((a, b) => (a.amendment_id < b.amendment_id ? -1 : a.amendment_id > b.amendment_id ? 1 : 0));
}

// -- the poller -------------------------------------------------------------------------------------------------------

/** The requests of the polls, as the labels of `syncer_validators_node_polls_total` name them. */
type PollRequest = 'amendments' | 'negative_unl' | 'fee_settings' | 'server_info' | 'feature';
type PollKind = 'state' | 'features';
const POLL_NAME: Record<PollKind, string> = { state: 'Network state', features: 'Amendment features' };

/** What a request came to: the value read from the answer, or what was wrong, in words for the log. */
type Outcome<T> = { ok: true; value: T } | { ok: false; problem: string };

/** The `ledger_entry` result for the Amendments object. */
interface AmendmentsAnswer {
  ledger_index: number;
  ledger_hash?: string;
  node: Json;
}

/** The `node` of a `ledger_entry` result. */
function nodeOf(answer: unknown): Json {
  const node = isObject(answer) ? answer.node : undefined;
  return isObject(node) ? node : invalid('the answer has no node');
}

function amendmentsAnswerOf(answer: unknown): AmendmentsAnswer {
  const node = nodeOf(answer);
  const { ledger_index: ledgerIndex, ledger_hash: ledgerHash } = answer as Json;
  // the ledger the other two objects are asked for: it has to be one the node can be asked for
  if (!isUInt32(ledgerIndex) || ledgerIndex < 1)
    return invalid('the answer has no ledger_index that is a ledger sequence');
  return { ledger_index: ledgerIndex, ledger_hash: typeof ledgerHash === 'string' ? ledgerHash : undefined, node };
}

/**
 * The reader of the answer to a `ledger_entry` asked for ledger `at`: its `node`, provided the answer says it is of that
 * ledger (a node that answers for another one would make a row of two ledgers).
 */
const nodeAt =
  (at: number) =>
  (answer: unknown): Json => {
    const node = nodeOf(answer);
    const answered = (answer as Json).ledger_index;
    if (typeof answered !== 'number') return invalid('the answer has no ledger_index');
    if (answered !== at) return invalid(`the answer is of ledger ${answered}, asked for ledger ${at}`);
    return node;
  };

/** The `validation_quorum` of a `server_info` result; none when the node does not report one, a count when it does. */
function quorumOf(answer: unknown): number | undefined {
  const info = isObject(answer) ? answer.info : undefined;
  if (!isObject(info)) return invalid('the answer has no info');
  if (info.validation_quorum === undefined) return undefined;
  return isUInt32(info.validation_quorum) ? info.validation_quorum : invalid('validation_quorum is not a count');
}

/**
 * Polls the node for the ledger state and the names of the amendments (spec 2.3), and keeps the gauge of the amendments
 * that have no entry in the amendment metadata.
 *
 * **State** (`pollState`, every 60 s): `ledger_entry` of the Amendments object at the `validated` ledger L, then, at L, the
 * NegativeUNL (`entryNotFound` is an empty one) and FeeSettings objects, whose answers have to be of L, and `server_info`
 * for the quorum, together; one `network_state` row. `server_info` takes no ledger: it is the node's current answer, read
 * together with the state at L. **Features** (`pollFeatures`, at start and every 10 min): `feature`, one `amendment_features` row per
 * ID. Each request has a timeout of 5 s and no retry (the next poll is the retry), and is counted
 * (`syncer_validators_node_polls_total{request, outcome}`). A poll in which any request fails, or an answer cannot be
 * stored, writes nothing and resolves `false`; a ClickHouse that fails rejects. A poll called while one of its kind is
 * under way is that poll, so they never overlap.
 *
 * **Logs** name the request and the code of an answer of the node or the message of the error, never an error object. A
 * failure is logged when it starts, or when it changes, and the end of it once.
 *
 * **Gauge** (`updateMetadataGauge`, after each feature poll): `syncer_amendments_without_metadata` is the number of
 * amendment IDs in the newest `amendment_features` rows, the newest `network_state` row (enabled, and with a majority) and
 * the newest round of `amendment_tallies` that the metadata (`AMENDMENTS_CONFIG`) does not list. Each ID is warned about
 * once (the ones warned about are remembered in memory).
 *
 * `stop()` starts nothing more, writes nothing for what is under way, and waits for it.
 */
@Injectable()
export class NetworkStatePoller {
  private readonly now: () => number;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  private readonly timeoutMs: number;
  /** The IDs without metadata that were warned about. */
  private readonly warned = new Set<string>();
  /** What the failure under way of each poll was, as it was logged. */
  private readonly failing = new Map<PollKind, string>();
  private stateRun?: Promise<boolean>;
  private featuresRun?: Promise<boolean>;
  private gaugeRun?: Promise<void>;
  private stopped = false;

  constructor(
    @Inject(NODE_CLIENT) private readonly node: Pick<NodeClient, 'request'>,
    @Inject(ClickHouseService) private readonly ch: Pick<ClickHouseService, 'query' | 'insert'>,
    @Inject(PrometheusService)
    private readonly metrics: Pick<PrometheusService, 'validatorsNodePollsTotal' | 'amendmentsWithoutMetadata'>,
    @Inject(AMENDMENTS_CONFIG) private readonly amendments: Pick<AmendmentsConfig, 'byId'>,
    @Optional() @Inject(VALIDATORS_WORKER_OPTIONS) options: ValidatorsWorkerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? new Logger(NetworkStatePoller.name);
    this.timeoutMs = options.nodeRequestTimeoutMs ?? NETWORK_STATE_REQUEST_TIMEOUT_MS;
  }

  /** One state poll; resolves `true` when a `network_state` row was written. */
  pollState(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    this.stateRun ??= this.runState().finally(() => {
      this.stateRun = undefined;
    });
    return this.stateRun;
  }

  /** One feature poll; resolves `true` when the node's answer is stored. */
  pollFeatures(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    this.featuresRun ??= this.runFeatures().finally(() => {
      this.featuresRun = undefined;
    });
    return this.featuresRun;
  }

  /** Sets the gauge of the amendments without metadata from what is stored, and warns about the new ones. */
  updateMetadataGauge(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.gaugeRun ??= this.runGauge().finally(() => {
      this.gaugeRun = undefined;
    });
    return this.gaugeRun;
  }

  /** Starts nothing more and waits for what is under way. */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([this.stateRun, this.featuresRun, this.gaugeRun]);
  }

  // -- the polls ----------------------------------------------------------------------------------------------------

  private async runState(): Promise<boolean> {
    const amendments = await this.ask(
      'amendments',
      { command: 'ledger_entry', index: AMENDMENTS_OBJECT_INDEX, ledger_index: 'validated' },
      amendmentsAnswerOf,
    );
    if (!amendments.ok) return this.failed('state', [amendments.problem]);
    // the other objects are read at the ledger of the first, so that the row is of one ledger
    const at = amendments.value.ledger_index;
    const [negativeUnl, feeSettings, quorum] = await Promise.all([
      this.ask<Json | undefined>(
        'negative_unl',
        { command: 'ledger_entry', index: NEGATIVE_UNL_OBJECT_INDEX, ledger_index: at },
        nodeAt(at),
        { value: undefined },
      ),
      this.ask(
        'fee_settings',
        { command: 'ledger_entry', index: FEE_SETTINGS_OBJECT_INDEX, ledger_index: at },
        nodeAt(at),
      ),
      this.ask('server_info', { command: 'server_info' }, quorumOf),
    ]);
    if (!negativeUnl.ok || !feeSettings.ok || !quorum.ok) {
      const problems = [negativeUnl, feeSettings, quorum].flatMap((outcome) => (outcome.ok ? [] : [outcome.problem]));
      return this.failed('state', problems);
    }
    if (this.stopped) return false;

    let row: NetworkStateRow;
    try {
      row = networkStateRowFrom(
        amendments.value,
        negativeUnl.value,
        feeSettings.value,
        quorum.value,
        this.now() / 1000,
      );
    } catch (err) {
      return this.failed('state', [describeError(err)]);
    }
    await this.ch.insert(Table.NetworkState, [row]);
    this.recovered('state');
    return true;
  }

  private async runFeatures(): Promise<boolean> {
    const features = await this.ask('feature', { command: 'feature' }, (answer) =>
      featureRowsFrom(answer, this.now() / 1000),
    );
    if (!features.ok) return this.failed('features', [features.problem]);
    if (this.stopped) return false;
    await this.ch.insert(Table.AmendmentFeatures, features.value);
    this.recovered('features');
    return true;
  }

  /**
   * One request to the node: 5 s, no retry, counted `ok` when the node answered with what `read` takes, `error` otherwise
   * (also for an answer that is not what was asked for). `whenNotFound` is the value when the node says `entryNotFound`,
   * which is an answer, not a failure.
   */
  private async ask<T>(
    request: PollRequest,
    command: Json,
    read: (answer: unknown) => T,
    whenNotFound?: { value: T },
  ): Promise<Outcome<T>> {
    try {
      let value: T;
      try {
        value = read(await this.node.request(command, { timeoutMs: this.timeoutMs, retries: 0 }));
      } catch (err) {
        if (whenNotFound === undefined || !isRippledError(err) || rippledCodeOf(err) !== 'entryNotFound') throw err;
        value = whenNotFound.value;
      }
      this.metrics.validatorsNodePollsTotal.inc({ request, outcome: 'ok' });
      return { ok: true, value };
    } catch (err) {
      this.metrics.validatorsNodePollsTotal.inc({ request, outcome: 'error' });
      const why = isRippledError(err) ? `the node answered ${rippledCodeOf(err)}` : describeError(err);
      return { ok: false, problem: `${request}: ${why}` };
    }
  }

  /** Logs a failure of a poll when it starts or changes, and gives `false` for the poll. */
  private failed(kind: PollKind, problems: string[]): false {
    if (this.stopped) return false;
    const text = problems.join('; ');
    if (this.failing.get(kind) !== text) {
      this.failing.set(kind, text);
      this.logger.warn(`${POLL_NAME[kind]} poll failed: ${text}`);
    }
    return false;
  }

  /** Logs the end of a failure of a poll. */
  private recovered(kind: PollKind): void {
    if (this.failing.delete(kind)) this.logger.log(`${POLL_NAME[kind]} poll recovered`);
  }

  // -- the gauge ----------------------------------------------------------------------------------------------------

  private async runGauge(): Promise<void> {
    const seen = await this.amendmentIdsSeen();
    if (this.stopped) return;
    const without = [...seen].filter((id) => !this.amendments.byId.has(id)).sort();
    for (const id of without) {
      if (this.warned.has(id)) continue;
      this.warned.add(id);
      this.logger.warn(`amendment ${id} has no metadata entry`);
    }
    this.metrics.amendmentsWithoutMetadata.set(without.length);
  }

  /** The amendment IDs of the newest feature rows, the newest network state (enabled, in a majority) and the newest round. */
  private async amendmentIdsSeen(): Promise<Set<string>> {
    const seen = new Set<string>();
    const features = await this.ch.query<{ amendment_id: string }>(
      `SELECT amendment_id FROM ${Table.AmendmentFeatures}
        WHERE polled_at = (SELECT max(polled_at) FROM ${Table.AmendmentFeatures})`,
    );
    for (const row of features) seen.add(row.amendment_id);

    const [state] = await this.ch.query<{ amendments: string[]; majority_ids: string[] }>(
      `SELECT amendments, arrayMap(m -> tupleElement(m, 'amendment'), majorities) AS majority_ids
         FROM ${Table.NetworkState}
        ORDER BY ledger_index DESC
        LIMIT 1`,
    );
    for (const id of [...(state?.amendments ?? []), ...(state?.majority_ids ?? [])]) seen.add(id);

    // the newest round is the newest sentinel; its rows are those of the sentinel's newest version (a version set)
    const [round] = await this.ch.query<{ ledger_index: number; version: string }>(
      `SELECT ledger_index, toString(max(version)) AS version
         FROM ${Table.AmendmentTallies}
        WHERE amendment_id = ''
        GROUP BY ledger_index
        ORDER BY ledger_index DESC
        LIMIT 1`,
    );
    if (round !== undefined) {
      const tallies = await this.ch.query<{ amendment_id: string }>(
        `SELECT amendment_id FROM ${Table.AmendmentTallies}
          WHERE amendment_id != '' AND ledger_index = {ledger:UInt32} AND version = {version:UInt64}`,
        { ledger: round.ledger_index, version: round.version },
      );
      for (const row of tallies) seen.add(row.amendment_id);
    }
    return seen;
  }
}
