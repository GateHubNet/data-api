import { Module } from '@nestjs/common';
import { AccountTransactionsController } from './account-transactions.controller';
import { AccountTransactionsService } from './account-transactions.service';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';

/**
 * `GET /v2/accounts` and `GET /v2/accounts/:address`, and `GET /v2/accounts/:address/transactions[/:sequence]`.
 *
 * The routes under an account (`/v2/accounts/:address/balances`, `/transactions`, ...) belong to this module too: each
 * is a controller of its own with `@RippleController('v2/accounts')` and a path that continues after `:address`, added
 * to `controllers` below. `:address` matches one segment only, so these never compete with the lookup.
 */
@Module({
  controllers: [AccountsController, AccountTransactionsController],
  providers: [AccountsService, AccountTransactionsService],
})
export class AccountsModule {}
