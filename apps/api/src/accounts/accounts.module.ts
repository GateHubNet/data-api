import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';

/**
 * `GET /v2/accounts` and `GET /v2/accounts/:address`.
 *
 * The routes under an account (`/v2/accounts/:address/balances`, `/transactions`, ...) belong to this module too: each
 * is a controller of its own with `@RippleController('v2/accounts')` and a path that continues after `:address`, added
 * to `controllers` below. `:address` matches one segment only, so these never compete with the lookup.
 */
@Module({
  controllers: [AccountsController],
  providers: [AccountsService],
})
export class AccountsModule {}
