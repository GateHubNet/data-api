import { ClickHouseService, isoTimeToUnixSeconds, toClickHouseDateTime, View } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { CommonQueryDto } from '../common/query.dto';

interface StatsRow {
  day: string;
  payments: string;
  exchanges: string;
  accounts_created: string;
}

@Injectable()
export class StatsService {
  constructor(private readonly ch: ClickHouseService) {}

  async getStats(options: CommonQueryDto) {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    const startUnix = isoTimeToUnixSeconds(options.start);
    const endUnix = isoTimeToUnixSeconds(options.end);
    if (startUnix !== undefined) {
      where.push('day >= toDate({start:DateTime})');
      params.start = toClickHouseDateTime(startUnix);
    }
    if (endUnix !== undefined) {
      where.push('day <= toDate({end:DateTime})');
      params.end = toClickHouseDateTime(endUnix);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // SummingMergeTree may hold un-merged parts; sum() in the query collapses them.
    const rows = await this.ch.query<StatsRow>(
      `SELECT toString(day) AS day, sum(payments) AS payments, sum(exchanges) AS exchanges,
              sum(accounts_created) AS accounts_created
       FROM ${View.StatsDaily} ${whereSql}
       GROUP BY day ORDER BY day ${options.descending ? 'DESC' : 'ASC'}`,
      params,
    );

    const stats = rows.map((r) => ({
      date: r.day,
      payments: Number(r.payments),
      exchanges: Number(r.exchanges),
      accounts_created: Number(r.accounts_created),
    }));
    return { result: 'success', count: stats.length, stats };
  }
}
