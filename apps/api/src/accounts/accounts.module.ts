import { Module } from '@nestjs/common';
import { AccountBalanceChangesController } from './account-balance-changes.controller';
import { AccountBalanceChangesService } from './account-balance-changes.service';
import { AccountBalancesController } from './account-balances.controller';
import { AccountBalancesService } from './account-balances.service';
import { AccountExchangesController } from './account-exchanges.controller';
import { AccountExchangesService } from './account-exchanges.service';
import { AccountOrdersController } from './account-orders.controller';
import { AccountOrdersService } from './account-orders.service';
import { AccountPaymentsController } from './account-payments.controller';
import { AccountPaymentsService } from './account-payments.service';
import { AccountTransactionsController } from './account-transactions.controller';
import { AccountTransactionsService } from './account-transactions.service';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { LiveLedgerService } from './live-ledger.service';

/**
 * `GET /v2/accounts` and `GET /v2/accounts/:address`, `GET /v2/accounts/:address/transactions[/:sequence]`,
 * `GET /v2/accounts/:address/{payments,exchanges[/:base[/:counter]],balance_changes}`, and the two routes that ask the
 * live node instead of the database, `GET /v2/accounts/:address/{balances,orders}`.
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
    AccountBalancesController,
    AccountOrdersController,
  ],
  providers: [
    AccountsService,
    AccountTransactionsService,
    AccountPaymentsService,
    AccountExchangesService,
    AccountBalanceChangesService,
    LiveLedgerService,
    AccountBalancesService,
    AccountOrdersService,
  ],
})
export class AccountsModule {}
