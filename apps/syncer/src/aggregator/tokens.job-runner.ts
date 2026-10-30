import {
  applyLineStates,
  buildingGenerationOf,
  committedHead,
  distinctHolders,
  dropTokenGeneration,
  LineKey,
  liveGenerationOf,
  NetworkProfile,
  nextPassAccounts,
  parserFloorOf,
  passTokens,
  RatesService,
  readTokenGenerations,
  recomputeTokens,
  stateCoverageStart,
  TOKEN_PARSER_VERSION,
  TokenGenerationsRow,
  TokenKey,
  TOKENS_CONFIG_VERSION,
  TOKENS_HOUSEKEEPING_EVERY_TICKS,
  TOKENS_PASS_ACCOUNTS,
  TOKENS_PROMOTE_NEAR_HEAD,
  TOKENS_RETIRED_KEEP_MS,
  TOKENS_STATE_CHUNK,
  TOKENS_TOUCH_WINDOW,
  TOKENS_TOUCH_WINDOW_MAX_LINES,
  TokensAborted,
  tokensOfIssuers,
  tokensVersionFloor,
  tomlSweep,
  touchesOfWindow,
  writePassLines,
  writeTokenGeneration,
} from '@gatehub/data-api-shared';
import { AggregatorJobContext, AggregatorTick, Backoff, backoffAfterFailure, describe } from './job-context';
import { NFT_MAX_RETRY_MS, NFT_RETRY_MS } from './nft-state.job-runner';

/**
 * What the `tokens` job works with: the network (the toml names its tokens are matched with), the rates of the network, which the
 * hook of `agg_dirty` finds the ledgers of a slice with, and the two knobs the tests turn.
 */
export interface AggregatorTokens {
  profile: NetworkProfile;
  /** The slice of an `agg_dirty` range (a span of time) to the ledgers that closed in it (`ledgersClosedIn`). */
  rates: RatesService;
  /** The config version the generations are built for; a generation of another one is replaced. Default `TOKENS_CONFIG_VERSION`. */
  configVersion?: number;
  /** How long a retired generation is kept before its partitions are dropped, in milliseconds. Default `TOKENS_RETIRED_KEEP_MS`. */
  retiredKeepMs?: number;
}

/** The functions of the shared package the `tokens` job calls; tests replace them. */
export interface TokensFunctions {
  readTokenGenerations: typeof readTokenGenerations;
  writeTokenGeneration: typeof writeTokenGeneration;
  /** Where the state tables are readable from (`undefined`: no ledger is stored). A full scan of `ledgers.parser_version`: housekeeping only. */
  stateCoverageStart: typeof stateCoverageStart;
  tokensVersionFloor: typeof tokensVersionFloor;
  /** The newest committed ledger, 0 without one. */
  head: typeof committedHead;
  nextPassAccounts: typeof nextPassAccounts;
  writePassLines: typeof writePassLines;
  passTokens: typeof passTokens;
  parserFloorOf: typeof parserFloorOf;
  touchesOfWindow: typeof touchesOfWindow;
  applyLineStates: typeof applyLineStates;
  tokensOfIssuers: typeof tokensOfIssuers;
  recomputeTokens: typeof recomputeTokens;
  distinctHolders: typeof distinctHolders;
  tomlSweep: typeof tomlSweep;
  dropTokenGeneration: typeof dropTokenGeneration;
}

/** The functions of the shared package, for what the options do not replace. */
export const TOKENS_FUNCTIONS: TokensFunctions = {
  readTokenGenerations,
  writeTokenGeneration,
  stateCoverageStart,
  tokensVersionFloor,
  head: committedHead,
  nextPassAccounts,
  writePassLines,
  passTokens,
  parserFloorOf,
  touchesOfWindow,
  applyLineStates,
  tokensOfIssuers,
  recomputeTokens,
  distinctHolders,
  tomlSweep,
  dropTokenGeneration,
};

/** What a run sees of the tables: the generations as they are (kept up to date as the run writes them) and the newest committed ledger. */
interface Seen {
  gens: TokenGenerationsRow[];
  head: number;
}

