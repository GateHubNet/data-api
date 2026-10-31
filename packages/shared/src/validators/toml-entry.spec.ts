import {
  shownValue,
  TOML_DETAILS_VERSION,
  TOML_FIELDS,
  tomlNetworkOf,
  tomlUnlOf,
  validatorTomlEntryOf,
} from './toml-entry';

const NONE = { ownerCountry: '', serverCountry: '', network: '', unl: '', invalid: [] };
const entryOf = (fields: Record<string, unknown>, network = '') =>
  validatorTomlEntryOf({ network, fields: JSON.stringify(fields) });

describe('validatorTomlEntryOf', () => {
  it('reads the four fields of an entry', () => {
    expect(
      validatorTomlEntryOf({
        network: 'main',
        fields: '{"owner_country":"NO","server_country":"de","unl":"https://vl.ripple.com"}',
      }),
    ).toEqual({ ownerCountry: 'NO', serverCountry: 'DE', network: 'main', unl: 'https://vl.ripple.com', invalid: [] });
  });

  describe('reads every odd value of a real file', () => {
    it('keeps a network ID as text', () => {
      expect(entryOf({}, '21337').network).toBe('21337');
    });

    it('reads a code with spaces, and UK as GB', () => {
      expect(entryOf({ server_country: ' fi ', owner_country: 'UK' })).toEqual({
        ...NONE,
        serverCountry: 'FI',
        ownerCountry: 'GB',
      });
    });

    it('refuses a country that is no code, quoted for the log', () => {
      expect(entryOf({ server_country: 'Germany' })).toEqual({
        ...NONE,
        invalid: [{ field: 'server_country', shown: '"Germany"' }],
      });
      expect(entryOf({ owner_country: 49 })).toEqual({ ...NONE, invalid: [{ field: 'owner_country', shown: '"49"' }] });
    });

    it('cuts a long value in the log', () => {
      expect(entryOf({ server_country: 'Bundesrepublik Deutschland' }).invalid).toEqual([
        { field: 'server_country', shown: '"Bundesrepublik D..."' },
      ]);
    });

    it.each([
      ['http://vl.example'],
      ['https://u:p@vl.example'],
      ['not a url'],
      ['https:vl.example'],
      [`https://vl.example/${'a'.repeat(238)}`], // 257 characters
    ])('refuses the unl %s', (unl) => {
      const entry = entryOf({ unl });
      expect(entry.unl).toBe('');
      expect(entry.invalid.map((i) => i.field)).toEqual(['unl']);
    });

    it('keeps a unl of 256 characters', () => {
      const unl = `https://vl.example/${'a'.repeat(237)}`;
      expect(unl).toHaveLength(256);
      expect(entryOf({ unl })).toEqual({ ...NONE, unl });
    });

    it('refuses a network of 33 characters', () => {
      const entry = entryOf({}, 'n'.repeat(33));
      expect(entry.network).toBe('');
      expect(entry.invalid.map((i) => i.field)).toEqual(['network']);
    });

    it('keeps a network of 32 characters', () => {
      expect(entryOf({}, 'n'.repeat(32))).toEqual({ ...NONE, network: 'n'.repeat(32) });
    });

    it('reads a network holding @ as absent, so it is never shown', () => {
      expect(entryOf({}, 'ops@northpeak.example')).toEqual(NONE);
    });
  });

  it('takes an absent field as not given, not invalid', () => {
    expect(validatorTomlEntryOf({ network: '', fields: '{}' })).toEqual(NONE);
  });

  it.each([['nope'], ['[1]'], ['null'], ['1']])('reads the fields text %s, not a JSON object, as none', (fields) => {
    expect(validatorTomlEntryOf({ network: '', fields })).toEqual(NONE);
  });

  it('reads nothing else of the entry', () => {
    expect(entryOf({ server_location: 'Frankfurt', network_asn: 64512, attestation: 'x', network: 'testnet' })).toEqual(
      NONE,
    );
  });

  it('is version 1', () => {
    expect(TOML_DETAILS_VERSION).toBe(1);
    expect(TOML_FIELDS).toEqual(['owner_country', 'server_country', 'network', 'unl']);
  });
});

describe('tomlUnlOf', () => {
  it('gives the text as written', () => {
    expect(tomlUnlOf('HTTPS://VL.Example/list')).toBe('HTTPS://VL.Example/list');
  });

  it.each([[1], [true], [null], [undefined], ['ftp://vl.example']])('refuses %j', (value) => {
    expect(tomlUnlOf(value)).toBeUndefined();
  });
});

describe('tomlNetworkOf', () => {
  it('counts code points', () => {
    expect(tomlNetworkOf('😀'.repeat(32))).toBe('😀'.repeat(32));
    expect(tomlNetworkOf('😀'.repeat(33))).toBeUndefined();
  });

  it.each([[''], [21337], [null], ['a@b']])('refuses %j', (value) => {
    expect(tomlNetworkOf(value)).toBeUndefined();
  });
});

describe('shownValue', () => {
  it('quotes the text of a value and cuts it at 16 code points', () => {
    expect(shownValue('Germany')).toBe('"Germany"');
    expect(shownValue(49)).toBe('"49"');
    expect(shownValue('a'.repeat(16))).toBe(`"${'a'.repeat(16)}"`);
    expect(shownValue('a'.repeat(17))).toBe(`"${'a'.repeat(16)}..."`);
    expect(shownValue('😀'.repeat(17))).toBe(`"${'😀'.repeat(16)}..."`);
  });

  it('escapes what would break a log line', () => {
    expect(shownValue('a\nb')).toBe('"a\\nb"');
  });
});
