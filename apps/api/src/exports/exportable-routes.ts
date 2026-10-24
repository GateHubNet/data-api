import { Injectable, OnModuleInit, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { CSV_ROUTE } from '../common/csv.interceptor';

/** A list that can be exported: a GET route with a CSV form (`@Csv`). */
export interface ExportableRoute {
  /** The route as Nest registered it: `/v2/accounts/:address/transactions`. */
  pattern: string;
  /**
   * A list over time: its parameters include `start` and `end` (as its `@ApiQuery` documents them), so an export of it
   * has to name both. Any other list is one at a point in time (it may name a ledger) or has no window at all.
   */
  overTime: boolean;
}

/** One segment of a route pattern: a literal, or `null` for a `:param`, which matches any one segment. */
type Segment = string | null;

const segmentsOf = (path: string): string[] => path.split('/').filter((s) => s !== '');

/** The path patterns of a controller or a method (`@Controller(paths)`, `@Get(paths)`): a string or a list of them. */
function pathsOf(value: unknown): string[] {
  if (value === undefined) return [''];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

/**
 * The exportable lists of the app (ticket #15): every GET route that `@Csv` marks, found when the app starts. A route
 * that gets a CSV form later is exportable with no change here.
 */
@Injectable()
export class ExportableRoutes implements OnModuleInit {
  private routes: { route: ExportableRoute; segments: Segment[] }[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onModuleInit(): void {
    const found: ExportableRoute[] = [];
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
        for (const prefix of prefixes) {
          for (const path of pathsOf(Reflect.getMetadata(PATH_METADATA, handler))) {
            found.push({ pattern: `/${[...segmentsOf(prefix), ...segmentsOf(path)].join('/')}`, overTime });
          }
        }
      }
    }
    this.routes = found.map((route) => ({
      route,
      segments: segmentsOf(route.pattern).map((s) => (s.startsWith(':') ? null : s)),
    }));
  }

  /** Every exportable list, by its pattern. */
  all(): ExportableRoute[] {
    return this.routes.map((r) => r.route);
  }

  /** The exportable list a path (`/v2/…`, without the query) names, or `undefined` when it names none. */
  match(pathname: string): ExportableRoute | undefined {
    const segments = segmentsOf(pathname);
    return this.routes.find(
      (r) => r.segments.length === segments.length && r.segments.every((s, i) => s === null || s === segments[i]),
    )?.route;
  }
}
