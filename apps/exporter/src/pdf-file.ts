import { Readable } from 'node:stream';
import PDFDocument from 'pdfkit';
import { CsvFile } from './csv-file';
import { pdfColumnsOf } from './pdf-columns';

/** What the header of a PDF says of the account whose list it is: `account_data` of `/v2/accounts/{address}`. */
export interface PdfAccount {
  address: string;
  account_name?: string;
  account_network_name?: string;
  account_labels?: Record<string, { description: string; source?: string; url?: string }>;
}

/** What a PDF export is made from. */
export interface PdfInput {
  /** The list as the client named it: `/v2/…?…`. */
  path: string;
  /** The walked list. */
  file: CsvFile;
  /** The title: the name of the list's own download without `.csv` (`r… - transactions`), else the path. */
  title: string;
  /** The network (`xrpl`, `xahau`). */
  network: string;
  /** The ledger the exporter walked a list at a ledger at, when its path named none. */
  ledger?: number;
  /** The account of an account's list, with its names and labels; `undefined` for any other list. */
  account?: PdfAccount;
  /** When the export was made. */
  made: Date;
}

/** How the header names a network. */
const NETWORK_NAMES: Record<string, string> = { xrpl: 'XRP Ledger', xahau: 'Xahau' };

const MARGIN = 28;
const HEADER_SIZE = 9;
const TITLE_SIZE = 14;
const CELL_SIZE = 6;
const CELL_PAD = 2;

/**
 * The standard PDF fonts write WinAnsi (Latin-1, more or less) only: any other character, which a name or a currency
 * could hold, is written `?` rather than as a wrong glyph.
 */
const printable = (text: string): string => text.replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

/** The cells of one line of the exporter's CSV (`CsvFile`): every cell a JSON string. */
const cellsOf = (line: string): string[] => JSON.parse(`[${line.replace(/^\n/, '')}]`) as string[];

/**
 * The `Window:` (or `At:`) line of the header: the window or the ledger the path names, or else the ledger the exporter
 * walked the list at (`ledger`).
 */
function windowOf(query: URLSearchParams, ledger: number | undefined): string {
  const start = query.get('start');
  const end = query.get('end');
  if (start || end) {
    const order = query.get('descending') === 'true' ? ', newest first' : '';
    return `Window: ${start || 'the beginning'} to ${end || 'the newest ledger'}${order}`;
  }
  const hash = query.get('ledger_hash');
  const date = query.get('date') ?? query.get('close_time');
  const index = query.get('ledger_index') ?? query.get('ledger');
  if (hash) return `At: ledger ${hash}`;
  if (date) return `At: the last ledger closed at or before ${date}`;
  if (index && /^\d+$/.test(index)) return `At: ledger ${index}`;
  if (ledger !== undefined) return `At: ledger ${ledger}, the newest indexed when the export was made`;
  if (index) return `At: ledger ${index}`;
  return 'At: the time the export was made';
}

/** The lines of the header that name the account: its address, account name, account network name and labels. */
function accountLines(account: PdfAccount): string[] {
  const lines = [`Address: ${account.address}`];
  if (account.account_name) lines.push(`Account name: ${account.account_name}`);
  if (account.account_network_name) lines.push(`Account network name: ${account.account_network_name}`);
  for (const [label, { description, source, url }] of Object.entries(account.account_labels ?? {})) {
    const where = [source, url].filter((s) => s);
    lines.push(`Label ${label}: ${description}${where.length > 0 ? ` (${where.join(', ')})` : ''}`);
  }
  return lines;
}

/** The ISO time of `date` to the second: `2026-10-24T12:00:00Z`. */
const isoSecond = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;

/**
 * The PDF of an export (ticket #17), rendered with `pdfkit`: landscape A4, a header that says what the document is
 * (the list, the account with its account name, account network name and labels for an account's list, the network, the
 * window, the ledger range of its rows, the row count, when it was made), then a table of the list's chosen columns
 * (`PDF_COLUMNS`), its column titles on every page, and `Page n of m` at the foot of every page.
 *
 * The rows are read twice from the walked list: once for the ledger range of the header, once for the table. The pages
 * are kept until the last one, for the page count; the row cap of a PDF bounds them.
 */
