import { Module } from '@nestjs/common';
import { AccountBalanceChangesController } from './account-balance-changes.controller';
import { AccountBalanceChangesService } from './account-balance-changes.service';
import { AccountExchangesController } from './account-exchanges.controller';
import { AccountExchangesService } from './account-exchanges.service';
import { AccountPaymentsController } from './account-payments.controller';
import { AccountPaymentsService } from './account-payments.service';
import { AccountTransactionsController } from './account-transactions.controller';
import { AccountTransactionsService } from './account-transactions.service';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';

/**
 * `GET /v2/accounts` and `GET /v2/accounts/:address`, `GET /v2/accounts/:address/transactions[/:sequence]`, and
 * `GET /v2/accounts/:address/{payments,exchanges[/:base[/:counter]],balance_changes}`.
 *
 * The routes under an account (`/v2/accounts/:address/balances`, `/transactions`, ...) belong to this module too: each
 * is a controller of its own with `@RippleController('v2/accounts')` and a path that continues after `:address`, added
 * to `controllers` below. `:address` matches one segment only, so these never compete with the lookup.
 */
@Module({
  controllers: [
    AccountsController,
    AccountTransactionsController,
    AccountPaymentsController,
    AccountExchangesController,
    AccountBalanceChangesController,
  ],
  providers: [
    AccountsService,
    AccountTransactionsService,
    AccountPaymentsService,
    AccountExchangesService,
    AccountBalanceChangesService,
  ],
})
export class AccountsModule {}
