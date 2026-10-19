import { AmendmentsConfig, ClickHouseService, NetworkProfile, Table } from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { NETWORK_PROFILE } from '../config/api.config';
import {
  amendmentIds,
  AmendmentsAssembly,
  AmendmentSources,
  AmendmentView,
  assembleAmendments,
  EnableTx,
  findAmendment,
  NodeFeature,
  RoundPoint,
  roundPoints,
  WINDOW_DAYS,
  windowFloor,
  WindowRound,
} from './amendment-status';
import { Directory } from './directory';
import { ValidatorDirectoryService } from './validator-directory.service';

/** The metadata of the amendments of the network (`GH_AMENDMENTS_CONFIG`, else the file that ships), loaded at boot. */
export const AMENDMENTS_CONFIG = Symbol('AMENDMENTS_CONFIG');

/** How long a built assembly is served, in milliseconds. */
export const AMENDMENTS_TTL_MS = 10_000;

const DAY = 86_400;

/** The IDs in upper and in lower case, for a read that must find an ID in either: the first key of the table keeps it on its key. */
const bothCases = (ids: readonly string[]): string[] =>
  [...new Set(ids.flatMap((id) => [id.toUpperCase(), id.toLowerCase()]))].sort();

/** A number that may arrive as text (64-bit integers). */
type Num = number | string;

/**
 * The rounds of the window: the newest version of each round's sentinel. A round is its rows of that version and no other.
 * `versions[i]` is the version of `rounds[i]`, UInt64 as text: a version goes back to ClickHouse exactly as it came out,
 * never through a JavaScript number (as `Array(String)`, since an `Array(UInt64)` parameter does not take quoted numbers).
 */
interface VotingWindow {
  rounds: WindowRound[];
  versions: string[];
}

/**
 * Assembles the amendments (spec 2.7, 3.5) and keeps them for 10 s.
 *
 * **Reads.** `network_state` comes from the validator directory the assembly is built on (its newest row, and its newest
 * round); the rest is read here, in parallel where it can be: what the node says (`amendment_features`, the newest row of
 * each ID), the `EnableAmendment` transactions (`tx_by_type` by its type, then `transactions` by their keys: a few hundred),
 * the sentinels of the rounds of the last 30 days, the amendments in the votes of those rounds and the tallies of the newest.
 * Every read of `validator_votes` and `amendment_tallies` takes the version of the newest sentinel of each round and only the
 * rows of that version. None aggregates by validator, so none maps a key; the votes of each validator are the directory's.
 * Values are bound as query parameters; table names come from `Table`; nothing uses `FINAL`.
 *
 * **How old an answer can be.** The assembly is kept 10 s from the start of its build, on top of a directory that can be 10 s old
 * when the build starts: about 20 s at most (the reference says so). The newest round, with its version, is the directory's.
 *
 * **One build at a time.** As the directory does: `CacheService` keeps the result for 10 s but does not stop two requests that
 * find it empty from both building, so the service keeps its own promise of the build in flight, and drops it when it settles
 * (a failed build is not kept). The window of rounds belongs to the directory it was read for, and the rounds of an
 * amendment to the amendment of that assembly, so both are kept as long as those are (`WeakMap`s), read once however many
 * requests ask, and not kept when the read fails.
 */
@Injectable()
export class AmendmentsService {
  private readonly building = new Map<string, Promise<AmendmentsAssembly>>();
  private readonly windows = new WeakMap<Directory, Promise<VotingWindow>>();
  private readonly points = new WeakMap<AmendmentView, Promise<RoundPoint[]>>();

