import {
  buildValidationsBody,
  StoredValidation,
  VALIDATION_ROW_KEYS,
  validationRow,
  VALIDATIONS_BODY_KEYS,
} from './validation-row-object';

const SIGNING = 'n9MzwWa4dwdZkRzj6XmihBG4ymGtMPd12cLjfhKwx5Hoqeu6WEgy';
const MASTER = 'nHUkp7WhouVMobBUKGrV5FNqjsdD9zKP5jpGnnLLnYxUQSGAwrZ6';
const HASH = '77C0'.repeat(16);
const OTHER = '0F9E'.repeat(16);

/** 2025-10-23T20:51:30Z, as the validator signs it: seconds since 2000-01-01. */
const SIGNED = 814_567_890;

const stored = (over: Partial<StoredValidation> = {}): StoredValidation => ({
  ledger_index: 107_748_180,
  ledger_hash: HASH,
  sightings: 3,
  first_ms: Date.UTC(2026, 9, 19, 15, 42, 51, 204),
  last_ms: Date.UTC(2026, 9, 19, 15, 42, 51, 390),
  signing_key: SIGNING,
  signed_at: SIGNED,
  is_full: 1,
  ...over,
});

describe('validationRow', () => {
  it('has the keys of VALIDATION_ROW_KEYS, in order, for a validation the ledger agrees with', () => {
    const row = validationRow(stored(), HASH);
    expect(Object.keys(row)).toEqual(VALIDATION_ROW_KEYS.filter((key) => key !== 'validated_hash'));
    expect(row).toEqual({
      ledger_index: 107_748_180,
      ledger_hash: HASH,
      validated: 'matches',
      full: true,
      signing_key: SIGNING,
      signing_time: '2025-10-23T20:51:30Z',
      first_datetime: '2026-10-19T15:42:51.204Z',
      last_datetime: '2026-10-19T15:42:51.390Z',
      count: 3,
    });
  });

  it('has validated_hash, in its place, only when the ledger of that index has another hash', () => {
    const row = validationRow(stored(), OTHER);
    expect(row.validated).toBe('different');
    expect(Object.keys(row)).toEqual([...VALIDATION_ROW_KEYS]);
    expect(row.validated_hash).toBe(OTHER);
    expect(Object.keys(row).indexOf('validated_hash')).toBe(Object.keys(row).indexOf('validated') + 1);
  });

  it('says unknown, with no validated_hash, when no ledger of that index is indexed', () => {
    const row = validationRow(stored(), undefined);
    expect(row.validated).toBe('unknown');
    expect('validated_hash' in row).toBe(false);
    expect(Object.keys(row)).toEqual(VALIDATION_ROW_KEYS.filter((key) => key !== 'validated_hash'));
  });

  it('compares the hashes as hex, without regard to case, and serves the hash of the ledger as it is stored', () => {
    expect(validationRow(stored({ ledger_hash: HASH.toLowerCase() }), HASH).validated).toBe('matches');
    expect(validationRow(stored(), OTHER.toLowerCase()).validated_hash).toBe(OTHER.toLowerCase());
  });

  it('converts the signing time from the Ripple epoch to a wall time', () => {
    expect(validationRow(stored({ signed_at: SIGNED }), HASH).signing_time).toBe('2025-10-23T20:51:30Z');
    expect(validationRow(stored({ signed_at: '814567890' }), HASH).signing_time).toBe('2025-10-23T20:51:30Z');
  });

  it('keeps the milliseconds of the first and the last sighting', () => {
    const row = validationRow(stored({ first_ms: '1760888571204', last_ms: '1760888571390' }), HASH);
    expect(row.first_datetime).toBe('2025-10-19T15:42:51.204Z');
    expect(row.last_datetime).toBe('2025-10-19T15:42:51.390Z');
  });

  it('reads the integers ClickHouse sends as text: the count, the ledger index', () => {
    const row = validationRow(stored({ sightings: '3', ledger_index: '107748180', is_full: '1' }), HASH);
    expect(row.count).toBe(3);
    expect(row.ledger_index).toBe(107_748_180);
    expect(row.full).toBe(true);
  });

  it('says full: false for a partial validation, as a boolean', () => {
    expect(validationRow(stored({ is_full: 0 }), HASH).full).toBe(false);
  });

  it('has no key with a null or an undefined value', () => {
    for (const hash of [HASH, OTHER, undefined]) {
      const row = validationRow(stored(), hash);
      expect(Object.values(row).filter((value) => value === null || value === undefined)).toEqual([]);
    }
  });
});

describe('buildValidationsBody', () => {
  const rows = [validationRow(stored(), HASH), validationRow(stored({ ledger_index: 107_748_179 }), undefined)];

  it('has the keys of VALIDATIONS_BODY_KEYS, in order', () => {
    const body = buildValidationsBody(MASTER, rows, 'WzEwNzc0ODE3OSwiNzdDMC4uLiJd');
    expect(Object.keys(body)).toEqual([...VALIDATIONS_BODY_KEYS]);
    expect(body).toMatchObject({
      result: 'success',
      validation_public_key: MASTER,
      count: 2,
      marker: 'WzEwNzc0ODE3OSwiNzdDMC4uLiJd',
    });
    expect(body.validations).toBe(rows);
  });

  it('has no marker on the last page, and counts the rows of the page', () => {
    const body = buildValidationsBody(MASTER, rows.slice(0, 1));
    expect(Object.keys(body)).toEqual(VALIDATIONS_BODY_KEYS.filter((key) => key !== 'marker'));
    expect(body.count).toBe(1);
  });

  it('has an empty page for a validator with no validation in the last 7 days', () => {
    const body = buildValidationsBody(MASTER, []);
    expect(body).toEqual({ result: 'success', validation_public_key: MASTER, count: 0, validations: [] });
  });
});

describe('the key constants', () => {
  it('are the keys of the specification, in order', () => {
    expect([...VALIDATIONS_BODY_KEYS]).toEqual(['result', 'validation_public_key', 'count', 'marker', 'validations']);
    expect([...VALIDATION_ROW_KEYS]).toEqual([
      'ledger_index',
      'ledger_hash',
      'validated',
      'validated_hash',
      'full',
      'signing_key',
      'signing_time',
      'first_datetime',
      'last_datetime',
      'count',
    ]);
  });
});
