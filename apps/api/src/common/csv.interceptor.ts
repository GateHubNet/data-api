import {
  applyDecorators,
  CallHandler,
  ExecutionContext,
  NestInterceptor,
  SetMetadata,
  UseInterceptors,
} from '@nestjs/common';
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

/** Whether the request asks for the CSV form: `format=csv`, in any case (the original lowercased the format). */
export function wantsCsv(query: Record<string, unknown>): boolean {
  return first(query, 'format')?.toLowerCase() === 'csv';
}

/** The name of the downloaded file, without `.csv`. A route that names it after the account or currency passes a function. */
export type CsvFilename = string | ((req: Request, body: Json) => string);

// Control characters: no file name needs one, and Node refuses some of them in a header value (it would throw and fail
// the route). A file name is the one place a request can put such a character in.
const CONTROL = /[\x00-\x1f\x7f]/g;
// A lone surrogate is no character at all, and `encodeURIComponent` throws on it.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// What the quoted `filename` cannot carry: anything but printable ASCII.
const NOT_ASCII = /[^\x20-\x7e]/g;

/**
 * `Content-Disposition` of a CSV download (RFC 6266), for the name the original gave the file (`<name>.csv`): a quoted
 * `filename` (printable ASCII, `"` and `\` escaped, anything else `_`) for old clients, and `filename*` with the name
 * itself in UTF-8 (RFC 5987 percent-encoding), which clients prefer. The original wrote the name unquoted
 * (`filename=payments - USD rIssuer.csv`), so a name with a `;`, a quote or a space from the request (a currency, an
 * address, a query value) broke the header (M12); the name a client shows is still the original's.
 */
export function csvContentDisposition(name: string): string {
  const file = `${name}.csv`.replace(CONTROL, '_').replace(LONE_SURROGATE, '_');
  const ascii = file.replace(NOT_ASCII, '_').replace(/["\\]/g, '\\$&');
  const utf8 = encodeURIComponent(file).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * Answers `format=csv` with the rows of the body as a CSV file, the way the routes of the original did with
 * `res.csv(rows, filename)` of nice-json2csv: `Content-Type: text/csv` (UTF-8), `Content-Disposition: attachment` with
 * the original's file name (quoted, and in UTF-8 too: `csvContentDisposition`), rows flattened, one column per key
 * found in any row, in the order of first appearance, every cell a quoted string. Any other `format` leaves the JSON body as it is. An error of the route is not touched.
 */
export class CsvInterceptor implements NestInterceptor {
  constructor(
    private readonly filename: CsvFilename,
    private readonly rowsKey: string,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    if (!wantsCsv(req.query)) return next.handle();

    const res = http.getResponse<Response>();
    return next.handle().pipe(
      map((body: Json | null | undefined) => {
        const rows = body?.[this.rowsKey];
        const list = rows === undefined || rows === null ? [] : Array.isArray(rows) ? rows : [rows];
        const name = typeof this.filename === 'function' ? this.filename(req, body ?? {}) : this.filename;

        res.set('Content-Type', 'text/csv');
        res.set('Content-Disposition', csvContentDisposition(name));
        return convert(list.map((row) => (typeof row === 'object' && row !== null ? flattenJSON(row) : row)));
      }),
    );
  }
}

/**
 * Metadata key that `@Csv` sets (to `true`) on its route: a route with a CSV form is a list that can be exported
 * (`POST /v2/exports`, ticket #15), with nothing else to declare.
 */
export const CSV_ROUTE = 'ripple:csv-route';

/**
 * Lets a route answer `format=csv`: the array at `body[rowsKey]` becomes the CSV, downloaded as `<filename>.csv`.
 * Put it on the route next to `@RippleRoute`. It also makes the list exportable (`CSV_ROUTE`).
 */
export function Csv(filename: CsvFilename, rowsKey: string): MethodDecorator {
  return applyDecorators(
    SetMetadata(CSV_ROUTE, true),
    UseInterceptors(new CsvInterceptor(filename, rowsKey)),
  ) as MethodDecorator;
}
