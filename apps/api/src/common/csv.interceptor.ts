import { CallHandler, ExecutionContext, NestInterceptor, UseInterceptors } from '@nestjs/common';
import { Request, Response } from 'express';
import { convert } from 'nice-json2csv';
import { map, Observable } from 'rxjs';
import { first } from './params';

type Json = Record<string, unknown>;

/**
 * `utils.flattenJSON` of the original: nested keys joined with a dot, array positions in brackets (`a.b`, `c[0].d`),
 * in the order they appear. Scalars (null too) are kept and an empty object stays `{}`, which the CSV writes as
 * `[Object]`. An empty array leaves nothing, as in the original, whose `l == 0` branch sat inside the loop over the
 * elements and so never ran. `undefined` is left out, as JSON leaves it out.
 */
export function flattenJSON(data: unknown): Json {
  // no prototype, so that a key such as `__proto__` in data is a key like any other
  const result: Json = Object.create(null);

  function recurse(cur: unknown, prop: string): void {
    if (Object(cur) !== cur) {
      if (cur !== undefined) result[prop] = cur;
    } else if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i++) recurse(cur[i], `${prop}[${i}]`);
    } else {
      let isEmpty = true;
      for (const p in cur as Json) {
        isEmpty = false;
        recurse((cur as Json)[p], prop ? `${prop}.${p}` : p);
      }
      if (isEmpty && prop) result[prop] = {};
    }
  }

  recurse(data, '');
  return result;
}

/** The name of the downloaded file, without `.csv`. A route that names it after the account or currency passes a function. */
export type CsvFilename = string | ((req: Request, body: Json) => string);

// What Node refuses in a header value (it would throw and fail the route); a file name is the one place a request can
// put such a character in.
const NOT_FOR_A_HEADER = /[^\t\x20-\x7e\x80-\xff]/g;

/**
 * Answers `format=csv` with the rows of the body as a CSV file, the way the routes of the original did with
 * `res.csv(rows, filename)` of nice-json2csv: `Content-Type: text/csv` (UTF-8), `Content-Disposition: attachment;
 * filename=<name>`, rows flattened, one column per key found in any row, in the order of first appearance, every cell a
 * quoted string. Any other `format` leaves the JSON body as it is. An error of the route is not touched.
 */
export class CsvInterceptor implements NestInterceptor {
  constructor(
    private readonly filename: CsvFilename,
    private readonly rowsKey: string,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    // the original lowercased the format, so CSV works too
    if (first(req.query, 'format')?.toLowerCase() !== 'csv') return next.handle();

    const res = http.getResponse<Response>();
    return next.handle().pipe(
      map((body: Json | null | undefined) => {
        const rows = body?.[this.rowsKey];
        const list = rows === undefined || rows === null ? [] : Array.isArray(rows) ? rows : [rows];
        const name = typeof this.filename === 'function' ? this.filename(req, body ?? {}) : this.filename;

        res.set('Content-Type', 'text/csv');
        res.set('Content-Disposition', `attachment; filename=${name.replace(NOT_FOR_A_HEADER, '_')}.csv`);
        return convert(list.map((row) => (typeof row === 'object' && row !== null ? flattenJSON(row) : row)));
      }),
    );
  }
}

/**
 * Lets a route answer `format=csv`: the array at `body[rowsKey]` becomes the CSV, downloaded as `<filename>.csv`.
 * Put it on the route next to `@RippleRoute`.
 */
export function Csv(filename: CsvFilename, rowsKey: string): MethodDecorator {
  return UseInterceptors(new CsvInterceptor(filename, rowsKey)) as MethodDecorator;
}
