import { Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request } from 'express';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { fmtTime } from '../common/format';
import { bool, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { Report } from './account-report-object';
import { reportWindow } from './account-report-window';
import { AccountReportsService } from './account-reports.service';

/** A report for a CSV with `accounts`: the counterparties of a cell are one text. */
type CsvReport = Omit<Report, 'receiving_counterparties' | 'sending_counterparties'> & {
  receiving_counterparties: string;
  sending_counterparties: string;
};

interface AccountReportsBody {
  result: 'success';
  start: string;
  end: string;
  count: number;
  reports: (Report | CsvReport)[];
}

/** The name of the CSV file, as `accountReports.js` has it: `<address> - reports`. `@Csv` adds the `.csv`. */
const csvFilename = (req: Request): string => `${req.params.address} - reports`;

/**
 * `GET /v2/accounts/:address/reports[/:date]` (`api/routes/accountReports.js`): what an account sent and received, a
 * report for each UTC day, with every value in the native currency.
 *
 * The address is not checked, as in the original: one that is none has a report of zeros for each day. A failure is
 * `unable to retrieve payments`, the message the original has (it copied the route of the payments).
 */
@RippleController('v2/accounts')
export class AccountReportsController {
  constructor(private readonly reports: AccountReportsService) {}

  @Get([':address/reports', ':address/reports/:date'])
  @RippleRoute('unable to retrieve payments')
  @Csv(csvFilename, 'reports')
  @ApiOperation({
    summary: 'Get the daily reports of an account',
    description:
      'A report for each UTC day from `start` to `end` (at most 200 days; `/{date}` is the one day), with zeros for a ' +
      'day without payments. It has the number of `Payment`s the account sent and received, the largest of each and ' +
      'their total value (`total_value` is the two totals together), and the accounts it paid (`receiving_counterparties`) ' +
      'and was paid by (`sending_counterparties`): their number, or the accounts with `accounts`. The values are in ' +
      'the native currency: an issued currency counts at the rate of the day (`/v2/exchange_rates`, in strict ' +
      'mode), and as 0 where it has none. `payments` lists each payment with its delivered amount. `format=csv` gives ' +
      'the reports as a CSV file.',
  })
  @ApiParam({ name: 'address', description: 'The address of the account.' })
  @ApiParam({ name: 'date', required: false, description: 'One day: the report of the day of this date.' })
  @ApiQuery({ name: 'start', required: false, description: 'The first day. Default: now.' })
  @ApiQuery({ name: 'end', required: false, description: 'The last day, whole. Default: now.' })
  @ApiQuery({
    name: 'accounts',
    required: false,
    type: Boolean,
    description: 'The counterparties themselves instead of their number. Alias: `counterparties`.',
  })
  @ApiQuery({ name: 'payments', required: false, type: Boolean, description: 'List the payments of each day.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest day first.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async report(
    @Param('address') address: string,
    @Param('date') date: string | undefined,
    @Query() query: QueryParams,
  ): Promise<AccountReportsBody> {
    // the checks come in the order of the original: the dates, then the length of the window
    const window = reportWindow(query, date, Date.now());
    const accounts = bool(query, 'accounts') || bool(query, 'counterparties');

    const reports = await this.reports.reports({
      account: address,
      days: window.days,
      accounts,
      payments: bool(query, 'payments'),
    });
    if (bool(query, 'descending')) reports.reverse();

    return {
      result: 'success',
      start: fmtTime(window.start),
      end: fmtTime(window.end),
      count: reports.length,
      // a CSV cell holds the accounts of a report in one text
      reports: wantsCsv(query) && accounts ? reports.map(joinCounterparties) : reports,
    };
  }
}

/** The counterparties of a report as the original wrote them in a CSV: `rA, rB`. */
function joinCounterparties(report: Report): CsvReport {
  const join = (accounts: number | string[]): string =>
    Array.isArray(accounts) ? accounts.join(', ') : String(accounts);
  return {
    ...report,
    receiving_counterparties: join(report.receiving_counterparties),
    sending_counterparties: join(report.sending_counterparties),
  };
}
