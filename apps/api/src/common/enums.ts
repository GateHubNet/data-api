export enum ResponseFormat {
  JSON = 'json',
  CSV = 'csv',
}

export enum Interval {
  ONE_MINUTE = '1minute',
  FIVE_MINUTES = '5minute',
  FIFTEEN_MINUTES = '15minute',
  THIRTY_MINUTES = '30minute',
  ONE_HOUR = '1hour',
  TWO_HOUR = '2hour',
  FOUR_HOUR = '4hour',
  ONE_DAY = '1day',
  THREE_DAY = '3day',
  SEVEN_DAY = '7day',
  ONE_MONTH = '1month',
}

/** Maps an Interval to a ClickHouse time-bucketing function over a DateTime column. */
export const INTERVAL_TO_CH: Record<Interval, (col: string) => string> = {
  [Interval.ONE_MINUTE]: (c) => `toStartOfMinute(${c})`,
  [Interval.FIVE_MINUTES]: (c) => `toStartOfInterval(${c}, INTERVAL 5 MINUTE)`,
  [Interval.FIFTEEN_MINUTES]: (c) => `toStartOfInterval(${c}, INTERVAL 15 MINUTE)`,
  [Interval.THIRTY_MINUTES]: (c) => `toStartOfInterval(${c}, INTERVAL 30 MINUTE)`,
  [Interval.ONE_HOUR]: (c) => `toStartOfHour(${c})`,
  [Interval.TWO_HOUR]: (c) => `toStartOfInterval(${c}, INTERVAL 2 HOUR)`,
  [Interval.FOUR_HOUR]: (c) => `toStartOfInterval(${c}, INTERVAL 4 HOUR)`,
  [Interval.ONE_DAY]: (c) => `toStartOfDay(${c})`,
  [Interval.THREE_DAY]: (c) => `toStartOfInterval(${c}, INTERVAL 3 DAY)`,
  [Interval.SEVEN_DAY]: (c) => `toStartOfInterval(${c}, INTERVAL 7 DAY)`,
  [Interval.ONE_MONTH]: (c) => `toStartOfMonth(${c})`,
};
