import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { CsvFile, UnreadableCsv } from './csv-file';

/**
 * The file of a whole list, from its CSV pages: the same text the route gives for the list in one page. The pages here
 * are what nice-json2csv writes for these rows (`convert` in the api's CSV interceptor), each page alone and the whole
 * list at once.
 */
describe('CsvFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'csv-file-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fileOf = async (...pages: string[]) => {
    const file = new CsvFile(join(dir, 'rows'));
    for (const page of pages) await file.add(page);
    return { rows: file.rows, text: await text(file.stream()) };
  };

  it('is the pages one after the other, with one header, when they have the same columns', async () => {
    expect(await fileOf('"a","b"\n"1","2"\n"3","4"', '"a","b"\n"5","6"')).toEqual({
      rows: 3,
      text: '"a","b"\n"1","2"\n"3","4"\n"5","6"',
    });
  });

  it('has every column of every page, in the order they first appear, a missing cell empty', async () => {
    // rows [{a:1,c:2}], then [{a:3,b:4}], then [{c:5,d:"x\\"y"}]: in one page, nice-json2csv makes the columns a,c,b,d
    expect(await fileOf('"a","c"\n"1","2"', '"a","b"\n"3","4"', '"c","d"\n"5","x\\"y"')).toEqual({
      rows: 3,
      text: '"a","c","b","d"\n"1","2","",""\n"3","","4",""\n"","5","","x\\"y"',
    });
  });

  it('is an empty file for an empty list, and skips the empty pages of a list', async () => {
    expect(await fileOf('', '')).toEqual({ rows: 0, text: '' });
    expect(await fileOf('', '"a"\n"1"', '')).toEqual({ rows: 1, text: '"a"\n"1"' });
  });

  it('refuses a page it cannot read', async () => {
    const file = new CsvFile(join(dir, 'rows'));
    await expect(file.add('"a","b"\n"1"')).rejects.toBeInstanceOf(UnreadableCsv);
    await expect(file.add('<html>')).rejects.toBeInstanceOf(UnreadableCsv);
  });
});
