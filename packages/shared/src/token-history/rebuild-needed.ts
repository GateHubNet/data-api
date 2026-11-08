import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { TokenHistoryStateRow } from '../clickhouse/rows';
import { TOKEN_HISTORY_CONFIG_VERSION } from './constants';
import { tokenHistoryCoverageFrom } from './coverage-start';
import { holdsOlderParser, oldestDirtyRange } from './repair';
import { buildingTokenHistory, liveTokenHistory } from './state';

/** Why a build is due (spec 4.6), or `none`: there is no generation yet. */
export type RebuildReason = 'none' | 'coverage' | 'config' | 'repair';

/**
 * Whether a build is due, and why (spec 4.6): `none` with no generation at all; `config` when the live generation's config is not
 * `TOKEN_HISTORY_CONFIG_VERSION`; `coverage` when the start of the head's unbroken run is below its `coverage_from` (a fill has joined
 * the run); `repair` when the oldest range to repair holds a ledger of an older parser. `undefined` when none is due, and while a
 * building generation exists (a build runs, or waits for its promotion).
 */
export async function rebuildNeeded(
  ch: ClickHouseService,
  gens: readonly TokenHistoryStateRow[],
  head: number,
  o: { hasMpt?: boolean } = {},
): Promise<RebuildReason | undefined> {
  if (buildingTokenHistory(gens) !== undefined) return undefined;
  const live = liveTokenHistory(gens);
  if (live === undefined) return 'none';
  if (live.config_version !== TOKEN_HISTORY_CONFIG_VERSION) return 'config';
  const coverage = await tokenHistoryCoverageFrom(ch, head);
  if (coverage !== undefined && coverage < live.coverage_from) return 'coverage';
  const range = await oldestDirtyRange(ch);
  if (range !== undefined) {
    const from = Math.max(range.from, live.coverage_from);
    const to = Math.min(range.to, live.through_ledger);
    if (from <= to && (await holdsOlderParser(ch, from, to, o.hasMpt ?? true))) return 'repair';
  }
  return undefined;
}
