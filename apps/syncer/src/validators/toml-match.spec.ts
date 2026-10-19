import { classicAddressToXAddress, encodeAccountID } from 'ripple-address-codec';
import { matchToml, TomlInvalidError } from './toml-match';

// Every TOML text below is hand-written test data, not a recorded file.

const KEY = 'nHUBvDGzZWNgxzsEQzMy3JR7sDDz5wPiuDnj4hZdZpDeM2yeu6gy';
const OTHER_KEY = 'nHBidG3pZK11zQD6kpNDoAhDxH6WLGui6ZxSbUx7LSqLHsgzMPec';

/** A valid classic address, one per `n`. */
const address = (n: number): string => encodeAccountID(Buffer.alloc(20, n));
const entry = (a: string) => `[[ACCOUNTS]]\naddress = "${a}"\n`;
const validator = (key: string) => `[[VALIDATORS]]\npublic_key = "${key}"\n`;
const listing = (...accounts: string[]) => validator(KEY) + accounts.map(entry).join('');

describe('matchToml', () => {
  describe('the validator entry', () => {
    it('finds the key among many [[VALIDATORS]] entries', () => {
      const text = [
        validator('nHBt9fsb4849WmZiCds4r5TXyBeQjqnH5kzPtqgMAQMgi39YZRPa'),
        validator(OTHER_KEY),
        `[[VALIDATORS]]\npublic_key = "${KEY}"\nnetwork = "main"\nowner_country = "SI"\n`,
        validator('nHDwHQGjKTz6R6pFigSSrNBrhNYyUGFPHA9tmoq7BzaUBFFgEtyg'),
      ].join('\n');
      expect(matchToml(text, KEY)).toEqual({ listed: true, accounts: [] });
    });

    it('does not find a key that no entry names', () => {
      const text = [validator(OTHER_KEY), validator('nHBt9fsb4849WmZiCds4r5TXyBeQjqnH5kzPtqgMAQMgi39YZRPa')].join('\n');
      expect(matchToml(text, KEY)).toEqual({ listed: false, accounts: [] });
    });

    it('trims the key of an entry before it compares', () => {
      expect(matchToml(`[[VALIDATORS]]\npublic_key = "  ${KEY}\\t "\n`, KEY).listed).toBe(true);
    });

    it('compares the whole key and exactly, not by prefix, suffix or case', () => {
      for (const named of [KEY.slice(0, -1), `x${KEY}`, KEY.toLowerCase(), `${KEY} ${OTHER_KEY}`]) {
        expect(matchToml(validator(named), KEY).listed).toBe(false);
      }
    });

    it('does not find a key in a file without validators, an empty file or a comment', () => {
      expect(matchToml('', KEY)).toEqual({ listed: false, accounts: [] });
      expect(matchToml('# nothing here\n', KEY)).toEqual({ listed: false, accounts: [] });
      expect(matchToml('[METADATA]\nmodified = 2026-10-19T12:00:00Z\n', KEY)).toEqual({ listed: false, accounts: [] });
    });

    it('is not listed by an entry that has no key, a key that is not text, or a VALIDATORS that is no array of tables', () => {
      expect(matchToml(`[[VALIDATORS]]\nnetwork = "main"\n`, KEY).listed).toBe(false);
      expect(matchToml(`[[VALIDATORS]]\npublic_key = 7\n`, KEY).listed).toBe(false);
      expect(matchToml(`[[VALIDATORS]]\npublic_key = ["${KEY}"]\n`, KEY).listed).toBe(false);
      expect(matchToml(`VALIDATORS = "${KEY}"\n`, KEY).listed).toBe(false);
      expect(matchToml(`[VALIDATORS]\npublic_key = "${KEY}"\n`, KEY).listed).toBe(false);
      expect(matchToml(`VALIDATORS = [1, "${KEY}", [], {}]\n`, KEY).listed).toBe(false);
      expect(matchToml(`validators = [{ public_key = "${KEY}" }]\n`, KEY).listed).toBe(false);
    });

    it('reads an inline table of an array like an array of tables', () => {
      expect(matchToml(`VALIDATORS = [{ public_key = "${KEY}" }]\n`, KEY).listed).toBe(true);
    });
  });

  describe('a byte order mark', () => {
    it('is ignored at the start of the file, and the key it lists is found with its accounts', () => {
      expect(matchToml(`\uFEFF${listing(address(1))}`, KEY)).toEqual({ listed: true, accounts: [address(1)] });
      expect(matchToml(`\uFEFF${validator(OTHER_KEY)}`, KEY)).toEqual({ listed: false, accounts: [] });
    });

    it('is taken off once only, and not from the middle of the file', () => {
      expect(() => matchToml(`\uFEFF\uFEFF${validator(KEY)}`, KEY)).toThrow(TomlInvalidError);
      expect(() => matchToml(`${validator(KEY)}\uFEFF`, KEY)).toThrow(TomlInvalidError);
    });
  });

  describe('TOML that is not valid', () => {
    it.each([
      ['an unterminated string', `[[VALIDATORS]]\npublic_key = "${KEY}\n`],
      ['a key defined twice', 'x = 1\nx = 2\n'],
      ['a table header without its bracket', '[[VALIDATORS]\npublic_key = "x"\n'],
      ['plain text', 'this is not a TOML file at all'],
      ['an HTML page', '<!doctype html><html><body>Not found</body></html>'],
      ['nesting far beyond anything real', `a = ${'['.repeat(100_000)}`],
    ])('throws TomlInvalidError for %s', (_name, text) => {
      expect(() => matchToml(text, KEY)).toThrow(TomlInvalidError);
    });

    it('says nothing of the file in the error', () => {
      let caught: unknown;
      try {
        matchToml('secret_value = "unterminated\n', KEY);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TomlInvalidError);
      const error = caught as TomlInvalidError;
      expect(error.name).toBe('TomlInvalidError');
      expect(error.message).not.toContain('secret_value');
      expect(error.message).not.toContain('unterminated');
      expect(JSON.stringify(Object.getOwnPropertyNames(error).map((p) => String((error as never)[p])))).not.toContain(
        'secret_value',
      );
    });
  });

  describe('the accounts of a listed validator', () => {
    it('keeps a valid classic address', () => {
      expect(matchToml(listing(address(1)), KEY)).toEqual({ listed: true, accounts: [address(1)] });
    });

    it('trims the address', () => {
      const text = `${validator(KEY)}[[ACCOUNTS]]\naddress = "  ${address(1)} "\n`;
      expect(matchToml(text, KEY).accounts).toEqual([address(1)]);
    });

    it('skips an address with a bad checksum', () => {
      const good = address(2);
      const bad = good.slice(0, -1) + (good.endsWith('p') ? 'q' : 'p');
      expect(matchToml(listing(bad, good), KEY).accounts).toEqual([good]);
    });

    it('skips an X-address, a text that is no address, and an empty address', () => {
      const x = classicAddressToXAddress(address(3), 1234, false);
      expect(matchToml(listing(x, 'not an address', '', address(4)), KEY).accounts).toEqual([address(4)]);
    });

    it('skips an entry with no address or an address that is not text', () => {
      const text = [
        validator(KEY),
        `[[ACCOUNTS]]\ndesc = "no address"\n`,
        `[[ACCOUNTS]]\naddress = 12345\n`,
        `[[ACCOUNTS]]\naddress = ["${address(5)}"]\n`,
        `[[ACCOUNTS]]\naddress = true\n`,
        entry(address(6)),
      ].join('\n');
      expect(matchToml(text, KEY).accounts).toEqual([address(6)]);
    });

    it('lists an address once however often the file names it', () => {
      expect(matchToml(listing(address(7), address(7), ` ${address(7)}`), KEY).accounts).toEqual([address(7)]);
    });

    it('sorts the addresses', () => {
      const three = [address(30), address(10), address(20)];
      expect(matchToml(listing(...three), KEY).accounts).toEqual([...three].sort());
    });

    it('keeps the first 10 of 12 valid addresses, sorted', () => {
      const twelve = Array.from({ length: 12 }, (_, i) => address(i + 1));
      const accounts = matchToml(listing(...twelve), KEY).accounts;
      expect(accounts).toHaveLength(10);
      expect(accounts).toEqual([...twelve].sort().slice(0, 10));
    });

    it('counts a skipped entry for nothing, so the 10 are valid ones', () => {
      const valid = Array.from({ length: 11 }, (_, i) => address(i + 1));
      const text = listing(`nope`, ...valid.slice(0, 5), 'rBadBadBad', ...valid.slice(5));
      const accounts = matchToml(text, KEY).accounts;
      expect(accounts).toEqual([...valid].sort().slice(0, 10));
    });

    it('reads no account when the validator is not listed', () => {
      const text = validator(OTHER_KEY) + entry(address(1)) + entry(address(2));
      expect(matchToml(text, KEY)).toEqual({ listed: false, accounts: [] });
    });

    it('reads no account from a file whose ACCOUNTS is not an array of tables', () => {
      expect(matchToml(`${validator(KEY)}ACCOUNTS = "${address(1)}"\n`, KEY)).toEqual({ listed: true, accounts: [] });
      expect(matchToml(`${validator(KEY)}[ACCOUNTS]\naddress = "${address(1)}"\n`, KEY).accounts).toEqual([]);
    });

    it('reads the accounts wherever they are in the file', () => {
      const text = entry(address(1)) + validator(OTHER_KEY) + entry(address(2)) + validator(KEY);
      expect(matchToml(text, KEY)).toEqual({ listed: true, accounts: [address(1), address(2)].sort() });
    });
  });

  it('reads nothing else of the file', () => {
    const text = [
      'unl = "https://evil.example/unl"',
      '[METADATA]',
      'modified = 2026-10-19T12:00:00Z',
      '[[PRINCIPALS]]',
      'name = "someone"',
      'email = "someone@example.com"',
      `[[VALIDATORS]]`,
      `public_key = "${KEY}"`,
      'network = "main"',
      'owner_country = "SI"',
      'server_country = "DE"',
      'unl = "https://other.example/unl"',
      '[[ACCOUNTS]]',
      `address = "${address(1)}"`,
      'network = "main"',
      'desc = "treasury"',
      'url = "https://account.example/"',
    ].join('\n');
    expect(matchToml(text, KEY)).toEqual({ listed: true, accounts: [address(1)] });
    expect(Object.keys(matchToml(text, KEY)).sort()).toEqual(['accounts', 'listed']);
  });
});