export async function renderPdf(input: PdfInput): Promise<Readable> {
  const url = new URL(input.path, 'http://export.invalid');

  // the first read: the columns, and the ledgers the rows cover
  let header: string[] = [];
  let ledgerAt = -1;
  let low = Infinity;
  let high = -Infinity;
  for await (const line of input.file.stream()) {
    const cells = cellsOf(line as string);
    if (header.length === 0) {
      header = cells;
      ledgerAt = header.indexOf('ledger_index');
      continue;
    }
    const ledger = ledgerAt >= 0 ? Number(cells[ledgerAt]) : NaN;
    if (ledgerAt >= 0 && cells[ledgerAt] !== '' && Number.isFinite(ledger)) {
      low = Math.min(low, ledger);
      high = Math.max(high, ledger);
    }
  }
  const ledgers =
    low <= high
      ? `Ledgers: ${low} to ${high}`
      : input.file.rows === 0
        ? 'Ledgers: none (no rows)'
        : 'Ledgers: not given by the list';

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: MARGIN,
    bufferPages: true,
    info: { Title: printable(input.title), Creator: 'GateHub Data API', CreationDate: input.made },
  });
  const left = MARGIN;
  const width = doc.page.width - 2 * MARGIN;
  const bottom = () => doc.page.height - MARGIN - 14; // room for the page number

  // the header
  doc.font('Helvetica-Bold').fontSize(TITLE_SIZE).text(printable(input.title), left, MARGIN, { width });
  doc.moveDown(0.3).font('Helvetica').fontSize(HEADER_SIZE);
  const lines = [
    ...(input.account ? accountLines(input.account) : []),
    `Network: ${NETWORK_NAMES[input.network] ?? input.network}`,
    `List: ${input.path}`,
    windowOf(url.searchParams, input.ledger),
    ledgers,
    `Rows: ${input.file.rows}`,
    `Made: ${isoSecond(input.made)}`,
  ];
  for (const line of lines) doc.text(printable(line), left, undefined, { width });
  doc.moveDown(0.8);

  // the table
  const columns = pdfColumnsOf(url.pathname, header);
  const total = columns.reduce((sum, c) => sum + c.width, 0);
  const widths = columns.map((c) => (c.width / total) * width);
  const xs = widths.map((_, i) => left + widths.slice(0, i).reduce((sum, w) => sum + w, 0));
  const at = columns.map((c) => header.indexOf(c.name));

  const heightOf = (texts: string[]) =>
    Math.max(...texts.map((text, i) => doc.heightOfString(text || ' ', { width: widths[i] - 2 * CELL_PAD })));
  const drawRow = (texts: string[], y: number, h: number) => {
    texts.forEach((text, i) => {
      if (text !== '') doc.text(text, xs[i] + CELL_PAD, y + CELL_PAD, { width: widths[i] - 2 * CELL_PAD });
    });
    doc
      .moveTo(left, y + h + 2 * CELL_PAD)
      .lineTo(left + width, y + h + 2 * CELL_PAD)
      .lineWidth(0.3)
      .strokeColor('#bbbbbb')
      .stroke();
  };
  const titles = columns.map((c) => printable(c.name.replace(/_/g, ' ')));
  const drawTitles = (y: number): number => {
    doc.font('Helvetica-Bold').fontSize(CELL_SIZE);
    const h = heightOf(titles);
    drawRow(titles, y, h);
    doc.font('Helvetica');
    return y + h + 2 * CELL_PAD;
  };

  let y = columns.length === 0 ? doc.y : drawTitles(doc.y);
  let first = true;
  for await (const line of input.file.stream()) {
    if (first) {
      first = false; // the CSV's header
      continue;
    }
    const cells = cellsOf(line as string);
    const texts = at.map((i) => (i < 0 ? '' : printable(cells[i] ?? '')));
    const h = heightOf(texts);
    if (y + h + 2 * CELL_PAD > bottom()) {
      doc.addPage();
      y = drawTitles(MARGIN);
    }
    drawRow(texts, y, h);
    y += h + 2 * CELL_PAD;
  }
  if (input.file.rows === 0) {
    doc
      .font('Helvetica')
      .fontSize(HEADER_SIZE)
      .text('The list has no rows.', left, y + CELL_PAD, { width });
  }

  // the page numbers, now that the page count is known
  const { start, count } = doc.bufferedPageRange();
  for (let page = start; page < start + count; page++) {
    doc.switchToPage(page);
    // text below the bottom margin would start a new page
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(CELL_SIZE + 1)
      .fillColor('black')
      .text(`Page ${page - start + 1} of ${count}`, left, doc.page.height - MARGIN, { width, align: 'center' });
  }
  doc.end();
  return doc;
}
