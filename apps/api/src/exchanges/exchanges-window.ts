import { AmmFilter, ammFilter, bool, dateParam, endExclusive, first, limitParam, Query } from '../common/params';
import { ExchangesWindow } from './exchanges.service';

/**
 * What the lists of exchanges read after the pair: `start` (2013-01-01 when missing or empty), `end`, `limit` (200, at most
 * 400; a text that is not a number answers `invalid limit: NaN`, as the original did), then `amm` (400 `invalid amm filter -
 * use: include, exclude, only`), `autobridged`, `descending` and the `marker`, which the service checks. Shared by the
 * exchange routes and the swaps of a pool, which are the same list with the pool's account.
 *
 * `amm` is read by the function it is given after `limit`, to keep the order of the checks: the exchange routes read the
 * param (`ammFilter`), the swaps of a pool ignore it (they are always the swaps).
 */
export function exchangesWindow(
  query: Query,
  amm: (query: Query) => AmmFilter = ammFilter,
): ExchangesWindow & { start: Date } {
  const start = dateParam(query, 'start', 'invalid start date format', '2013-01-01');
  const end = dateParam(query, 'end', 'invalid end date format');
  const limit = limitParam(query, { def: 200, max: 400, nanError: 'invalid limit: NaN' });
  const filter = amm(query);
  return {
    start: start.date,
    ...(end && { endExclusive: endExclusive(end) }),
    autobridged: bool(query, 'autobridged'),
    amm: filter,
    descending: bool(query, 'descending'),
    limit,
    marker: first(query, 'marker'),
  };
}
