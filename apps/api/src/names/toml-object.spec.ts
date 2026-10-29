import { DomainTomlsRow, getNetworkProfile, TomlCurrency, TomlValidator } from '@gatehub/data-api-shared';
import { TOML_ACCOUNT_KEYS, TOML_CURRENCY_KEYS, TOML_KEYS, TOML_VALIDATOR_KEYS, tomlObject } from './toml-object';

const XRPL = getNetworkProfile('xrpl');
const XAHAU = getNetworkProfile('xahau');

const TREASURY = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const PAYROLL = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';

/** 2026-10-24T07:12:09.410Z, as the store gives it: seconds with the milliseconds as a fraction. */
const CHECKED = 1_792_825_929.41;
/** 2026-10-02T00:00:00Z */
const MODIFIED = 1_790_899_200;
/** 2027-01-01T00:00:00Z */
const EXPIRES = 1_798_761_600;

const currency = (code: string, fields: Record<string, unknown> | string = {}, rest: Partial<TomlCurrency> = {}) => ({
  code,
  issuer: '',
  network: '',
  fields: typeof fields === 'string' ? fields : JSON.stringify(fields),
  ...rest,
});

const validator = (publicKey: string, fields: Record<string, unknown> | string = {}, network = ''): TomlValidator => ({
  public_key: publicKey,
  network,
  fields: typeof fields === 'string' ? fields : JSON.stringify(fields),
});

/** A row of `domain_tomls` of an `ok` check that read nothing but the domain's own words; `rest` changes it. */
function row(rest: Partial<DomainTomlsRow> = {}): DomainTomlsRow {
  return {
    domain: 'northpeak.example',
    toml_url: 'https://northpeak.example/.well-known/xrp-ledger.toml',
    status: 'ok',
    reason: '',
    status_code: 0,
    checked_at: CHECKED,
    fetched_at: CHECKED,
    next_check_at: 1_792_912_329,
    failures: 0,
    modified: null,
    expires: null,
    accounts: [],
    currencies: [],
    validators: [],
    principals: [],
    ...rest,
  };
}

/** An input must not be changed: the row is the service's, kept 60 s and served again. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/** `entry` has the keys of `order` it has, and in that order: none out of place, none made up. */
function expectKeysInOrder(entry: object, order: readonly string[]): void {
  const keys = Object.keys(entry);
  expect(keys).toEqual(order.filter((k) => keys.includes(k)));
}

describe('the keys of GET /v2/toml/{domain}', () => {
  it('are pinned, in the order of the answer', () => {
    expect(TOML_KEYS).toEqual([
      'domain',
      'toml_url',
      'status',
      'reason',
      'status_code',
      'checked',
      'fetched',
      'modified',
      'expires',
      'accounts',
      'currencies',
      'principals',
      'validators',
    ]);
    expect(TOML_ACCOUNT_KEYS).toEqual(['address', 'desc']);
    expect(TOML_CURRENCY_KEYS).toEqual(['code', 'issuer', 'display_decimals', 'symbol', 'name', 'desc']);
    expect(TOML_VALIDATOR_KEYS).toEqual(['public_key', 'owner_country', 'server_country', 'unl']);
  });
});

