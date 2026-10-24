import { Module } from '@nestjs/common';
import { RatesModule } from '../exchanges/rates.module';
import { PathPaymentsModule } from '../path-payments/path-payments.module';
import { AccountAmmController } from './account-amm.controller';
import { AccountAmmService } from './account-amm.service';
import { AccountAnalyticsController } from './account-analytics.controller';
import { AccountAnalyticsService } from './account-analytics.service';
import { AccountBalanceChangesController } from './account-balance-changes.controller';
import { AccountBalanceChangesService } from './account-balance-changes.service';
import { AccountBalancesController } from './account-balances.controller';
import { AccountBalancesService } from './account-balances.service';
import { AccountDayGroupsService } from './account-day-groups.service';
import { AccountExchangesController } from './account-exchanges.controller';
import { AccountExchangesService } from './account-exchanges.service';
import { AccountFlagsService } from './account-flags.service';
import { AccountOrdersController } from './account-orders.controller';
import { AccountOrdersService } from './account-orders.service';
import { AccountPathPaymentsController } from './account-path-payments.controller';
import { AccountPaymentsController } from './account-payments.controller';
import { AccountPaymentsService } from './account-payments.service';
import { AccountReportsController } from './account-reports.controller';
import { AccountReportsService } from './account-reports.service';
import { AccountStatesService } from './account-states.service';
import { AccountStatsController } from './account-stats.controller';
import { AccountStatsService } from './account-stats.service';
import { AccountTransactionsController } from './account-transactions.controller';
import { AccountTransactionsService } from './account-transactions.service';
import { AccountTrustlinesController } from './account-trustlines.controller';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { LiveLedgerService } from './live-ledger.service';
import { NamesAndLabelsService } from './names-and-labels.service';
import { TrustLinesService } from './trust-lines.service';

/**
 * `GET /v2/accounts` and `GET /v2/accounts/:address`, `GET /v2/accounts/:address/transactions[/:sequence]`,
 * `GET /v2/accounts/:address/{payments,exchanges[/:base[/:counter]],balance_changes}`,
 * `GET /v2/accounts/:address/reports[/:date]` and `GET /v2/accounts/:address/stats/:family` (their values are in the
 * native currency, converted with the `RatesService` of `RatesModule`), the two routes that ask the live node
 * instead of the database, `GET /v2/accounts/:address/{balances,orders}` (`/balances` only for the current ledger: a
 * historical one is read from the state history), and the AMM routes of an account,
 * `GET /v2/accounts/:address/{amm_liquidity,amm_positions}`, the path payments of an account,
 * `GET /v2/accounts/:address/path_payments` (read by the `PathPaymentsService` of `PathPaymentsModule`), and the trust
 * lines of an account at a ledger from the state history, `GET /v2/accounts/:address/trustlines` (its read,
 * `TrustLinesService`, gives `/balances` its trust lines at a historical ledger too).
 *
 * The routes under an account (`/v2/accounts/:address/balances`, `/transactions`, ...) belong to this module too: each
 * is a controller of its own with `@RippleController('v2/accounts')` and a path that continues after `:address`, added
 * to `controllers` below. `:address` matches one segment only, so these never compete with the lookup.
 */
@Module({
  imports: [RatesModule, PathPaymentsModule],
  controllers: [
    AccountsController,
    AccountTransactionsController,
    AccountPaymentsController,
    AccountExchangesController,
    AccountBalanceChangesController,
    AccountBalancesController,
    AccountOrdersController,
    AccountReportsController,
    AccountStatsController,
    AccountAnalyticsController,
    AccountAmmController,
    AccountTrustlinesController,
    AccountPathPaymentsController,
  ],
  providers: [
    AccountsService,
    AccountFlagsService,
    AccountStatesService,
    AccountTransactionsService,
    AccountPaymentsService,
    AccountExchangesService,
    AccountBalanceChangesService,
    LiveLedgerService,
    AccountBalancesService,
    AccountOrdersService,
    AccountReportsService,
    AccountStatsService,
    AccountDayGroupsService,
    AccountAnalyticsService,
    AccountAmmService,
    NamesAndLabelsService,
    TrustLinesService,
  ],
})
export class AccountsModule {}
