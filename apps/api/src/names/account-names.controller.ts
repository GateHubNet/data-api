import { Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery } from '@nestjs/swagger';
import { isValidClassicAddress } from 'ripple-address-codec';
import { badRequest } from '../common/errors';
import { first, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { accountNameObject } from './account-names-object';
import { DisplayNamesService } from './display-names.service';

/** The most addresses one call names. */
export const MAX_ADDRESSES = 100;

/**
 * The addresses of `addresses`, in the order asked (spec 5.2): a comma list, no spaces and no trimming, each a classic address
 * (an X-address is not one). A repeated address is answered at each place and counts towards the 100. The first parameter wins
 * when it is repeated. Throws 400 in this order: `addresses is required` (missing or empty), `too many addresses - at most 100`
 * (101 or more elements, valid or not), `invalid ripple address` (an empty element, an X-address, a bad checksum, anything else).
 */
export function parseAddresses(query: QueryParams): string[] {
  const raw = first(query, 'addresses');
  if (raw === undefined || raw === '') throw badRequest('addresses is required');
  const addresses = raw.split(',');
  if (addresses.length > MAX_ADDRESSES) throw badRequest(`too many addresses - at most ${MAX_ADDRESSES}`);
  if (!addresses.every((address) => isValidClassicAddress(address))) throw badRequest('invalid ripple address');
  return addresses;
}

/** The body of `GET /v2/account_names`: one entry per address asked. */
export interface AccountNamesBody {
  result: 'success';
  count: number;
  account_names: Record<string, unknown>[];
}

/**
 * `GET /v2/account_names` (spec 5.2, GateHub extra): the display names of up to 100 addresses in one call, for a page of the
 * explorer, with the domain and the labels. The default `Cache-Control` (`private, max-age=60`) is the app's; errors are `no-store`.
 */
@RippleController('v2/account_names')
export class AccountNamesController {
  constructor(private readonly displayNames: DisplayNamesService) {}

  @Get()
  @RippleRoute('unable to retrieve account names')
  @ApiOperation({
    summary: 'Get the display names of up to 100 addresses',
    description:
      'One entry per address asked, in the order asked (an address asked twice is answered at each place). `display_name` is the ' +
      'name to show and what stands behind it: `verified` (the toml of the account domain lists the address; the text is its ' +
      'description, else the domain), `account` (the name the operator gave the address) or `domain` (the account domain, which ' +
      'nothing vouches for). `domain` is the account domain whatever its state; `account_name`, `account_network_name` and ' +
      '`labels` are served whenever they exist. Any address is answered: one that is no account on this network still has its ' +
      'name and labels and no domain. A key without a value is left out.',
  })
  @ApiQuery({
    name: 'addresses',
    required: true,
    description:
      '1 to 100 classic addresses separated by `,` (no spaces). A repeated address is answered at each place and counts ' +
      'towards the 100. Case matters.',
  })
  async list(@Query() query: QueryParams): Promise<AccountNamesBody> {
    const addresses = parseAddresses(query);
    const names = await this.displayNames.of(addresses);
    return { result: 'success', count: names.length, account_names: names.map(accountNameObject) };
  }
}
