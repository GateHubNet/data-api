import { SetMetadata } from '@nestjs/common';
import { Query } from './params';

/** Metadata key that `@ExportCount` sets on a list route: how the route counts the rows of an export up front. */
export const EXPORT_COUNT = 'ripple:export-count';

/**
 * How a list counts its rows, all its pages together, from the path parameters and the query an export names, as the
 * route would get them. `undefined` when it cannot tell up front (a form of the list it does not count). A 4xx it
 * throws (a parameter the list refuses) also counts as not known: the export then fails with the list's own answer.
 */
export type ExportCounter<C> = (
  controller: C,
  params: Record<string, string>,
  query: Query,
) => Promise<number | undefined>;

/**
 * Lets `POST /v2/exports` count the rows of an export of this list before it queues it (ticket #16), so that one above
 * the row cap of its format is refused at once with 400 instead of failing in the exporter. Put it next to `@Csv`; a
 * list without it is counted by the exporter only, as it walks the pages.
 */
export function ExportCount<C>(count: ExportCounter<C>): MethodDecorator {
  return SetMetadata(EXPORT_COUNT, count);
}
