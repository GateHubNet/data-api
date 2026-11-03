import type { ClickHouseService } from '../clickhouse/clickhouse.service';
import type { DomainTomlsRow, TomlReason, UnixSeconds, UnixSecondsMs } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import type { NetworkProfile } from '../network/network-profile';
import { readToml, TomlAccount, TomlContent, TomlCurrency, TomlValidator } from './toml-read';

/**
 * The rows of the toml store (`domain_tomls`, spec 1.2 and 4.4): the one rule for the row of a check that succeeded, which the
 * tomls worker and the validators checker (D8) both write, and the one read by key that D6 and D8 make of the newest rows.
 */

/** The address a domain's toml is fetched from on the network (spec 1.2): `https://{domain}{tomlPath}`. */
export function tomlUrlOf(domain: string, profile: Pick<NetworkProfile, 'tomlPath'>): string {
  return `https://${domain}${profile.tomlPath}`;
}

/**
 * The row of a check that read a file as TOML (spec 4.4): `ok`, the content, checked and fetched `now`, no failures, the next
 * check `recheckMs` later at a whole second (`next_check_at` is a `DateTime`). `domain` is stored in lower case.
 */
export function okTomlRow(o: {
  domain: string;
  tomlUrl: string;
  content: TomlContent;
  now: UnixSecondsMs;
  recheckMs: number;
}): DomainTomlsRow {
  const { content } = o;
  return {
    domain: o.domain.toLowerCase(),
    toml_url: o.tomlUrl,
    status: 'ok',
    reason: '',
    status_code: 0,
    checked_at: o.now,
    fetched_at: o.now,
    next_check_at: Math.ceil(o.now + o.recheckMs / 1000),
    failures: 0,
    modified: content.modified,
    expires: content.expires,
    accounts: content.accounts,
    currencies: content.currencies,
    validators: content.validators,
    principals: content.principals,
  };
}

/**
 * The `ok` row of a file in hand, read and inserted (spec 4.4): the file is read at `fetchedAt` for the network of `profile`.
 * Throws `TomlInvalidError` and writes nothing for a text that is not TOML.
 */
export async function recordToml(
  ch: Pick<ClickHouseService, 'insert'>,
  o: {
    domain: string;
    tomlUrl: string;
    text: string;
    fetchedAt: UnixSecondsMs;
    recheckMs: number;
    profile: Pick<NetworkProfile, 'name'>;
  },
): Promise<DomainTomlsRow> {
  const content = readToml(o.text, o.profile, o.fetchedAt);
  const row = okTomlRow({
    domain: o.domain,
    tomlUrl: o.tomlUrl,
    content,
    now: o.fetchedAt,
    recheckMs: o.recheckMs,
  });
  await ch.insert(Table.DomainTomls, [row]);
  return row;
}

/**
 * The newest row of each of the domains, by key (`domain` is the sort key): the largest `checked_at` of a domain is its current
 * word. Times come back as numbers: milliseconds of the `DateTime64` columns (read as `Int64`, so quoted), seconds of the others.
 */
export const STORED_TOMLS_SQL = `SELECT domain, toml_url, status, reason, status_code,
       toUnixTimestamp64Milli(checked_at) AS checked_ms,
       toUnixTimestamp64Milli(fetched_at) AS fetched_ms,
       toUnixTimestamp(next_check_at) AS next_check,
       failures,
       toUnixTimestamp(modified) AS modified_s,
       toUnixTimestamp(expires) AS expires_s,
       accounts, currencies, validators, principals
  FROM ${Table.DomainTomls}
 WHERE domain IN {domains:Array(String)}
 ORDER BY domain, checked_at DESC
 LIMIT 1 BY domain`;

/** A row of `STORED_TOMLS_SQL` as ClickHouse gives it: an `Int64` quoted, a `NULL` as `null`. */
interface StoredTomlRow {
  domain: string;
  toml_url: string;
  status: 'ok' | 'failed';
  reason: TomlReason;
  status_code: number | string;
  checked_ms: number | string;
  fetched_ms: number | string | null;
  next_check: number | string;
  failures: number | string;
  modified_s: number | string | null;
  expires_s: number | string | null;
  accounts: TomlAccount[];
  currencies: TomlCurrency[];
  validators: TomlValidator[];
  principals: string[];
}

const secondsOrNull = (value: number | string | null): UnixSeconds | null => (value === null ? null : Number(value));

/**
 * The newest row of each of `domains` that has one, by key (lower-case domains, as stored); a domain without a row is not in the
 * map. No query for an empty list.
 */
export async function readStoredTomls(
  ch: Pick<ClickHouseService, 'query'>,
  domains: readonly string[],
): Promise<Map<string, DomainTomlsRow>> {
  if (domains.length === 0) return new Map();
  const rows = await ch.query<StoredTomlRow>(STORED_TOMLS_SQL, { domains });
  return new Map(
    rows.map((row) => [
      row.domain,
      {
        domain: row.domain,
        toml_url: row.toml_url,
        status: row.status,
        reason: row.reason,
        status_code: Number(row.status_code),
        checked_at: Number(row.checked_ms) / 1000,
        fetched_at: row.fetched_ms === null ? null : Number(row.fetched_ms) / 1000,
        next_check_at: Number(row.next_check),
        failures: Number(row.failures),
        modified: secondsOrNull(row.modified_s),
        expires: secondsOrNull(row.expires_s),
        accounts: row.accounts,
        currencies: row.currencies,
        validators: row.validators,
        principals: row.principals,
      },
    ]),
  );
}
