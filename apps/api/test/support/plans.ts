import type { Harness } from '../harness';

/** The text of `EXPLAIN <kind> <sql>` with the statement's own params. */
export async function explain(h: Harness, kind: string, sql: string, params: Record<string, unknown>): Promise<string> {
  return (await h.ch.query<{ explain: string }>(`EXPLAIN ${kind} ${sql}`, params)).map((r) => r.explain).join('\n');
}

/** Whether a statement is a page read of `readDistinctPage` (shared `distinct-page.ts`). */
export const isPageRead = (sql: string): boolean => sql.includes('{distinct_page_cap:UInt32}');

/**
 * The read of the table in a `readDistinctPage` statement: the inner SELECT, with its plain `LIMIT {distinct_page_cap}`.
 * Its pipeline is the read itself (the outer SELECT sorts and dedupes the few rows it took).
 */
export function innerRead(sql: string): string {
  const inner = /FROM \((SELECT (?:(?!FROM \()[\s\S])*?LIMIT \{distinct_page_cap:UInt32\})\)/.exec(sql)?.[1];
  if (inner === undefined) throw new Error(`not a page read of readDistinctPage: ${sql}`);
  return inner;
}

/** What the plan says about one read of a MergeTree table (one `ReadFromMergeTree` step). */
export interface TableRead {
  /** `Read type`: `InOrder` / `InReverseOrder` when the table is read in the order of its key, `Default` when not. */
  readType: string;
  /**
   * The step right above the read is a sort by a prefix of the sorting key (`Prefix sort description`): the rows come in
   * the key order and are merged, not sorted.
   */
  prefixSorted: boolean;
  /**
   * The `Limit` of that sort: ClickHouse stops reading after that many rows. The old page reads (`LIMIT 1 BY` in the same
   * SELECT as the read) had none there, and read most of a range that spans more than one part (Ruling R106).
   */
  limit?: number;
}

/** Every read of a MergeTree table in the plan of a statement (`EXPLAIN actions = 1`), in plan order. */
export async function tableReads(h: Harness, sql: string, params: Record<string, unknown>): Promise<TableRead[]> {
  const lines = (await explain(h, 'actions = 1', sql, params)).split('\n');
  const isStep = (line: string): boolean => /(└──|├──)/.test(line) || /^[A-Za-z]/.test(line);
  const reads: TableRead[] = [];
  lines.forEach((line, i) => {
    // a read of the table (not the `LazilyReadFromMergeTree` of the columns a top-N reads for its rows only)
    if (!/(^|──)ReadFromMergeTree \(/.test(line)) return;
    let readType = '';
    for (let j = i + 1; j < lines.length && !isStep(lines[j]); j++) {
      const m = /Read type: (\w+)/.exec(lines[j]);
      if (m) readType = m[1];
    }
    // the attributes of the step above, up to its own line; a Filter or an Expression in between (a WHERE ClickHouse
    // did not push into the read) passes the rows on in their order, so the step above it counts
    let attributes: string[] = [];
    let j = i;
    let parent = '';
    for (;;) {
      attributes = [];
      for (j -= 1; j >= 0 && !isStep(lines[j]); j--) attributes.push(lines[j]);
      parent = j >= 0 ? lines[j] : '';
      if (!/──(Filter|Expression) \(/.test(parent)) break;
    }
    const sorted = parent.includes('Sorting (Sorting for ORDER BY)');
    const limit = sorted
      ? attributes.map((a) => /│\s+Limit (\d+)$/.exec(a)?.[1]).find((v) => v !== undefined)
      : undefined;
    reads.push({
      readType,
      prefixSorted: sorted && attributes.some((a) => a.includes('Prefix sort description')),
      ...(limit !== undefined && { limit: Number(limit) }),
    });
  });
  return reads;
}

/**
 * Asserts that a page read reads its table in the order of the key (no sort of the range) and stops after its rows:
 * the inner read's pipeline reads in order with no partial sort, and the plan of the whole statement has a `Limit` on
 * the merge of the sorted parts. `label` goes into the failure.
 */
export async function expectBoundedInOrderRead(
  h: Harness,
  sql: string,
  params: Record<string, unknown>,
  descending: boolean,
  label: unknown = '',
): Promise<void> {
  const pipeline = await explain(h, 'PIPELINE', innerRead(sql), params);
  if (!pipeline.includes('ReadPoolInOrder')) throw new Error(`${String(label)}: not read in order\n${pipeline}`);
  if (!pipeline.includes(descending ? 'InReverseOrder' : 'algorithm: InOrder')) {
    throw new Error(`${String(label)}: not read in the ${descending ? 'reverse ' : ''}order of the key\n${pipeline}`);
  }
  if (pipeline.includes('PartialSortingTransform')) throw new Error(`${String(label)}: sorts the range\n${pipeline}`);
  const reads = await tableReads(h, sql, params);
  const expected = {
    readType: descending ? 'InReverseOrder' : 'InOrder',
    prefixSorted: true,
    limit: params.distinct_page_cap,
  };
  if (reads.length !== 1 || JSON.stringify(reads[0]) !== JSON.stringify(expected)) {
    throw new Error(
      `${String(label)}: the read is not bounded: ${JSON.stringify(reads)}, expected ${JSON.stringify(expected)}`,
    );
  }
}