  constructor(
    private readonly ch: ClickHouseService,
    private readonly cache: CacheService,
    private readonly directories: ValidatorDirectoryService,
    @Inject(AMENDMENTS_CONFIG) private readonly config: AmendmentsConfig,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  /** The amendments: the cached ones, or the ones being built, or new ones. */
  get(): Promise<AmendmentsAssembly> {
    const network = this.profile.name;
    const inFlight = this.building.get(network);
    if (inFlight !== undefined) return inFlight;
    const settled = this.cache
      .wrap(`amendments:${network}`, AMENDMENTS_TTL_MS, () => this.build())
      .finally(() => {
        if (this.building.get(network) === settled) this.building.delete(network);
      });
    this.building.set(network, settled);
    return settled;
  }

  /** The amendment a request names: a name, a name in another case when only one has it, an ID in any case. */
  find(assembly: AmendmentsAssembly, ref: string): AmendmentView | undefined {
    return findAmendment(assembly, ref);
  }

  /**
   * The rounds of the last 30 days for an amendment (spec 3.6), oldest first, as long as the assembly it is in is kept. An
   * enabled amendment has the rounds before the ledger it was enabled in only. `directory` is the one the assembly was built on.
   */
  rounds(view: AmendmentView, directory: Directory): Promise<RoundPoint[]> {
    let known = this.points.get(view);
    if (known === undefined) {
      known = this.readPoints(view, directory);
      this.points.set(view, known);
      known.catch(() => this.points.delete(view));
    }
    return known;
  }

  // -- the assembly ---------------------------------------------------------------------------------------------------

  private async build(): Promise<AmendmentsAssembly> {
    const directory = await this.directories.get();
    const [window, features, transactions] = await Promise.all([
      this.windowOf(directory),
      this.readFeatures(),
      this.readEnableAmendments(),
    ]);
    const voted = await this.readVoted(window);
    const known = { config: this.config, features, voted };
    const sources: AmendmentSources = {
      ...known,
      yes: await this.readTallies(window, amendmentIds(directory, known)),
      transactions,
      majorityHoldSeconds: this.profile.majorityHoldSeconds,
    };
    return assembleAmendments(directory, sources);
  }

  /** What the node says of each amendment: its newest row. */
  private async readFeatures(): Promise<Map<string, NodeFeature>> {
    const rows = await this.ch.query<{ amendment_id: string; feature_name: string; feature_supported: Num }>(
      `SELECT amendment_id,
              argMax(name, polled_at) AS feature_name,
              argMax(supported, polled_at) AS feature_supported
         FROM ${Table.AmendmentFeatures}
        GROUP BY amendment_id
        ORDER BY amendment_id`,
    );
    return new Map(
      rows.map((row) => [row.amendment_id, { name: row.feature_name, supported: Number(row.feature_supported) === 1 }]),
    );
  }

  /** Every indexed `EnableAmendment`: found by its type in `tx_by_type`, read from `transactions` by their keys. */
  private async readEnableAmendments(): Promise<EnableTx[]> {
    const rows = await this.ch.query<{
      event_ledger: Num;
      event_close: Num;
      event_hash: string;
      event_amendment: string;
      event_flags: Num;
    }>(
      `SELECT t.ledger_index AS event_ledger,
              toUnixTimestamp(t.close_time) AS event_close,
              t.hash AS event_hash,
              JSONExtractString(t.tx_json, 'Amendment') AS event_amendment,
              JSONExtractUInt(t.tx_json, 'Flags') AS event_flags
         FROM ${Table.Transactions} AS t
        WHERE (t.ledger_index, t.tx_index) IN (
                SELECT ledger_index, tx_index
                  FROM ${Table.TxByType}
                 WHERE tx_type = {type:String})
        ORDER BY t.ledger_index, t.tx_index`,
      { type: 'EnableAmendment' },
    );
    return rows.map((row) => ({
      amendment: row.event_amendment,
      flags: Number(row.event_flags),
      ledgerIndex: Number(row.event_ledger),
      date: Number(row.event_close),
      txHash: row.event_hash,
    }));
  }

  // -- the rounds ---------------------------------------------------------------------------------------------------

  private windowOf(directory: Directory): Promise<VotingWindow> {
    let known = this.windows.get(directory);
    if (known === undefined) {
      known = this.readWindow(directory);
      this.windows.set(directory, known);
      known.catch(() => this.windows.delete(directory));
    }
    return known;
  }

  /**
   * The rounds of the last 30 days, oldest first, each with the version of its newest sentinel, up to the newest round the
   * directory has. That round, the newest, is the directory's own, with the version the directory read it at, and is there
   * however old it is: the figures of the answer (`round`, `votes.trusted`, `needed`, the votes of the validators) are the
   * directory's, so the tallies and the rows read for them have to be of the same version. A syncer that writes the round
   * again between the directory's read and this one is for the next directory. The rounds below it are read here.
   */
  private async readWindow(directory: Directory): Promise<VotingWindow> {
    const newest = directory.newestRound;
    if (newest === undefined) return { rounds: [], versions: [] };
    const since = Math.max(0, Math.floor(directory.builtAt / 1000) - WINDOW_DAYS * DAY);
    const rows = await this.ch.query<{
      ledger_index: Num;
      newest_version: string;
      round_close: Num;
      round_trusted: Num;
      round_threshold: Num;
    }>(
      `SELECT ledger_index,
              toString(max(version)) AS newest_version,
              toUnixTimestamp(argMax(close_time, version)) AS round_close,
              argMax(trusted, version) AS round_trusted,
              argMax(threshold, version) AS round_threshold
         FROM ${Table.AmendmentTallies}
        WHERE amendment_id = '' AND ledger_index >= {floor:UInt32} AND ledger_index < {newest:UInt32}
        GROUP BY ledger_index
       HAVING round_close >= {since:UInt32}
        ORDER BY ledger_index`,
      { floor: windowFloor(newest.ledgerIndex), newest: newest.ledgerIndex, since },
    );
    return {
      rounds: [
        ...rows.map((row) => ({
          ledgerIndex: Number(row.ledger_index),
          closeTime: Number(row.round_close),
          trusted: Number(row.round_trusted),
          threshold: Number(row.round_threshold),
        })),
        {
          ledgerIndex: newest.ledgerIndex,
          closeTime: newest.closeTime,
          trusted: newest.trusted,
          threshold: newest.threshold,
        },
      ],
      versions: [...rows.map((row) => row.newest_version), newest.version],
    };
  }

  /** Every amendment ID in the votes of the rounds of the window, whoever cast them. */
  private async readVoted(window: VotingWindow): Promise<Set<string>> {
    if (window.rounds.length === 0) return new Set();
    const row = await this.ch.queryOne<{ voted_ids: string[] }>(
      `SELECT groupUniqArrayArray(amendments) AS voted_ids
         FROM ${Table.ValidatorVotes}
        WHERE ledger_index >= {first:UInt32} AND ledger_index <= {last:UInt32}
          AND version = toUInt64(transform(ledger_index, {rounds:Array(UInt32)}, {versions:Array(String)}, '0'))`,
      this.rangeOf(window),
    );
    return new Set(row?.voted_ids ?? []);
  }

  /**
   * The yes votes of the amendments in the newest round: its tally rows of the version of its sentinel. Each ID is asked for
   * in upper and in lower case (a list of the first key of the table, which keeps the read on its key), and the answer is
   * merged by ID where the case is dropped, so the case a writer used does not matter.
   */
  private async readTallies(window: VotingWindow, ids: readonly string[]): Promise<Map<string, number>> {
    const index = window.rounds.length - 1;
    if (index < 0 || ids.length === 0) return new Map();
    const rows = await this.ch.query<{ amendment_id: string; round_yes: Num }>(
      `SELECT amendment_id, max(yes) AS round_yes
         FROM ${Table.AmendmentTallies}
        WHERE amendment_id IN {ids:Array(String)} AND ledger_index = {round:UInt32} AND version = toUInt64({version:String})
        GROUP BY amendment_id
        ORDER BY amendment_id`,
      { ids: bothCases(ids), round: window.rounds[index].ledgerIndex, version: window.versions[index] },
    );
    return new Map(rows.map((row) => [row.amendment_id, Number(row.round_yes)]));
  }

  private async readPoints(view: AmendmentView, directory: Directory): Promise<RoundPoint[]> {
    const window = await this.windowOf(directory);
    // the rounds this amendment has; none to read for one with none (an enabled one whose ledger is not known)
    const wanted = roundPoints(window.rounds, new Map(), view);
    if (wanted.length === 0) return [];
    const rows = await this.ch.query<{ ledger_index: Num; round_yes: Num }>(
      `SELECT ledger_index, max(yes) AS round_yes
         FROM ${Table.AmendmentTallies}
        WHERE amendment_id IN {amendments:Array(String)}
          AND ledger_index >= {first:UInt32} AND ledger_index <= {last:UInt32}
          AND version = toUInt64(transform(ledger_index, {rounds:Array(UInt32)}, {versions:Array(String)}, '0'))
        GROUP BY ledger_index
        ORDER BY ledger_index`,
      {
        ...this.rangeOf(window),
        first: wanted[0].ledgerIndex,
        last: wanted[wanted.length - 1].ledgerIndex,
        amendments: bothCases([view.id]),
      },
    );
    return roundPoints(
      window.rounds,
      new Map(rows.map((row) => [Number(row.ledger_index), Number(row.round_yes)])),
      view,
    );
  }

  /** The parameters of a read of the rows of the window's rounds: the range of them, and each round's version. */
  private rangeOf(window: VotingWindow): {
    first: number;
    last: number;
    rounds: number[];
    versions: string[];
  } {
    const rounds = window.rounds.map((round) => round.ledgerIndex);
    return { first: rounds[0], last: rounds[rounds.length - 1], rounds, versions: window.versions };
  }
}
