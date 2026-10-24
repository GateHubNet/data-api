import { HttpException, Injectable, OnModuleInit, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { CSV_ROUTE } from '../common/csv.interceptor';
import { EXPORT_COUNT, ExportCounter } from '../common/export-count';
import { Query } from '../common/params';

/** A list that can be exported: a GET route with a CSV form (`@Csv`). */
export interface ExportableRoute {
  /** The route as Nest registered it: `/v2/accounts/:address/transactions`. */
  pattern: string;
  /**
   * A list over time: its parameters include `start` and `end` (as its `@ApiQuery` documents them), so an export of it
   * has to name both. Any other list is one at a point in time (it may name a ledger) or has no window at all.
   */
  overTime: boolean;
  /**
   * A list over time that also takes a window of sequences: its parameters include `min_sequence` or `max_sequence`
   * (the account transactions by sequence). A path that names one of them has a window without `start` and `end`.
   */
  bySequence: boolean;
}

/** The parameters of a list by sequence: one of them, not empty, is a window. */
export const SEQUENCE_WINDOW = ['min_sequence', 'max_sequence'] as const;

/** One segment of a route pattern: a literal, or the name of a `:param`, which matches any one segment. */
type Segment = { literal: string } | { param: string };

/** How a route counts the rows of an export up front (`@ExportCount`), bound to its controller. */
type BoundCounter = (params: Record<string, string>, query: Query) => Promise<number | undefined>;

const segmentsOf = (path: string): string[] => path.split('/').filter((s) => s !== '');

/** The path patterns of a controller or a method (`@Controller(paths)`, `@Get(paths)`): a string or a list of them. */
function pathsOf(value: unknown): string[] {
  if (value === undefined) return [''];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

/** A query as a route gets it: a parameter given more than once is the list of its values. */
function queryOf(search: URLSearchParams): Query {
  const query: Query = {};
  for (const name of new Set(search.keys())) {
    const values = search.getAll(name);
    query[name] = values.length === 1 ? values[0] : values;
  }
  return query;
}

/**
 * The exportable lists of the app (ticket #15): every GET route that `@Csv` marks, found when the app starts. A route
 * that gets a CSV form later is exportable with no change here.
 */
@Injectable()
export class ExportableRoutes implements OnModuleInit {
  private routes: { route: ExportableRoute; segments: Segment[]; count?: BoundCounter }[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onModuleInit(): void {
    const found: { route: ExportableRoute; count?: BoundCounter }[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const type = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
      if (!type?.prototype) continue;
      const prefixes = pathsOf(Reflect.getMetadata(PATH_METADATA, type));
      for (const name of this.scanner.getAllMethodNames(type.prototype)) {
        const handler = (type.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function' || Reflect.getMetadata(CSV_ROUTE, handler) !== true) continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) !== RequestMethod.GET) continue;
        const params = (Reflect.getMetadata(DECORATORS.API_PARAMETERS, handler) ?? []) as {
          name?: string;
          in?: string;
        }[];
        const query = new Set(params.filter((p) => p.in === 'query').map((p) => p.name));
        const overTime = query.has('start') && query.has('end');
        const bySequence = SEQUENCE_WINDOW.some((name) => query.has(name));
        const counter = Reflect.getMetadata(EXPORT_COUNT, handler) as ExportCounter<unknown> | undefined;
        const instance: unknown = wrapper.instance;
        const count: BoundCounter | undefined = counter && ((params, q) => counter(instance, params, q));
        for (const prefix of prefixes) {
          for (const path of pathsOf(Reflect.getMetadata(PATH_METADATA, handler))) {
            const pattern = `/${[...segmentsOf(prefix), ...segmentsOf(path)].join('/')}`;
            found.push({ route: { pattern, overTime, bySequence }, ...(count && { count }) });
          }
        }
      }
    }
    this.routes = found.map(({ route, count }) => ({
      route,
      segments: segmentsOf(route.pattern).map((s) => (s.startsWith(':') ? { param: s.slice(1) } : { literal: s })),
      ...(count && { count }),
    }));
  }

  /** Every exportable list, by its pattern. */
  all(): ExportableRoute[] {
    return this.routes.map((r) => r.route);
  }

  /** The exportable list a path (`/v2/…`, without the query) names, or `undefined` when it names none. */
  match(pathname: string): ExportableRoute | undefined {
    return this.find(segmentsOf(pathname))?.route;
  }

  /**
   * The rows of the list at `url` (a path with its query), counted up front by the list (`@ExportCount`, ticket #16):
   * `undefined` when the path names no exportable list, when the list has no count, or when it cannot tell for this
   * query (a 4xx of the list's own checks included).
   */
  async count(url: URL): Promise<number | undefined> {
    const segments = segmentsOf(url.pathname);
    const found = this.find(segments);
    if (!found?.count) return undefined;
    try {
      const params: Record<string, string> = {};
      found.segments.forEach((s, i) => {
        if ('param' in s) params[s.param] = decodeURIComponent(segments[i]);
      });
      return await found.count(params, queryOf(url.searchParams));
    } catch (err) {
      // a path segment that is no URI component, or a parameter the list refuses: the list itself will say so
      if (err instanceof URIError || (err instanceof HttpException && err.getStatus() < 500)) return undefined;
      throw err;
    }
  }

  private find(segments: string[]): (typeof this.routes)[number] | undefined {
    return this.routes.find(
      (r) =>
        r.segments.length === segments.length && r.segments.every((s, i) => 'param' in s || s.literal === segments[i]),
    );
  }
}
