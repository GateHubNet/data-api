import { createReadStream } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

/** A page whose CSV the exporter cannot read: the job fails with this message. */
export class UnreadableCsv extends Error {
  constructor() {
    super("the list's CSV could not be read");
  }
}

/** The cells of one line of the api's CSV: `"a","b",…`, every cell a JSON string (how nice-json2csv writes them). */
function cellsOf(line: string): string[] {
  let cells: unknown;
  try {
    cells = JSON.parse(`[${line}]`);
  } catch {
    throw new UnreadableCsv();
  }
  if (!Array.isArray(cells) || !cells.every((c) => typeof c === 'string')) throw new UnreadableCsv();
  return cells as string[];
}

const lineOf = (cells: string[]): string => cells.map((c) => JSON.stringify(c)).join(',');

/**
 * The CSV file of a whole list, put together from the CSV pages of the list as the api serves them, so that it is the
 * file the route would give for the whole list in one page: the columns are the keys of every row, in the order they
 * first appear, a missing cell is empty, and lines are separated by `\n` with none at the end. An empty list is an
 * empty file.
 *
 * Pages may have different columns (a page has the keys of its own rows), and the header comes first, so the rows wait
 * in a spool file (`spoolPath`) until the last page is in; the file is then streamed, each row in the final columns.
 */
export class CsvFile {
  private readonly columns: string[] = [];
  private readonly known = new Set<string>();
  private readonly pages: { header: string[]; rows: number }[] = [];
  private count = 0;

  constructor(private readonly spoolPath: string) {}

  /** The data rows so far. */
  get rows(): number {
    return this.count;
  }

  /** Adds a page: the text of a CSV answer of the route (an empty text is an empty page). */
  async add(text: string): Promise<void> {
    if (text === '') return;
    const lines = text.split('\n');
    const header = cellsOf(lines[0]);
    for (const column of header) {
      if (!this.known.has(column)) {
        this.known.add(column);
        this.columns.push(column);
      }
    }
    const rows = lines.slice(1);
    // every row has a cell for every column of its page: anything else is a page this class would get wrong
    for (const row of rows) if (cellsOf(row).length !== header.length) throw new UnreadableCsv();
    if (rows.length === 0) return;
    await appendFile(this.spoolPath, `${rows.join('\n')}\n`);
    this.pages.push({ header, rows: rows.length });
    this.count += rows.length;
  }

  /**
   * The file: the header and every row, in the columns of the whole list. Read it after the last page; each call reads
   * the spool file anew, so the file can be read more than once (the PDF reads it twice).
   */
  stream(): Readable {
    return Readable.from(this.lines());
  }

  private async *lines(): AsyncGenerator<string> {
    if (this.count === 0) return;
    yield lineOf(this.columns);
    const reader = createInterface({ input: createReadStream(this.spoolPath, 'utf8'), crlfDelay: Infinity });
    let page = 0;
    let left = this.pages[0].rows;
    let remap = this.remapFor(this.pages[0].header);
    for await (const line of reader) {
      while (left === 0) {
        page++;
        left = this.pages[page].rows;
        remap = this.remapFor(this.pages[page].header);
      }
      left--;
      yield `\n${remap ? lineOf(remap(cellsOf(line))) : line}`;
    }
  }

  /** How a row of a page with `header` becomes a row of the file; `undefined` when it already is one. */
  private remapFor(header: string[]): ((cells: string[]) => string[]) | undefined {
    if (header.length === this.columns.length && header.every((c, i) => c === this.columns[i])) return undefined;
    const at = new Map(header.map((c, i) => [c, i]));
    return (cells) => this.columns.map((c) => (at.has(c) ? (cells[at.get(c)!] ?? '') : ''));
  }
}