describe('tomlObject', () => {
  it('gives an ok toml with all it says as the example of the specification, each key in its place', () => {
    const toml = tomlObject(
      row({
        modified: MODIFIED,
        expires: EXPIRES,
        accounts: [
          { address: TREASURY, network: '', desc: 'Northpeak Treasury' },
          { address: PAYROLL, network: 'main', desc: 'Northpeak Payroll' },
        ],
        currencies: [
          currency(
            'NPUSD',
            { display_decimals: 2, symbol: '$NP', name: 'Northpeak Dollar', desc: 'A dollar' },
            { issuer: TREASURY },
          ),
        ],
        principals: ['Mara Lindqvist', 'Tomas Okafor'],
        validators: [
          validator('nHUoKGYLZtYW3VvMoy8c2dzWMTfNcZCe3yT4mxaaeoLXiy6qkpZf', {
            owner_country: 'NO',
            server_country: 'DE',
            unl: 'https://vl.ripple.com',
          }),
        ],
      }),
      XRPL,
    );

    expect(toml).toEqual({
      domain: 'northpeak.example',
      toml_url: 'https://northpeak.example/.well-known/xrp-ledger.toml',
      status: 'ok',
      checked: '2026-10-24T07:12:09.410Z',
      fetched: '2026-10-24T07:12:09.410Z',
      modified: '2026-10-02T00:00:00Z',
      expires: '2027-01-01T00:00:00Z',
      accounts: [
        { address: TREASURY, desc: 'Northpeak Treasury' },
        { address: PAYROLL, desc: 'Northpeak Payroll' },
      ],
      currencies: [
        {
          code: 'NPUSD',
          issuer: TREASURY,
          display_decimals: 2,
          symbol: '$NP',
          name: 'Northpeak Dollar',
          desc: 'A dollar',
        },
      ],
      principals: ['Mara Lindqvist', 'Tomas Okafor'],
      validators: [
        {
          public_key: 'nHUoKGYLZtYW3VvMoy8c2dzWMTfNcZCe3yT4mxaaeoLXiy6qkpZf',
          owner_country: 'NO',
          server_country: 'DE',
          unl: 'https://vl.ripple.com',
        },
      ],
    });
    expectKeysInOrder(toml, TOML_KEYS);
    expect(Object.keys(toml)).toEqual([...TOML_KEYS].filter((k) => k !== 'reason' && k !== 'status_code'));
    for (const account of toml.accounts as object[]) expectKeysInOrder(account, TOML_ACCOUNT_KEYS);
    for (const c of toml.currencies as object[]) expect(Object.keys(c)).toEqual([...TOML_CURRENCY_KEYS]);
    for (const v of toml.validators as object[]) expect(Object.keys(v)).toEqual([...TOML_VALIDATOR_KEYS]);
  });

  it('gives a toml that says nothing as the domain, the address, the status and the instant of the check', () => {
    expect(tomlObject(row(), XRPL)).toEqual({
      domain: 'northpeak.example',
      toml_url: 'https://northpeak.example/.well-known/xrp-ledger.toml',
      status: 'ok',
      checked: '2026-10-24T07:12:09.410Z',
      fetched: '2026-10-24T07:12:09.410Z',
    });
  });

  describe('reason and status_code', () => {
    it('carries the reason of a failed toml, and the status code of an http_status alone', () => {
      const http = tomlObject(
        row({ status: 'failed', reason: 'http_status', status_code: 503, failures: 1, fetched_at: null }),
        XRPL,
      );
      expect(http).toMatchObject({ status: 'failed', reason: 'http_status', status_code: 503 });
      expect(Object.keys(http)).toEqual(['domain', 'toml_url', 'status', 'reason', 'status_code', 'checked']);

      const timeout = tomlObject(row({ status: 'failed', reason: 'timeout', failures: 1, fetched_at: null }), XRPL);
      expect(timeout).toMatchObject({ status: 'failed', reason: 'timeout' });
      expect(timeout).not.toHaveProperty('status_code');
    });

    it('leaves both out of an ok toml, and the status code out of every reason but http_status', () => {
      const ok = tomlObject(row(), XRPL);
      expect(ok).not.toHaveProperty('reason');
      expect(ok).not.toHaveProperty('status_code');

      for (const reason of ['dns_error', 'connect_error', 'tls_error', 'too_large', 'toml_invalid'] as const) {
        const failed = tomlObject(row({ status: 'failed', reason, status_code: 0, fetched_at: null }), XRPL);
        expect([reason, Object.keys(failed)]).toEqual([reason, ['domain', 'toml_url', 'status', 'reason', 'checked']]);
      }
    });
  });

  describe('what a failed toml carries', () => {
    it('serves the content still in effect, with the instant it was fetched, when a blip kept it', () => {
      const fetched = CHECKED - 3_600;
      const toml = tomlObject(
        row({
          status: 'failed',
          reason: 'http_status',
          status_code: 503,
          failures: 1,
          fetched_at: fetched,
          modified: MODIFIED,
          accounts: [{ address: TREASURY, network: '', desc: 'Northpeak Treasury' }],
          principals: ['Mara Lindqvist'],
        }),
        XRPL,
      );

      expect(toml).toEqual({
        domain: 'northpeak.example',
        toml_url: 'https://northpeak.example/.well-known/xrp-ledger.toml',
        status: 'failed',
        reason: 'http_status',
        status_code: 503,
        checked: '2026-10-24T07:12:09.410Z',
        fetched: '2026-10-24T06:12:09.410Z',
        modified: '2026-10-02T00:00:00Z',
        accounts: [{ address: TREASURY, desc: 'Northpeak Treasury' }],
        principals: ['Mara Lindqvist'],
      });
    });

    it('serves no content, and no fetched, after a definite failure', () => {
      const toml = tomlObject(
        row({ status: 'failed', reason: 'http_status', status_code: 404, failures: 1, fetched_at: null }),
        XRPL,
      );
      expect(toml).toEqual({
        domain: 'northpeak.example',
        toml_url: 'https://northpeak.example/.well-known/xrp-ledger.toml',
        status: 'failed',
        reason: 'http_status',
        status_code: 404,
        checked: '2026-10-24T07:12:09.410Z',
      });
    });
  });

  describe('the instants', () => {
    it('writes checked and fetched as instants of receipt, to the millisecond', () => {
      for (const ms of [0, 1, 7, 10, 409, 410, 411, 999]) {
        const at = (1_792_825_929 * 1000 + ms) / 1000;
        const toml = tomlObject(row({ checked_at: at, fetched_at: at }), XRPL);
        const expected = `2026-10-24T07:12:09.${String(ms).padStart(3, '0')}Z`;
        expect([ms, toml.checked, toml.fetched]).toEqual([ms, expected, expected]);
      }
    });

    it('rounds to the millisecond, so that the float a division leaves a hair below one does not move the instant', () => {
      // 1792825929.4099998 * 1000 is 1792825929409.9998: a Date cuts it to 409
      const toml = tomlObject(row({ checked_at: 1_792_825_929.409_999_8, fetched_at: 1_792_825_929.409_999_8 }), XRPL);
      expect(toml).toMatchObject({ checked: '2026-10-24T07:12:09.410Z', fetched: '2026-10-24T07:12:09.410Z' });
    });

    it('writes modified and expires as wall times to the second, and leaves them out when the toml gives none', () => {
      expect(tomlObject(row({ modified: MODIFIED, expires: EXPIRES }), XRPL)).toMatchObject({
        modified: '2026-10-02T00:00:00Z',
        expires: '2027-01-01T00:00:00Z',
      });
      const none = tomlObject(row({ modified: null, expires: null }), XRPL);
      expect(none).not.toHaveProperty('modified');
      expect(none).not.toHaveProperty('expires');
      // 1970-01-01T00:00:00Z is an instant, not an absent one
      expect(tomlObject(row({ modified: 0 }), XRPL)).toMatchObject({ modified: '1970-01-01T00:00:00Z' });
    });
  });

  describe('accounts', () => {
    it('leaves out the desc of an entry that gives none', () => {
      const toml = tomlObject(row({ accounts: [{ address: PAYROLL, network: '', desc: '' }] }), XRPL);
      expect(toml.accounts).toEqual([{ address: PAYROLL }]);
    });

    it('keeps the order of the toml', () => {
      const toml = tomlObject(
        row({
          accounts: [
            { address: PAYROLL, network: '', desc: 'B' },
            { address: TREASURY, network: '', desc: 'A' },
          ],
        }),
        XRPL,
      );
      expect((toml.accounts as { address: string }[]).map((a) => a.address)).toEqual([PAYROLL, TREASURY]);
    });
  });

  describe('currencies', () => {
    it('leaves out an issuer that is empty, and the keys of fields that are not there', () => {
      const toml = tomlObject(
        row({ currencies: [currency('NPUSD'), currency('NPEUR', {}, { issuer: PAYROLL })] }),
        XRPL,
      );
      expect(toml.currencies).toEqual([{ code: 'NPUSD' }, { code: 'NPEUR', issuer: PAYROLL }]);
    });

    it('takes display_decimals from fields when it is an integer from 0 to 30', () => {
      const shown = (value: unknown) =>
        (
          tomlObject(row({ currencies: [currency('NPUSD', { display_decimals: value })] }), XRPL).currencies as object[]
        )[0];
      for (const ok of [0, 2, 15, 30]) expect(shown(ok)).toEqual({ code: 'NPUSD', display_decimals: ok });
      for (const left of [31, 100, -1, 2.5, '2', '', true, null, [2], { n: 2 }]) {
        expect([left, shown(left)]).toEqual([left, { code: 'NPUSD' }]);
      }
    });

    it('takes symbol, name and desc from fields when they are text, and nothing else of fields', () => {
      const toml = tomlObject(
        row({
          currencies: [
            currency('NPUSD', {
              symbol: '$NP',
              name: 'Northpeak Dollar',
              desc: 'A dollar',
              contact_email: 'ops@northpeak.example',
              email: 'ops@northpeak.example',
              twitter: '@northpeak',
              is_asset_backed: true,
              anchor_asset: 'USD',
              status: 'live',
              url: 'https://northpeak.example/npusd',
            }),
            currency('NPEUR', { symbol: 7, name: true, desc: null }),
            currency('NPGBP', { symbol: ['£'], name: { en: 'Pound' } }),
          ],
        }),
        XRPL,
      );
      expect(toml.currencies).toEqual([
        { code: 'NPUSD', symbol: '$NP', name: 'Northpeak Dollar', desc: 'A dollar' },
        { code: 'NPEUR' },
        { code: 'NPGBP' },
      ]);
      expect(JSON.stringify(toml)).not.toMatch(/@|twitter|anchor|is_asset|live|https:\/\/northpeak\.example\/npusd/);
    });

    it('serves the code and the issuer as they are stored, whatever its fields hold', () => {
      const toml = tomlObject(
        row({ currencies: [currency('NPUSD', { code: 'OTHER', issuer: PAYROLL }, { issuer: TREASURY })] }),
        XRPL,
      );
      expect(toml.currencies).toEqual([{ code: 'NPUSD', issuer: TREASURY }]);
    });

    it('reads fields that are not a JSON object as no fields', () => {
      for (const fields of ['', 'not json', 'null', '[]', '[{"name":"x"}]', '"name"', '7', 'true', '{"name":']) {
        const toml = tomlObject(row({ currencies: [currency('NPUSD', fields)] }), XRPL);
        expect([fields, toml.currencies]).toEqual([fields, [{ code: 'NPUSD' }]]);
      }
    });
  });

  describe('validators', () => {
    it('takes owner_country, server_country and unl from fields when they are text, and nothing else', () => {
      const toml = tomlObject(
        row({
          validators: [
            validator('nHBtpPEVwUVZPGs1PwtBRXRVTbeoUoEUCvZuyZfdoBEVRcs2zEqu', {
              owner_country: 'NO',
              server_country: 'DE',
              unl: 'https://vl.ripple.com',
              email: 'ops@northpeak.example',
              twitter: '@northpeak',
              domain: 'other.example',
              name: 'Northpeak 1',
            }),
            validator('nHBq1ReL1VycBMjYQbZhjMtwxfuEXjCqCqXz8Qzsf6kcWpMhCNKw', { owner_country: 5, unl: false }),
            validator('nHUyx7RfD6Pq7f3Sx1n8rC4vGhzMpKq1QYdn4s4Ys3xqVKaTHyD3', 'not json'),
          ],
        }),
        XRPL,
      );
      expect(toml.validators).toEqual([
        {
          public_key: 'nHBtpPEVwUVZPGs1PwtBRXRVTbeoUoEUCvZuyZfdoBEVRcs2zEqu',
          owner_country: 'NO',
          server_country: 'DE',
          unl: 'https://vl.ripple.com',
        },
        { public_key: 'nHBq1ReL1VycBMjYQbZhjMtwxfuEXjCqCqXz8Qzsf6kcWpMhCNKw' },
        { public_key: 'nHUyx7RfD6Pq7f3Sx1n8rC4vGhzMpKq1QYdn4s4Ys3xqVKaTHyD3' },
      ]);
      expect(JSON.stringify(toml)).not.toMatch(/@|twitter|other\.example|Northpeak 1/);
    });
  });

  describe('principals', () => {
    it('serves the names as they are stored, in order, and leaves the key out when there are none', () => {
      expect(tomlObject(row({ principals: ['Tomas Okafor', 'Mara Lindqvist'] }), XRPL).principals).toEqual([
        'Tomas Okafor',
        'Mara Lindqvist',
      ]);
      expect(tomlObject(row({ principals: [] }), XRPL)).not.toHaveProperty('principals');
    });
  });

  describe('the entries that count on the network', () => {
    const NETWORKS = ['', 'main', 'mainnet', 'testnet', 'xahau', '21337', '21338', 'devnet'];
    const named = (network: string): string => network || 'none';
    const withNetworks = () =>
      row({
        accounts: NETWORKS.map((network, i) => ({ address: `rAccount${i}`, network, desc: named(network) })),
        currencies: NETWORKS.map((network) => currency(`C${named(network)}`, {}, { network })),
        validators: NETWORKS.map((network) => validator(`nH${named(network)}`, {}, network)),
      });
    /** The `desc` of each entry of the list, which the entries made out of its network. */
    const descs = (toml: Record<string, unknown>) => (toml.accounts as { desc: string }[]).map((a) => a.desc);

    it('on XRPL are those with no network, main and mainnet, in all three lists', () => {
      const toml = tomlObject(withNetworks(), XRPL);

      expect(descs(toml)).toEqual(['none', 'main', 'mainnet']);
      expect((toml.currencies as { code: string }[]).map((c) => c.code)).toEqual(['Cnone', 'Cmain', 'Cmainnet']);
      expect((toml.validators as { public_key: string }[]).map((v) => v.public_key)).toEqual([
        'nHnone',
        'nHmain',
        'nHmainnet',
      ]);
    });

    it('on Xahau are those with no network, main, mainnet, xahau and 21337', () => {
      const toml = tomlObject(withNetworks(), XAHAU);

      expect(descs(toml)).toEqual(['none', 'main', 'mainnet', 'xahau', '21337']);
      expect((toml.currencies as { code: string }[]).map((c) => c.code)).toEqual([
        'Cnone',
        'Cmain',
        'Cmainnet',
        'Cxahau',
        'C21337',
      ]);
      expect((toml.validators as { public_key: string }[]).map((v) => v.public_key)).toEqual([
        'nHnone',
        'nHmain',
        'nHmainnet',
        'nHxahau',
        'nH21337',
      ]);
    });

    it('leaves a list out when none of its entries counts', () => {
      const toml = tomlObject(
        row({
          accounts: [{ address: TREASURY, network: 'testnet', desc: 'Testnet treasury' }],
          currencies: [currency('NPUSD', {}, { network: 'xahau' })],
          validators: [validator('nHtest', {}, 'testnet')],
          principals: ['Mara Lindqvist'],
        }),
        XRPL,
      );
      expect(Object.keys(toml)).toEqual(['domain', 'toml_url', 'status', 'checked', 'fetched', 'principals']);
    });
  });

  describe('a key without a value', () => {
    it('is left out and never null, whatever the row holds', () => {
      const toml = tomlObject(
        row({
          fetched_at: null,
          modified: null,
          expires: null,
          accounts: [{ address: TREASURY, network: '', desc: '' }],
          currencies: [currency('NPUSD', { display_decimals: null, symbol: null })],
          validators: [validator('nHtest', { unl: null })],
        }),
        XRPL,
      );
      expect(JSON.stringify(toml)).not.toContain('null');
      expect(toml.accounts).toEqual([{ address: TREASURY }]);
      expect(toml.currencies).toEqual([{ code: 'NPUSD' }]);
      expect(toml.validators).toEqual([{ public_key: 'nHtest' }]);
    });
  });

  it('changes nothing it is given and builds new objects', () => {
    const given = deepFreeze(
      row({
        modified: MODIFIED,
        accounts: [{ address: TREASURY, network: '', desc: 'Northpeak Treasury' }],
        currencies: [currency('NPUSD', { display_decimals: 2 })],
        validators: [validator('nHtest', { unl: 'https://vl.ripple.com' })],
        principals: ['Mara Lindqvist'],
      }),
    );

    const first = tomlObject(given, XRPL);
    const second = tomlObject(given, XRPL);

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.accounts).not.toBe(first.accounts);
    expect(second.principals).not.toBe(first.principals);
    expect(second.principals).not.toBe(given.principals);
  });
});
