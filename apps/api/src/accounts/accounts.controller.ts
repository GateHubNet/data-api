import { Controller, Get, Logger, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CommonQueryDto } from '../common/query.dto';
import { AccountsService } from './accounts.service';
import {
  AccountBalanceChangesQueryDto,
  AccountBalancesQueryDto,
  AccountOrdersQueryDto,
  AccountPaymentsQueryDto,
  AccountReportsQueryDto,
  AccountTransactionsQueryDto,
} from './accounts.dto';

@ApiTags('accounts')
@Controller({ version: '2', path: 'accounts' })
export class AccountsController {
  private readonly logger = new Logger(AccountsController.name);

  constructor(private readonly service: AccountsService) {}

  @Get()
  @ApiOperation({ summary: 'List created accounts' })
  getAccounts(@Query() query: CommonQueryDto) {
    return this.service.getAccounts(query);
  }

  @Get(':address')
  @ApiOperation({ summary: 'Account creation info' })
  getAccount(@Param('address') address: string) {
    return this.service.getAccount(address);
  }

  @Get(':address/balance_changes')
  @ApiOperation({ summary: 'Account balance changes' })
  getBalanceChanges(@Param('address') address: string, @Query() query: AccountBalanceChangesQueryDto) {
    return this.service.getBalanceChanges(address, query);
  }

  @Get(':address/payments')
  @ApiOperation({ summary: 'Account payments (sent/received)' })
  getPayments(@Param('address') address: string, @Query() query: AccountPaymentsQueryDto) {
    return this.service.getAccountPayments(address, query);
  }

  @Get(':address/transactions')
  @ApiOperation({ summary: 'Account transaction history' })
  getTransactions(@Param('address') address: string, @Query() query: AccountTransactionsQueryDto) {
    return this.service.getAccountTransactions(address, query);
  }

  @Get(':address/exchanges')
  @ApiOperation({ summary: 'Account DEX trades' })
  getExchanges(@Param('address') address: string, @Query() query: CommonQueryDto) {
    return this.service.getAccountExchanges(address, query);
  }

  @Get(':address/balances')
  @ApiOperation({ summary: 'Live account balances (from the XRPL node)' })
  getBalances(@Param('address') address: string, @Query() query: AccountBalancesQueryDto) {
    return this.service.getAccountBalances(address, query);
  }

  @Get(':address/orders')
  @ApiOperation({ summary: 'Live open orders (from the XRPL node)' })
  getOrders(@Param('address') address: string, @Query() query: AccountOrdersQueryDto) {
    return this.service.getAccountOrders(address, query);
  }

  @Get(':address/stats/transactions')
  @ApiOperation({ summary: 'Account transaction-type counts' })
  getTransactionStats(@Param('address') address: string, @Query() query: CommonQueryDto) {
    return this.service.getAccountTransactionStats(address, query);
  }

  @Get(':address/reports')
  @ApiOperation({ summary: 'Per-day sent/received payment report' })
  getReports(@Param('address') address: string, @Query() query: AccountReportsQueryDto) {
    return this.service.getAccountReports(address, query);
  }
}
