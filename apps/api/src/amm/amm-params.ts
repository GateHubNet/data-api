import { AMM_LIQUIDITY_EVENTS } from '@gatehub/data-api-shared';
import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { badRequest } from '../common/errors';
import { first, ledgerDates, Query } from '../common/params';

// `ledgerDates` lives in `common/params` (the NFT routes read the same window); the AMM routes keep importing it from here
export { ledgerDates };

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

/** The params every list of the AMM routes has beside its own: the order, the page and the format. */
export const PagingQuery = (): MethodDecorator =>
  applyDecorators(
    ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' }),
    ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' }),
    ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' }),
    ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' }),
  ) as MethodDecorator;