/** The three streams of touches, each with a window of its own (the repair reads ledgers the live touches have long passed). */
type Role = 'live' | 'repair' | 'building';

/** A step that failed: how many times in a row, the generation it belongs to (to forget it with the generation), and when it may go on. */
interface Streak {
  generation: number;
  failures: number;
  backoff?: Backoff;
}

/**
 * The `tokens` job of the aggregator (see `AggregatorService`, job 8), and its hook in the slices of `agg_dirty`: it keeps the
 * generations of the issued tokens (`token_generations`, `token_lines`, `tokens`; spec 3): the touches of the live generation, its
 * repair, the housekeeping (the rebuild check, the distinct holders, the toml sweep), the account pass and the touches of the
 * generation that builds, its promotion, and the drop of the generations retired. The state of the job is in the generation rows,
 * which every step reads again at the next run; what is in memory (the housekeeping count, the version floor, the halved windows,
 * the backoffs, the cursor of the sweep, the generations marked for a rebuild) is only what a restart can find again or does
 * without. The database, the clock, the budgets and the rules of the tick are the service's (`AggregatorJobContext`).
 *
 * **Versions.** Every row the job writes has a version at least one more than any it wrote before and than any stored (the
 * `tokensVersionFloor` of the first run): `nextVersion()`, the clock in milliseconds or one above the floor. The floor moves up with
 * each version given out, and the clock going back changes nothing.
 *
 * **Liveness.** A failure never stops the other steps of a run, and a run that failed sets the gauges all the same (from a read of
 * the generations and the head, `reportAfterFailure`). The first housekeeping does only the rebuild check, never the holders (one
 * read of every line of the generation) or the sweep. A window that fails twice in a row waits, `NFT_RETRY_MS` and twice as long
 * for each failure after that, up to `NFT_MAX_RETRY_MS`; the touches of the other generation and the pass go on. The window a
 * heavy ledger halved is kept, so that the next window does not read the lines of a full one to halve it again. The repair takes at
 * most half of the budget, so that a repair of years cannot keep the housekeeping and the pass from running.
 */
export class TokensJobRunner {
  /** How many times `run` has started (the housekeeping count). */
  private runs = 0;
  /** Whether the rebuild check has run in this process: the first one does only that. */
  private checked = false;
  /** The highest version given out or stored, as read at the first run; undefined until the first run has read it. */
  private floor?: bigint;
  /** Whether the last run failed: the hook of a slice must not write after a run that did (`ofSlice`). */
  private lastRunFailed = false;
  /** The window (ledgers) each stream requests; halved by `touchesOfWindow` while a window holds too many lines. */
  private readonly windows: Record<Role, number> = {
    live: TOKENS_TOUCH_WINDOW,
    repair: TOKENS_TOUCH_WINDOW,
    building: TOKENS_TOUCH_WINDOW,
  };
  /** The steps that failed (`<generation>:<step>`). */
  private readonly streaks = new Map<string, Streak>();
  /** The generations a rebuild is wanted for: they met a ledger of an older parser, in their touches or in their repair. */
  private readonly stale = new Set<number>();
  /** The generations whose touches met such a ledger: they cannot be moved on, and are served as they are until replaced. */
  private readonly blocked = new Set<number>();
  /** The retired generations whose partitions this process has dropped. */
  private readonly dropped = new Set<number>();
  /** The toml sweep that is under way: the generation, and the token it goes on after (none before its first token). */
  private sweep?: { generation: number; after?: TokenKey };

  private readonly configVersion: number;
  private readonly retiredKeepMs: number;

  constructor(
    private readonly ctx: AggregatorJobContext,
    private readonly tokens: AggregatorTokens,
    private readonly fns: TokensFunctions,
  ) {
    this.configVersion = tokens.configVersion ?? TOKENS_CONFIG_VERSION;
    this.retiredKeepMs = tokens.retiredKeepMs ?? TOKENS_RETIRED_KEEP_MS;
  }

