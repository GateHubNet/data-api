// nice-json2csv has no types. This is the part of it that the CSV interceptor uses.
declare module 'nice-json2csv' {
  /** `[{a: 1}, {b: 2}]` as `"a","b"\n"1",""\n"","2"`: the columns are the keys of all rows, every cell is a quoted string. */
  export function convert(data: unknown, headers?: string | string[], suppressHeader?: boolean): string;

  /** The Express middleware of the original server (`app.use(json2csv.expressDecorator)`), which adds `res.csv(data, fileName)`. */
  export function expressDecorator(req: unknown, res: unknown, next: () => void): void;
}
