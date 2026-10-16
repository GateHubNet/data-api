import { NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { parseAssetPair } from '../common/asset-param';
import { Csv } from '../common/csv.interceptor';
import { anyFlag, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { ActiveAccount } from './active-account-object';
import { ActiveAccountsService } from './active-accounts.service';
import { ACTIVE_PERIODS, activeWindow, dateOf, periodOf } from './active-window';

interface ActiveAccountsBody {
  result: 'success';
  count: number;
  exchanges_count: number;
  accounts: ActiveAccount[];
}

/**
 * `GET /v2/active_accounts/:base/:counter` (`api/routes/activeAccounts.js`): the accounts that traded a pair in a period,
 * each with what it bought and sold, the largest base volume first. The checks come in the order of the original: the
 * pair, `period`, `date`.
 */
@RippleController('v2/active_accounts')
export class ActiveAccountsController {
  constructor(
    private readonly accounts: ActiveAccountsService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get(':base/:counter')
  @RippleRoute('unable to retrieve exchanges')
  @Csv('active_accounts', 'accounts')
  @ApiOperation({
    summary: 'Get the active accounts of a pair',
    description:
      'The accounts that took part in an exchange of the pair in the window, with what each bought (`buy`) and sold ' +
      '(`sell`) in volume and count and the totals, sorted by base volume, the largest first. An account is in the ' +
      'list of the seller and of the buyer of every exchange (one that trades with itself counts on both sides). With ' +
      '`date` the window runs from it to `period` after it, and to the end of the day, hour, ... the date names; ' +
      'without, it is the `period` before now. A pair asked for in the reverse order of the stored one is inverted: ' +
      'base and counter, buy and sell swap. `include_exchanges` adds the exchanges of each account. `format=csv` gives ' +
      'the accounts as a CSV file.',
  })
  @ApiParam({
    name: 'base',
    description: 'A currency and its issuer, `USD+rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B`, or the native currency alone.',
  })
  @ApiParam({ name: 'counter', description: 'The other side of the pair, written like `base`.' })
  @ApiQuery({ name: 'period', required: false, enum: ACTIVE_PERIODS, description: 'Default: 1day.' })
  @ApiQuery({
    name: 'date',
    required: false,
    description: 'The start of the window. Default: the window ends now.',
  })
  @ApiQuery({
    name: 'include_exchanges',
    required: false,
    description: 'Any text that is not empty: add the exchanges of each account.',
  })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async activeAccounts(
    @Param('base') baseRaw: string,
    @Param('counter') counterRaw: string,
    @Query() query: QueryParams,
  ): Promise<ActiveAccountsBody> {
    const { base, counter } = parseAssetPair(baseRaw, counterRaw, this.profile.nativeCurrency);
    const period = periodOf(query);
    const date = dateOf(query);
    const { accounts, exchanges } = await this.accounts.accounts({
      base,
      counter,
      ...activeWindow(period, date, Date.now()),
      includeExchanges: anyFlag(query, 'include_exchanges'),
    });
    return { result: 'success', count: accounts.length, exchanges_count: exchanges, accounts };
  }
}
