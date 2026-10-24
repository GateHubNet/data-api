import { inflateSync } from 'node:zlib';

// the library itself, not its index: the index reads a sample file of its own when it thinks it runs as a script
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse/lib/pdf-parse.js') as typeof import('pdf-parse');

/** What a reader of a PDF gets out of it: its pages and its text, one line per line of text on the pages. */
export interface PdfText {
  pages: number;
  text: string;
}

/** The text of a PDF file, as a text extractor reads it. */
export async function pdfText(file: Buffer): Promise<PdfText> {
  const { numpages, text } = await pdfParse(file);
  return { pages: numpages, text };
}

/**
 * The text a PDF the exporter made (pdfkit) draws, one entry per text operation (`[<hex> kerning <hex> …] TJ`, a line
 * of the header or a cell), read straight from its compressed content streams.
 *
 * For the header of a document in suites where pdf.js, inside pdf-parse, turned out to refuse some of the exporter's
 * documents now and then (`bad XRef entry`, `Illegal character`) after it had read others in the same process, while it
 * read the same bytes in a process of their own.
 */
export function pdfLines(file: Buffer): string[] {
  const pdf = file.toString('latin1');
  const lines: string[] = [];
  for (const match of pdf.matchAll(/\/FlateDecode\s*>>\s*stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = pdf.indexOf('endstream', start);
    const content = inflateSync(file.subarray(start, end)).toString('latin1');
    for (const [, parts] of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      const text = [...parts.matchAll(/<([0-9a-fA-F]*)>/g)]
        .map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1'))
        .join('');
      lines.push(text);
    }
  }
  return lines;
}

/** `text` without any white space: a value that a table cell wraps over two lines is whole again. */
export const unwrapped = (text: string): string => text.replace(/\s+/g, '');
