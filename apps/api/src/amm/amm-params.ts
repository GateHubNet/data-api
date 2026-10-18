import { AMM_LIQUIDITY_EVENTS } from '@gatehub/data-api-shared';
import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { badRequest } from '../common/errors';
import { dateParam, endExclusive, first, Query } from '../common/params';

/** The kinds of the governance list: the `type` filter is one of them. */
export const GOVERNANCE_TYPES = ['vote', 'bid'] as const;
export type GovernanceType = (typeof GOVERNANCE_TYPES)[number];

/**
 * `event`, the filter of the liquidity lists: one of the events the parser writes (`AMM_LIQUIDITY_EVENTS`: create, deposit,
 * withdraw, clawback, delete), spelt exactly so. Missing or empty is none; anything else answers 400 `invalid event`.
 */
export function eventParam(query: Query): string | undefined {
  const raw = first(query, 'event');
  if (raw === undefined || raw === '') return undefined;
  if (!(AMM_LIQUIDITY_EVENTS as readonly string[]).includes(raw)) throw badRequest('invalid event');
  return raw;
}

/** `type`, the filter of the governance list: `vote` or `bid`. Missing or empty is none; anything else answers 400 `invalid type`. */
export function typeParam(query: Query): GovernanceType | undefined {
  const raw = first(query, 'type');
  if (raw === undefined || raw === '') return undefined;
  if (!(GOVERNANCE_TYPES as readonly string[]).includes(raw)) throw badRequest('invalid type');
  return raw as GovernanceType;
}

/**
 * The dates of a list of events: `start` (inclusive) and `end` (the end of the period the text names), each missing when the
 * param is. 400 `invalid start date format` / `invalid end date format` for a text that is no date.
 */
export function ledgerDates(query: Query): { start?: Date; endExclusive?: Date } {
  const start = dateParam(query, 'start', 'invalid start date format');
  const end = dateParam(query, 'end', 'invalid end date format');
  return { ...(start && { start: start.date }), ...(end && { endExclusive: endExclusive(end) }) };
}

/** The params every list of the AMM routes has beside its own: the order, the page and the format. */
export const PagingQuery = (): MethodDecorator =>
  applyDecorators(
    ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' }),
    ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' }),
    ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' }),
    ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' }),
  ) as MethodDecorator;
