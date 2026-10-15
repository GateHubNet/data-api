import * as xrpl from 'xrpl';

/** Ripple epoch (2000-01-01T00:00:00Z) in unix ms. */
export const RIPPLE_EPOCH_MS = 946_684_800_000;

/** ISO-8601 string -> ripple time (seconds since ripple epoch). */
export function isoTimeToRippleTime(value?: string): number | undefined {
  if (!value) return undefined;
  return xrpl.isoTimeToRippleTime(value);
}

/** ISO-8601 string -> unix seconds (ClickHouse DateTime is unix seconds). */
export function isoTimeToUnixSeconds(value?: string): number | undefined {
  if (!value) return undefined;
  return Math.floor(new Date(value).getTime() / 1000);
}

/** unix seconds -> ISO-8601 string. */
export function unixSecondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** Format unix seconds as a ClickHouse-friendly 'YYYY-MM-DD HH:MM:SS' UTC string. */
export function toClickHouseDateTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}
