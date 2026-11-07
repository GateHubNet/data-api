// the library itself, not its index: the index reads a sample file of its own when it thinks it runs as a script
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse/lib/pdf-parse.js') as typeof import('pdf-parse');

/** What a reader of a PDF gets out of it: its pages and its text, one line per line of text on the pages. */
export interface PdfText {
  pages: number;
  text: string;
}

/**
 * The text of a PDF file, as a text extractor reads it.
 *
 * The pdf.js 1.10 inside pdf-parse 1.1.1 misreads some Node Buffers ("bad XRef entry"); since Node 26, whose buffer pool
 * grew from 8 to 64 KB, the export files of the tests are among them. A plain Uint8Array copy reads right on every Node.
 */
export async function pdfText(file: Buffer): Promise<PdfText> {
  const { numpages, text } = await pdfParse(new Uint8Array(file) as Buffer);
  return { pages: numpages, text };
}

/** `text` without any white space: a value that a table cell wraps over two lines is whole again. */
export const unwrapped = (text: string): string => text.replace(/\s+/g, '');