  /**
   * One run of the job (spec 3, a tick): the touches of the live generation, its repair, every `TOKENS_HOUSEKEEPING_EVERY_TICKS`-th
   * run the housekeeping, the generation that builds, and the drop, each while the budget lasts. A step that fails is the failure
   * of the job (the first is thrown, the others are logged and counted here) and the parts after it still run; the next run starts
   * over from the rows. The housekeeping runs at the 1st, 11th, 21st … run, and at the next run when it could not run at the 1st
   * (no budget, a failed read); the rebuild check of the first housekeeping is all it does.
   */
  async run(tick: AggregatorTick): Promise<void> {
    if (this.ctx.closing()) return;
    const n = ++this.runs;
    const failures: unknown[] = [];
    const part = async (work: () => Promise<unknown>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    let seen: Seen | undefined;
    try {
      seen = await this.begin();
    } catch (error) {
      failures.push(error);
    }
    if (seen !== undefined) {
      const sight = seen;
      await part(() => this.liveTouches(tick, sight));
      await part(() => this.repair(tick, sight));
      if (!this.checked || (n - 1) % TOKENS_HOUSEKEEPING_EVERY_TICKS === 0) {
        const first = !this.checked;
        await part(async () => {
          this.checked = (await this.rebuildCheck(tick, sight)) || this.checked;
        });
        if (!first) {
          await part(() => this.holders(tick, sight));
          await part(() => this.tomlSweep(tick, sight));
        }
      }
      await part(() => this.building(tick, sight));
      await part(() => this.drop(tick, sight));
    }
    this.lastRunFailed = failures.length > 0;
    if (failures.length === 0 && seen !== undefined) {
      this.setGauges(seen.gens, seen.head);
      return;
    }
    await this.reportAfterFailure();
    for (const error of failures.slice(1)) this.ctx.failed('tokens', error);
    throw failures[0];
  }

  /**
   * The agg_dirty hook (spec 3.5): sets `repair_from` of every live or building generation whose `through_ledger` reaches the first
   * ledger of the slice `[start, end)` (unix seconds) to the lower of its value and that ledger (no lower than the generation's
   * `coverage_from`: a slice below it is left to the rebuild check), one generation row each; the next run applies the repair. It
   * does no other work, and writes nothing when `repair_from` would not change. A version needs the floor of a run: before the first
   * run has read it, or after a run that failed (it may have written some of its rows, and its read of the generations is no
   * longer the state), it throws before reading anything, so that the slice fails and its range stays in `agg_dirty`.
   */
  async ofSlice(start: number, end: number, tick: AggregatorTick): Promise<void> {
    if (this.ctx.closing()) return;
    if (this.floor === undefined) throw new Error('the tokens job has not read its version floor yet');
    if (this.lastRunFailed) throw new Error('the tokens step of this tick failed');
    const ledgers = await this.tokens.rates.ledgersClosedIn(new Date(start * 1000), new Date(end * 1000));
    if (ledgers === null || this.ctx.closing()) return;
    const seen: Seen = { gens: await this.fns.readTokenGenerations(this.ctx.ch), head: 0 };
    if (this.ctx.closing()) return;
    for (const g of [...seen.gens]) {
      if (g.state === 'retired' || g.through_ledger < ledgers.min || ledgers.max < g.coverage_from) continue;
      const first = Math.max(ledgers.min, g.coverage_from);
      const repairFrom = g.repair_from === 0 ? first : Math.min(g.repair_from, first);
      if (repairFrom === g.repair_from) continue;
      await this.change(tick, seen, g, { repair_from: repairFrom });
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The start of a run, the versions and the gauges
  // -------------------------------------------------------------------------------------------------------------------

  /** Reads the generations and the head, and the version floor the first time; forgets what belongs to generations that are gone. */
  private async begin(): Promise<Seen> {
    const gens = await this.fns.readTokenGenerations(this.ctx.ch);
    const head = await this.fns.head(this.ctx.ch);
    if (this.floor === undefined) this.floor = BigInt(await this.fns.tokensVersionFloor(this.ctx.ch));
    const active = new Set(gens.filter((g) => g.state !== 'retired').map((g) => g.generation));
    for (const set of [this.stale, this.blocked]) for (const g of set) if (!active.has(g)) set.delete(g);
    for (const [key, streak] of this.streaks) if (!active.has(streak.generation)) this.streaks.delete(key);
    return { gens, head };
  }

  /** The version of the next write: the clock in milliseconds, or one above the highest version so far; the floor moves to it. */
  private nextVersion(): string {
    if (this.floor === undefined) throw new Error('the tokens job has not read its version floor yet');
    const clock = BigInt(Math.max(0, Math.floor(this.ctx.clock())));
    this.floor = clock > this.floor ? clock : this.floor + 1n;
    return this.floor.toString();
  }

  private setGauges(gens: readonly TokenGenerationsRow[], head: number): void {
    const metrics = this.ctx.metrics;
    if (!metrics) return;
    const live = liveGenerationOf(gens);
    metrics.tokensLive.set(live ? 1 : 0);
    metrics.tokensLagLedgers.set(live ? Math.max(0, head - live.through_ledger) : 0);
    metrics.tokensBuilding.set(buildingGenerationOf(gens) ? 1 : 0);
    metrics.tokensRepairLedgers.set(
      live && live.repair_from > 0 ? Math.max(0, live.through_ledger - live.repair_from) : 0,
    );
  }

  /**
   * Sets the gauges after a run that failed, from the generations and the head, read then: a window that is stuck shows as a lag
   * that grows with the head, not as the value the gauge had before (or 0 after a restart). Nothing is read without the metrics, or
   * once the shutdown has begun. A read that fails is counted and logged as `tokens` on its own; the error of the run is the
   * caller's to throw all the same.
   */
  private async reportAfterFailure(): Promise<void> {
    if (!this.ctx.metrics || this.ctx.closing()) return;
    try {
      const gens = await this.fns.readTokenGenerations(this.ctx.ch);
      const head = await this.fns.head(this.ctx.ch);
      if (this.ctx.closing()) return;
      this.setGauges(gens, head);
    } catch (err) {
      this.ctx.failed('tokens', err, ' reading the gauges');
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Writing generation rows
  // -------------------------------------------------------------------------------------------------------------------

  /** Whether another step may start: the budget of the job lasts and the shutdown has not begun. */
  private go(tick: AggregatorTick): boolean {
    return !this.ctx.closing() && this.ctx.mayStartSet(tick, 'tokens');
  }

  /** Writes a row of a generation under a new version and keeps `seen` as the table now is. */
  private async write(tick: AggregatorTick, seen: Seen, row: TokenGenerationsRow): Promise<void> {
    const next = { ...row, version: this.nextVersion() };
    await this.fns.writeTokenGeneration(this.ctx.ch, next, tick.signal);
    seen.gens = [...seen.gens.filter((g) => g.generation !== next.generation), next].sort(
      (a, b) => a.generation - b.generation,
    );
  }

  /** Writes the generation again with the fields of `patch` changed (and `changed_at` now). */
  private change(
    tick: AggregatorTick,
    seen: Seen,
    g: TokenGenerationsRow,
    patch: Partial<TokenGenerationsRow>,
  ): Promise<void> {
    return this.write(tick, seen, { ...g, ...patch, changed_at: this.ctx.clock() / 1000 });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Failures: a step that keeps failing waits
  // -------------------------------------------------------------------------------------------------------------------

  private waiting(generation: number, step: string): boolean {
    const until = this.streaks.get(`${generation}:${step}`)?.backoff?.until ?? 0;
    return until > this.ctx.clock();
  }

  /**
   * Runs a step of a generation. One that fails is tried again at the next run; one that fails twice in a row waits `NFT_RETRY_MS`,
   * and twice as long after each further failure, up to `NFT_MAX_RETRY_MS` (the rule of the NFTs that fail on their own); one that
   * works forgets it. Neither the shutdown nor an abort is a failure of the step.
   */
  private async guarded<T>(generation: number, step: string, work: () => Promise<T>): Promise<T> {
    const key = `${generation}:${step}`;
    try {
      const done = await work();
      this.streaks.delete(key);
      return done;
    } catch (err) {
      if (!this.ctx.closing() && !(err instanceof TokensAborted)) {
        const before = this.streaks.get(key);
        const failures = (before?.failures ?? 0) + 1;
        const backoff =
          failures < 2
            ? undefined
            : backoffAfterFailure(before?.backoff, this.ctx.clock(), NFT_RETRY_MS, NFT_MAX_RETRY_MS);
        this.streaks.set(key, { generation, failures, backoff });
        if (backoff) {
          this.ctx.logger.warn(
            `tokens: generation ${generation} ${step} failed ${failures} times in a row (${describe(err)}); ` +
              `it waits ${Math.round(backoff.delayMs / 60_000)} min`,
          );
        }
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Windows of touches (the live generation, its repair and the generation that builds)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * The next window of touches `(from, head]` of a stream. The window it asks for is the one the stream last learned (a window that
   * had to be halved because it held too many lines stays halved), and it doubles back toward `TOKENS_TOUCH_WINDOW` once the
   * touches of a window are under half of what a window may hold.
   */
  private async nextWindow(role: Role, from: number, head: number): ReturnType<TokensFunctions['touchesOfWindow']> {
    const requested = this.windows[role];
    const window = await this.fns.touchesOfWindow(this.ctx.ch, from, head, { window: requested });
    if (window.to < Math.min(from + requested, head)) {
      this.windows[role] = Math.max(1, window.to - from);
    } else if (window.lines.length * 2 <= TOKENS_TOUCH_WINDOW_MAX_LINES) {
      this.windows[role] = Math.min(TOKENS_TOUCH_WINDOW, requested * 2);
    }
    return window;
  }

  /** Whether the ledgers `(from, to]` include one written by a parser older than `TOKEN_PARSER_VERSION`: it has no touches. */
  private async olderParserIn(from: number, to: number): Promise<boolean> {
    const floor = await this.fns.parserFloorOf(this.ctx.ch, from, to);
    return floor !== null && floor < TOKEN_PARSER_VERSION;
  }

  /** Marks a generation for a rebuild because a window of it meets an older parser, once and loudly. */
  private markStale(g: TokenGenerationsRow, where: string, from: number, to: number): void {
    if (!this.stale.has(g.generation)) {
      this.ctx.logger.warn(
        `tokens: ledgers ${from + 1} - ${to} (${where} of generation ${g.generation}) were written by a parser older than ` +
          `${TOKEN_PARSER_VERSION}; they have no touches, so the generation is replaced by a new one built from the state tables`,
      );
    }
    this.stale.add(g.generation);
  }

  /**
   * Applies the touches of a window to a generation (spec 3.2 steps 3 to 5): the lines (both orientations), then the tokens of those
   * lines and of the issuers whose settings the window may have changed, recomputed as of `atLedger`, with the listing matched afresh
   * for those issuers. The window's end for a window that moves the generation on; the generation's `through_ledger` for a repair.
   */
  private async applyWindow(
    tick: AggregatorTick,
    generation: number,
    touches: { lines: LineKey[]; issuers: string[] },
    atLedger: number,
  ): Promise<void> {
    if (touches.lines.length === 0 && touches.issuers.length === 0) return;
    const version = this.nextVersion();
    const tokens: TokenKey[] = [];
    if (touches.lines.length > 0) {
      tokens.push(
        ...(await this.fns.applyLineStates(
          this.ctx.ch,
          { generation, lines: touches.lines, atLedger, version },
          tick.signal,
        )),
      );
    }
    if (touches.issuers.length > 0) {
      tokens.push(...(await this.fns.tokensOfIssuers(this.ctx.ch, generation, touches.issuers)));
    }
    if (tokens.length === 0 || this.ctx.closing()) return;
    await this.fns.recomputeTokens(
      this.ctx.ch,
      {
        generation,
        tokens,
        atLedger,
        version,
        profile: this.tokens.profile,
        rematch: new Set(touches.issuers),
      },
      tick.signal,
    );
  }

  /**
   * Moves a generation (live, or building with its pass done) over the next window of touches after its `through_ledger` (spec 3.2):
   * the lines and tokens first, then the generation row. False when there was nothing to move over, or the window met a ledger of an
   * older parser (the generation is then marked and moves no more).
   */
  private advance(
    tick: AggregatorTick,
    seen: Seen,
    g: TokenGenerationsRow,
    role: 'live' | 'building',
  ): Promise<boolean> {
    return this.guarded(g.generation, role, async () => {
      const from = g.through_ledger;
      const window = await this.nextWindow(role, from, seen.head);
      if (window.to <= from || this.ctx.closing()) return false;
      if (await this.olderParserIn(from, window.to)) {
        this.blocked.add(g.generation);
        this.markStale(g, 'touches', from, window.to);
        return false;
      }
      await this.applyWindow(tick, g.generation, window, window.to);
      if (this.ctx.closing()) return false;
      await this.change(tick, seen, g, { through_ledger: window.to });
      this.ctx.logger.debug(
        `tokens: generation ${g.generation} (${role}): ledgers ${from + 1} - ${window.to}, ` +
          `${window.lines.length} line(s), ${window.issuers.length} issuer(s)`,
      );
      return true;
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The live generation: touches and repair (spec 3.2, 3.5)
  // -------------------------------------------------------------------------------------------------------------------

  private async liveTouches(tick: AggregatorTick, seen: Seen): Promise<void> {
    for (;;) {
      const live = liveGenerationOf(seen.gens);
      if (live === undefined || live.through_ledger >= seen.head || this.blocked.has(live.generation)) return;
      if (!this.go(tick) || this.waiting(live.generation, 'live')) return;
      if (!(await this.advance(tick, seen, live, 'live'))) return;
    }
  }

  /**
   * The repair of the live generation (spec 3.5): the windows of `[repair_from, through_ledger]` again, as `(repair_from - 1,
   * through_ledger]`, each followed by a row with `repair_from` at the window's end plus one, or 0 once the end of the range is
   * past; `through_ledger` does not move. The lines and the tokens are read at `through_ledger`, not at the end of the window: a
   * line that changed in the window and again later keeps its later state. A window that meets a ledger of an older parser ends
   * the repair of this process and marks the generation for a rebuild; the mark in the row stays (a restart finds the same
   * window), until the generation that replaces it is promoted. Takes at most half of the budget of the run.
   */
  private async repair(tick: AggregatorTick, seen: Seen): Promise<void> {
    const budget = this.ctx.budgets.tokens;
    const until = Number.isFinite(budget) ? tick.deadline - Math.floor(budget / 2) : tick.deadline;
    for (;;) {
      const live = liveGenerationOf(seen.gens);
      if (live === undefined || live.repair_from === 0 || this.stale.has(live.generation)) return;
      if (!this.go(tick) || this.ctx.clock() >= until || this.waiting(live.generation, 'repair')) return;
      const more = await this.guarded(live.generation, 'repair', async () => {
        const from = live.repair_from - 1;
        const head = live.through_ledger;
        const window = await this.nextWindow('repair', from, head);
        if (window.to <= from) {
          await this.change(tick, seen, live, { repair_from: 0 });
          return false;
        }
        if (await this.olderParserIn(from, window.to)) {
          this.markStale(live, 'repair', from, window.to);
          return false;
        }
        await this.applyWindow(tick, live.generation, window, head);
        if (this.ctx.closing()) return false;
        await this.change(tick, seen, live, { repair_from: window.to >= head ? 0 : window.to + 1 });
        return true;
      });
      if (!more) return;
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Housekeeping: the rebuild check, the distinct holders, the toml sweep (spec 3.3, 3.6, 3.7)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * The rebuild check (spec 3.3): a generation is started when there is no live one and none builds, or the live one is stale. A
   * generation is stale when its `config_version` is not the job's, when the state coverage start is not its `coverage_from`, or
   * when its touches or its repair met a ledger of an older parser. A building generation that is stale for the same reasons is
   * retired first. Nothing is started without a ledger. True when the check was made (not when there is no budget for it, or no
   * ledger yet: the next run tries again, so that the first generation starts at the first run that has a ledger).
   */
  private async rebuildCheck(tick: AggregatorTick, seen: Seen): Promise<boolean> {
    if (!this.go(tick) || seen.head === 0) return false;
    const coverage = await this.fns.stateCoverageStart(this.ctx.ch);
    if (this.ctx.closing()) return false;
    if (coverage === undefined) return true;
    const isStale = (g: TokenGenerationsRow): boolean =>
      g.config_version !== this.configVersion || g.coverage_from !== coverage || this.stale.has(g.generation);
    const live = liveGenerationOf(seen.gens);
    let building = buildingGenerationOf(seen.gens);
    if (building !== undefined && isStale(building)) {
      this.ctx.logger.log(`tokens: generation ${building.generation} is stale while it builds; it is retired`);
      await this.change(tick, seen, building, { state: 'retired' });
      building = undefined;
    }
    if (building === undefined && (live === undefined || isStale(live))) {
      const generation = Math.max(0, ...seen.gens.map((g) => g.generation)) + 1;
      const now = this.ctx.clock() / 1000;
      await this.write(tick, seen, {
        generation,
        state: 'building',
        config_version: this.configVersion,
        coverage_from: coverage,
        head_ledger: seen.head,
        account_cursor: '',
        pass_done: 0,
        through_ledger: seen.head,
        repair_from: 0,
        holders: 0,
        holders_ledger: 0,
        started_at: now,
        changed_at: now,
        version: '',
      });
      this.ctx.logger.log(
        `tokens: generation ${generation} started at ledger ${seen.head} (config ${this.configVersion}, state coverage from ` +
          `${coverage}${live ? `, replacing generation ${live.generation}` : ''})`,
      );
    }
    return true;
  }

  /** The distinct holders of the live generation, written into its row with `holders_ledger` = its `through_ledger` (spec 3.6). */
  private async holders(tick: AggregatorTick, seen: Seen): Promise<void> {
    const live = liveGenerationOf(seen.gens);
    if (live === undefined || !this.go(tick)) return;
    const holders = await this.fns.distinctHolders(this.ctx.ch, live.generation);
    if (this.ctx.closing()) return;
    await this.change(tick, seen, live, { holders, holders_ledger: live.through_ledger });
  }

  /**
   * The toml sweep of the live generation (spec 3.7), `TOKENS_STATE_CHUNK` tokens a step from a cursor kept in memory, while the
   * budget lasts; a sweep the budget cut goes on at the next housekeeping, and one that reached the last token starts over from
   * the first at the next. Only the live generation is swept: a generation that builds matches the listing of each token as it
   * computes it (the pass, `rematch: 'all'`; its touches), and the sweep of the generation it becomes catches up with the tomls
   * that changed while it built. The cursor of a generation that has been replaced is dropped.
   */
  private async tomlSweep(tick: AggregatorTick, seen: Seen): Promise<void> {
    const live = liveGenerationOf(seen.gens);
    if (live === undefined) {
      this.sweep = undefined;
      return;
    }
    let cursor = this.sweep?.generation === live.generation ? this.sweep : { generation: live.generation };
    while (this.go(tick)) {
      const step = await this.fns.tomlSweep(
        this.ctx.ch,
        {
          generation: live.generation,
          version: this.nextVersion(),
          profile: this.tokens.profile,
          after: cursor.after,
          limit: TOKENS_STATE_CHUNK,
        },
        tick.signal,
      );
      this.ctx.logger.debug(`tokens: toml sweep of generation ${live.generation}: ${step.rewritten} row(s) rewritten`);
      if (step.next === undefined) {
        this.sweep = undefined;
        return;
      }
      cursor = { generation: live.generation, after: step.next };
      this.sweep = cursor;
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The generation that builds: its pass, its touches, its promotion (spec 3.1, 3.3)
  // -------------------------------------------------------------------------------------------------------------------

  private async building(tick: AggregatorTick, seen: Seen): Promise<void> {
    await this.retireSuperseded(tick, seen);
    for (;;) {
      const building = buildingGenerationOf(seen.gens);
      if (building === undefined || !this.go(tick)) return;
      if (building.pass_done === 0) {
        if (this.waiting(building.generation, 'pass')) return;
        await this.passBatch(tick, seen, building);
        continue;
      }
      if (await this.promoteIfReady(tick, seen, building)) return;
      if (building.through_ledger >= seen.head || this.blocked.has(building.generation)) return;
      if (this.waiting(building.generation, 'building')) return;
      if (!(await this.advance(tick, seen, building, 'building'))) return;
    }
  }

  /** One batch of the account pass (spec 3.1): `TOKENS_PASS_ACCOUNTS` accounts' lines and tokens, then the row with the new cursor. */
  private passBatch(tick: AggregatorTick, seen: Seen, g: TokenGenerationsRow): Promise<void> {
    return this.guarded(g.generation, 'pass', async () => {
      const after = g.account_cursor;
      const accounts = await this.fns.nextPassAccounts(this.ctx.ch, after, TOKENS_PASS_ACCOUNTS);
      if (this.ctx.closing()) return;
      const through = accounts[accounts.length - 1];
      if (through === undefined) {
        await this.change(tick, seen, g, { pass_done: 1 });
        this.ctx.logger.log(
          `tokens: generation ${g.generation}: the account pass is done (last account ${after || '-'})`,
        );
        return;
      }
      const version = this.nextVersion();
      await this.fns.writePassLines(
        this.ctx.ch,
        { generation: g.generation, after, through, head: g.head_ledger, version },
        tick.signal,
      );
      const tokens = await this.fns.passTokens(this.ctx.ch, { generation: g.generation, after, through });
      if (tokens.length > 0) {
        await this.fns.recomputeTokens(
          this.ctx.ch,
          {
            generation: g.generation,
            tokens,
            atLedger: g.head_ledger,
            version,
            profile: this.tokens.profile,
            rematch: 'all',
          },
          tick.signal,
        );
      }
      if (this.ctx.closing()) return;
      await this.change(tick, seen, g, { account_cursor: through });
      this.ctx.logger.log(
        `tokens: generation ${g.generation}: the account pass is at ${through} (${accounts.length} account(s), ${tokens.length} token(s))`,
      );
    });
  }

  /**
   * Promotes the generation that builds once its pass is done and its `through_ledger` is at least the live one's (within
   * `TOKENS_PROMOTE_NEAR_HEAD` ledgers of the head when there is no live one): a row `live` for it, then a row `retired` for the
   * old one. Readers that take the highest live generation switch at the first row.
   */
  private async promoteIfReady(tick: AggregatorTick, seen: Seen, building: TokenGenerationsRow): Promise<boolean> {
    const live = liveGenerationOf(seen.gens);
    const ready =
      live !== undefined
        ? building.through_ledger >= live.through_ledger
        : building.through_ledger >= seen.head - TOKENS_PROMOTE_NEAR_HEAD;
    if (!ready) return false;
    await this.change(tick, seen, building, { state: 'live' });
    this.ctx.logger.log(
      `tokens: generation ${building.generation} is live (through ledger ${building.through_ledger})` +
        (live ? `, generation ${live.generation} is retired` : ''),
    );
    if (live !== undefined) await this.change(tick, seen, live, { state: 'retired' });
    return true;
  }

  /** Retires a live generation below the highest live one: a promotion whose second row did not get written. */
  private async retireSuperseded(tick: AggregatorTick, seen: Seen): Promise<void> {
    const live = liveGenerationOf(seen.gens);
    if (live === undefined) return;
    for (const g of [...seen.gens]) {
      if (g.state === 'live' && g.generation < live.generation) await this.change(tick, seen, g, { state: 'retired' });
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The drop (spec 3.3)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Drops the partitions of every generation retired more than `retiredKeepMs` ago. Once per generation and process: a restart
   * drops them again, which is harmless (a partition that is not there is nothing). A drop that fails is tried again at the next run.
   */
  private async drop(tick: AggregatorTick, seen: Seen): Promise<void> {
    for (const g of seen.gens) {
      if (g.state !== 'retired' || this.dropped.has(g.generation)) continue;
      if (this.ctx.clock() - Math.round(g.changed_at * 1000) <= this.retiredKeepMs) continue;
      if (!this.go(tick)) return;
      await this.fns.dropTokenGeneration(this.ctx.ch, g.generation);
      this.dropped.add(g.generation);
      this.ctx.logger.log(`tokens: the partitions of retired generation ${g.generation} are dropped`);
    }
  }
}
