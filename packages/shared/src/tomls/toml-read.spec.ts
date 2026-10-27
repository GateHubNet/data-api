import { classicAddressToXAddress, encodeAccountID } from 'ripple-address-codec';
import {
  EMPTY_TOML_CONTENT,
  MODIFIED_FLOOR_S,
  parseTomlText,
  readToml,
  TOML_LIMITS,
  TomlInvalidError,
} from './toml-read';

// Every TOML text below is hand-written test data, not a recorded file. The instant of every text is built from the
// constants here; no text holds a character outside ASCII (the escapes below are JavaScript's, resolved before the parser).

const PROFILE = { name: 'xrpl' } as const;
/** 2026-10-24T00:00:00Z */
const FETCHED_AT = 1_792_800_000;
/** 2026-10-02T00:00:00Z */
const OCTOBER_SECOND = 1_790_899_200;

/** A valid classic address, one per `n` (up to 2^32). */
const address = (n: number): string => {
  const id = Buffer.alloc(20);
  id.writeUInt32BE(n, 16);
  return encodeAccountID(id);
};

const read = (text: string, fetchedAt = FETCHED_AT) => readToml(text, PROFILE, fetchedAt);
const account = (a: string, rest = '') => `[[ACCOUNTS]]\naddress = "${a}"\n${rest}`;
const metadata = (line: string) => `[METADATA]\n${line}\n`;
const thrownBy = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('parseTomlText', () => {
  it('reads a document and drops a byte order mark at its start', () => {
    expect(parseTomlText('\uFEFFa = 1\n')).toEqual({ a: 1 });
    expect(parseTomlText('a = 1\n')).toEqual({ a: 1 });
  });

  it('throws TomlInvalidError, whose message holds no word of the file', () => {
    const error = thrownBy(() => parseTomlText('a = '));
    expect(error).toBeInstanceOf(TomlInvalidError);
    expect(error).toMatchObject({ name: 'TomlInvalidError', message: 'the file is not valid TOML' });
    expect((error as Error).message).not.toContain('a =');
  });
});

describe('readToml', () => {
  describe('the document', () => {
    it('reads a file that starts with a byte order mark', () => {
      expect(read(`\uFEFF${account(address(1), 'desc = "Treasury"\n')}`).accounts).toEqual([
        { address: address(1), network: '', desc: 'Treasury' },
      ]);
    });

    it('throws TomlInvalidError for a text that is not TOML, and the message holds no word of the file', () => {
      const error = thrownBy(() => read('a = '));
      expect(error).toBeInstanceOf(TomlInvalidError);
      expect((error as Error).message).toBe('the file is not valid TOML');
      expect((error as Error).message).not.toContain('a =');
    });

    it('is the empty content for an empty file, a comment, and a file of sections it does not read', () => {
      expect(read('')).toEqual(EMPTY_TOML_CONTENT);
      expect(read('# nothing here\n')).toEqual(EMPTY_TOML_CONTENT);
      expect(read('[ORGANIZATION]\nname = "Northpeak"\n[[SERVERS]]\nurl = "wss://s.northpeak.example"\n')).toEqual(
        EMPTY_TOML_CONTENT,
      );
    });

    it('ignores a section that is no array of tables, and an entry that is no table', () => {
      expect(
        read(
          [
            'ACCOUNTS = "x"',
            'CURRENCIES = 3',
            'VALIDATORS = [1, "a", [2]]',
            '[PRINCIPALS]',
            'name = "Mara Lindqvist"',
          ].join('\n'),
        ),
      ).toEqual(EMPTY_TOML_CONTENT);
    });

    it('reads the entries of an array of inline tables, as of a table array', () => {
      const text = `ACCOUNTS = [{ address = "${address(1)}", desc = "A" }, { address = "${address(2)}" }]\n`;
      expect(read(text).accounts).toEqual([
        { address: address(1), network: '', desc: 'A' },
        { address: address(2), network: '', desc: '' },
      ]);
    });

    it('returns the same content whatever the profile: every network keeps its entries', () => {
      const text = `${account(address(1), 'network = 21337\n')}[[CURRENCIES]]\ncode = "NPD"\nnetwork = "testnet"\n`;
      const xahau = readToml(text, { name: 'xahau' }, FETCHED_AT);
      expect(xahau).toEqual(readToml(text, { name: 'xrpl-testnet' }, FETCHED_AT));
      expect(xahau.accounts.map((a) => a.network)).toEqual(['21337']);
      expect(xahau.currencies.map((c) => c.network)).toEqual(['testnet']);
    });
  });

  describe('[[ACCOUNTS]]', () => {
    it('keeps the entries in file order, with the address trimmed', () => {
      const text = account(address(3)) + account(`  ${address(1)} `, 'desc = "B"\n') + account(address(2));
      expect(read(text).accounts.map((a) => [a.address, a.desc])).toEqual([
        [address(3), ''],
        [address(1), 'B'],
        [address(2), ''],
      ]);
    });

    it('skips an X-address, a bad checksum, a missing address and one that is not text', () => {
      const good = address(1);
      const badChecksum = `${good.slice(0, -1)}${good.endsWith('a') ? 'b' : 'a'}`;
      const text = [
        account(classicAddressToXAddress(address(2), false, false)),
        account(badChecksum),
        account(''),
        '[[ACCOUNTS]]\ndesc = "no address"\n',
        '[[ACCOUNTS]]\naddress = 7\n',
        '[[ACCOUNTS]]\naddress = ["' + address(4) + '"]\n',
        account(good),
      ].join('');
      expect(read(text).accounts.map((a) => a.address)).toEqual([good]);
    });

    it('keeps the first entry of a repeated address', () => {
      const text =
        account(address(1), 'desc = "first"\n') + account(address(2)) + account(address(1), 'desc = "second"\n');
      expect(read(text).accounts).toEqual([
        { address: address(1), network: '', desc: 'first' },
        { address: address(2), network: '', desc: '' },
      ]);
    });

    it('keeps a desc of 256 code points and reads 257 as none, cutting nothing', () => {
      const text =
        account(address(1), `desc = "${'x'.repeat(256)}"\n`) + account(address(2), `desc = "${'x'.repeat(257)}"\n`);
      expect(read(text).accounts.map((a) => a.desc)).toEqual(['x'.repeat(256), '']);
    });

    it('cleans a desc: bidirectional overrides removed, white space one space', () => {
      expect(read(account(address(1), 'desc = "  North\\u202Epeak \\t  Treasury\\n"\n')).accounts[0]?.desc).toBe(
        'Northpeak Treasury',
      );
    });

    it('reads a desc that is not text as none', () => {
      expect(read(account(address(1), 'desc = 5\n')).accounts[0]?.desc).toBe('');
    });

    it('keeps the first 1,000 of 1,005 accounts, in file order', () => {
      const text = Array.from({ length: 1_005 }, (_, i) => account(address(i + 1))).join('');
      const accounts = read(text).accounts;
      expect(accounts).toHaveLength(TOML_LIMITS.accounts);
      expect(accounts[0]?.address).toBe(address(1));
      expect(accounts[999]?.address).toBe(address(1_000));
    });

    it('does not count a repeated address against the cap', () => {
      const text =
        account(address(1)).repeat(5) + Array.from({ length: 1_000 }, (_, i) => account(address(i + 2))).join('');
      const accounts = read(text).accounts;
      expect(accounts).toHaveLength(1_000);
      expect(accounts[999]?.address).toBe(address(1_000));
    });
  });

  describe('network', () => {
    it('keeps a bare integer network as its decimal text and lower-cases text', () => {
      const text = [
        account(address(1), 'network = 21337\n'),
        account(address(2), 'network = " MAIN "\n'),
        account(address(3), 'network = true\n'),
        account(address(4), 'network = 21337.5\n'),
        account(address(5), 'network = ["main"]\n'),
        account(address(6), 'network = "   "\n'),
        account(address(7)),
        account(address(8), 'network = "Xahau\\u202E"\n'),
        account(address(9), `network = "${'x'.repeat(65)}"\n`),
      ].join('');
      expect(read(text).accounts.map((a) => a.network)).toEqual(['21337', 'main', '', '', '', '', '', 'xahau', '']);
    });

    it('reads a float with no fraction as the integer: the parser gives both the same number', () => {
      const text = account(address(1), 'network = 21337.0\n') + account(address(2), 'network = 2.1337e4\n');
      expect(read(text).accounts.map((a) => a.network)).toEqual(['21337', '21337']);
    });

    it('is read the same way in currencies and validators', () => {
      const text =
        '[[CURRENCIES]]\ncode = "NPD"\nnetwork = 21338\n[[VALIDATORS]]\npublic_key = "nHk1"\nnetwork = "TestNet"\n';
      const content = read(text);
      expect(content.currencies[0]?.network).toBe('21338');
      expect(content.validators[0]?.network).toBe('testnet');
    });
  });

  describe('[[CURRENCIES]]', () => {
    it('skips an entry without a code, with a code that is not text, empty, or longer than 40 code points', () => {
      const text = [
        '[[CURRENCIES]]\nissuer = "' + address(1) + '"\n',
        '[[CURRENCIES]]\ncode = 840\n',
        '[[CURRENCIES]]\ncode = "  "\n',
        `[[CURRENCIES]]\ncode = "${'C'.repeat(41)}"\n`,
        `[[CURRENCIES]]\ncode = "${'C'.repeat(40)}"\n`,
        '[[CURRENCIES]]\ncode = "  NPD "\n',
      ].join('');
      expect(read(text).currencies.map((c) => c.code)).toEqual(['C'.repeat(40), 'NPD']);
    });

    it('keeps the issuer trimmed when it is a classic address with a valid checksum, else empty', () => {
      const good = address(1);
      const badChecksum = `${good.slice(0, -1)}${good.endsWith('a') ? 'b' : 'a'}`;
      const text = [
        `[[CURRENCIES]]\ncode = "AAA"\nissuer = "  ${good} "\n`,
        `[[CURRENCIES]]\ncode = "BBB"\nissuer = "${badChecksum}"\n`,
        `[[CURRENCIES]]\ncode = "CCC"\nissuer = "${classicAddressToXAddress(good, false, false)}"\n`,
        '[[CURRENCIES]]\ncode = "DDD"\nissuer = 5\n',
        '[[CURRENCIES]]\ncode = "EEE"\n',
      ].join('');
      expect(read(text).currencies.map((c) => [c.code, c.issuer])).toEqual([
        ['AAA', good],
        ['BBB', ''],
        ['CCC', ''],
        ['DDD', ''],
        ['EEE', ''],
      ]);
    });

    it('keeps the first 200 of 205', () => {
      const text = Array.from({ length: 205 }, (_, i) => `[[CURRENCIES]]\ncode = "C${i}"\n`).join('');
      const currencies = read(text).currencies;
      expect(currencies).toHaveLength(TOML_LIMITS.currencies);
      expect(currencies[199]?.code).toBe('C199');
    });

    it('keeps the scalar keys that are not its own as the JSON text `fields`', () => {
      const text = [
        '[[CURRENCIES]]',
        'code = "NPD"',
        `issuer = "${address(1)}"`,
        'network = "main"',
        'display_decimals = 2',
        'symbol = "N$"',
        'name = "Northpeak Dollar"',
        '"bad key" = 1',
        'nested = { a = 1 }',
        'list = [1]',
      ].join('\n');
      expect(read(text).currencies[0]?.fields).toBe('{"display_decimals":2,"symbol":"N$","name":"Northpeak Dollar"}');
    });

    it('is `{}` when no key is left', () => {
      expect(read('[[CURRENCIES]]\ncode = "NPD"\n').currencies[0]?.fields).toBe('{}');
    });

    it('keeps a boolean, a float and a cleaned string, and drops what is none of them', () => {
      const text = [
        '[[CURRENCIES]]',
        'code = "NPD"',
        'is_stable = true',
        'ratio = 0.5',
        'inf_key = inf',
        'nan_key = nan',
        'blank = "   "',
        `long = "${'x'.repeat(257)}"`,
        'noted = "  a \\u202E  b "',
        'stamp = 2026-10-02',
        'last = "end"',
      ].join('\n');
      expect(JSON.parse(read(text).currencies[0]?.fields ?? '')).toEqual({
        is_stable: true,
        ratio: 0.5,
        noted: 'a b',
        last: 'end',
      });
    });

    it('drops a key that does not match the pattern, and counts only the keys it keeps against the 16', () => {
      const keys = Array.from({ length: 20 }, (_, i) => `key${String(i).padStart(2, '0')} = ${i}`);
      const text = [
        '[[CURRENCIES]]',
        'code = "NPD"',
        '"a-b" = 1',
        `"${'k'.repeat(33)}" = 2`,
        `${'k'.repeat(32)} = 3`,
        ...keys,
      ].join('\n');
      const fields = JSON.parse(read(text).currencies[0]?.fields ?? '') as Record<string, number>;
      expect(Object.keys(fields)).toEqual(['k'.repeat(32), ...keys.slice(0, 15).map((line) => line.split(' ')[0])]);
      expect(Object.keys(fields)).toHaveLength(TOML_LIMITS.fieldKeys);
    });

    it('puts a key that reads as an array index first, in ascending order, not where the file wrote it', () => {
      const letters = Array.from({ length: 18 }, (_, i) => `k${String(i).padStart(2, '0')} = ${i}`);
      const text = ['[[CURRENCIES]]', 'code = "NPD"', ...letters, '42 = 1', '1 = 2'].join('\n');
      const fields = read(text).currencies[0]?.fields ?? '';
      // the parser keeps no file order: both numeric keys come first and push k14 and k15 out of the sixteen
      expect(Object.keys(JSON.parse(fields))).toEqual([
        '1',
        '42',
        ...Array.from({ length: 14 }, (_, i) => `k${String(i).padStart(2, '0')}`),
      ]);
      expect(fields.startsWith('{"1":2,"42":1,"k00":0,')).toBe(true);
    });

    it('keeps the first 16 of 20 scalar keys', () => {
      const keys = Array.from({ length: 20 }, (_, i) => `k${String(i).padStart(2, '0')} = ${i}`);
      const fields = JSON.parse(
        read(['[[CURRENCIES]]', 'code = "NPD"', ...keys].join('\n')).currencies[0]?.fields ?? '',
      );
      expect(Object.keys(fields)).toEqual(Array.from({ length: 16 }, (_, i) => `k${String(i).padStart(2, '0')}`));
    });
  });

  describe('[[VALIDATORS]]', () => {
    it('skips an entry without a public key, with one that is not text, empty, or longer than 128 code points', () => {
      const text = [
        '[[VALIDATORS]]\nnetwork = "main"\n',
        '[[VALIDATORS]]\npublic_key = 1\n',
        '[[VALIDATORS]]\npublic_key = " "\n',
        `[[VALIDATORS]]\npublic_key = "${'n'.repeat(129)}"\n`,
        `[[VALIDATORS]]\npublic_key = "${'n'.repeat(128)}"\n`,
        '[[VALIDATORS]]\npublic_key = "  nHk1 "\n',
      ].join('');
      expect(read(text).validators.map((v) => v.public_key)).toEqual(['n'.repeat(128), 'nHk1']);
    });

    it('keeps `fields` of the keys that are not public_key and network', () => {
      const text =
        '[[VALIDATORS]]\npublic_key = "nHk1"\nnetwork = "main"\nowner_country = "SI"\nserver_country = "DE"\nunl = true\nasn = 64500\nextra = { a = 1 }\n';
      expect(read(text).validators[0]).toEqual({
        public_key: 'nHk1',
        network: 'main',
        fields: '{"owner_country":"SI","server_country":"DE","unl":true,"asn":64500}',
      });
    });

    it('keeps the first 100 of 105', () => {
      const text = Array.from({ length: 105 }, (_, i) => `[[VALIDATORS]]\npublic_key = "nH${i}"\n`).join('');
      const validators = read(text).validators;
      expect(validators).toHaveLength(TOML_LIMITS.validators);
      expect(validators[99]?.public_key).toBe('nH99');
    });
  });

  describe('[[PRINCIPALS]]', () => {
    it('never keeps an email or a social handle', () => {
      const text = [
        '[[PRINCIPALS]]',
        'name = "Mara Lindqvist"',
        'email = "mara@northpeak.example"',
        'twitter = "@mara"',
        '[[PRINCIPALS]]',
        'name = "ops@northpeak.example"',
        'email = "ops@northpeak.example"',
        'social_x = "@ops"',
      ].join('\n');
      const result = read(text);
      expect(result.principals).toEqual(['Mara Lindqvist']);
      const json = JSON.stringify(result);
      expect(json).not.toContain('mara@');
      expect(json).not.toContain('@mara');
      expect(json).not.toContain('ops@');
    });

    it('reads no other key of a principal, and ignores a principal without a name or whose name is not text', () => {
      const text = [
        '[[PRINCIPALS]]\nemail = "mara@northpeak.example"\n',
        '[[PRINCIPALS]]\nname = 5\n',
        '[[PRINCIPALS]]\nname = " "\n',
        `[[PRINCIPALS]]\nname = "${'N'.repeat(101)}"\n`,
        '[[PRINCIPALS]]\nname = "Eli  Park"\nrole = "CFO"\n',
      ].join('');
      expect(read(text).principals).toEqual(['Eli Park']);
    });

    it('drops a name that holds an @ after the cleaning', () => {
      expect(read('[[PRINCIPALS]]\nname = "ops\\u200B@northpeak.example"\n').principals).toEqual([]);
    });

    it('keeps no repeat, and at most 10, in file order', () => {
      const names = Array.from({ length: 12 }, (_, i) => `Person ${i}`);
      const text = [names[0], ...names, names[3]].map((name) => `[[PRINCIPALS]]\nname = "${name}"\n`).join('');
      expect(read(text).principals).toEqual(names.slice(0, TOML_LIMITS.principals));
    });
  });

  describe('[METADATA]', () => {
    const modified = (line: string) => read(metadata(`modified = ${line}`)).modified;

    it('reads an offset date-time as its instant', () => {
      expect(modified('2026-10-02T00:00:00Z')).toBe(OCTOBER_SECOND);
      expect(modified('2026-10-02T02:00:00+02:00')).toBe(OCTOBER_SECOND);
      expect(modified('2026-10-01T16:00:00-08:00')).toBe(OCTOBER_SECOND);
    });

    it('reads a local date-time as UTC and a local date as 00:00 UTC, dropping the fraction of a second', () => {
      expect(modified('2026-10-02T00:00:00')).toBe(OCTOBER_SECOND);
      expect(modified('2026-10-02T00:00:00.999')).toBe(OCTOBER_SECOND);
      expect(modified('2026-10-02')).toBe(OCTOBER_SECOND);
    });

    it('reads the text of one of those forms, trimmed', () => {
      expect(modified('"2026-10-02"')).toBe(OCTOBER_SECOND);
      expect(modified('" 2026-10-02T00:00:00Z "')).toBe(OCTOBER_SECOND);
      expect(modified('"2026-10-02T00:00:00"')).toBe(OCTOBER_SECOND);
      expect(modified('"2026-10-02T02:00:00+02:00"')).toBe(OCTOBER_SECOND);
    });

    it('is null for a local time alone, other text, and a value of another type', () => {
      expect(modified('12:00:00')).toBeNull();
      expect(modified('"12:00:00"')).toBeNull();
      expect(modified('"yesterday"')).toBeNull();
      expect(modified('""')).toBeNull();
      expect(modified('"2026-13-45"')).toBeNull();
      expect(modified('1790899200')).toBeNull();
      expect(modified('true')).toBeNull();
      expect(read('[METADATA]\n').modified).toBeNull();
      expect(read('[[METADATA]]\nmodified = 2026-10-02\n').modified).toBeNull();
    });

    it('is null before 2012-01-01 and kept from then on', () => {
      expect(MODIFIED_FLOOR_S).toBe(Date.UTC(2012, 0, 1) / 1_000);
      expect(modified('2011-12-31')).toBeNull();
      expect(modified('2011-12-31T23:59:59Z')).toBeNull();
      expect(modified('2012-01-01')).toBe(MODIFIED_FLOOR_S);
    });

    it('is null when more than 86,400 s after the fetch, and kept up to that', () => {
      const at = (seconds: number) => `"${new Date(seconds * 1_000).toISOString()}"`;
      const content = (seconds: number) => read(metadata(`modified = ${at(seconds)}`), FETCHED_AT).modified;
      expect(content(FETCHED_AT + 86_400)).toBe(FETCHED_AT + 86_400);
      expect(content(FETCHED_AT + 86_401)).toBeNull();
      expect(content(FETCHED_AT - 1)).toBe(FETCHED_AT - 1);
    });

    it('keeps `expires` whatever its value, in the same forms', () => {
      const expires = (line: string) => read(metadata(`expires = ${line}`)).expires;
      expect(expires('2011-12-31')).toBe(1_325_289_600);
      expect(expires('2099-01-01T00:00:00Z')).toBe(4_070_908_800);
      expect(expires('"2026-10-02"')).toBe(OCTOBER_SECOND);
      expect(expires('2026-10-02T00:00:00')).toBe(OCTOBER_SECOND);
      expect(expires('12:00:00')).toBeNull();
      expect(expires('"never"')).toBeNull();
    });

    it('keeps `expires` from 1970-01-01 to 2106-02-07T06:28:15Z, the seconds a DateTime column holds, and null outside', () => {
      const expires = (line: string) => read(metadata(`expires = ${line}`)).expires;
      expect(Date.UTC(2106, 1, 7, 6, 28, 15) / 1_000).toBe(4_294_967_295);
      expect(expires('1970-01-01T00:00:00Z')).toBe(0);
      expect(expires('1970-01-01')).toBe(0);
      expect(expires('2106-02-07T06:28:15Z')).toBe(4_294_967_295);
      expect(expires('"2106-02-07T06:28:15Z"')).toBe(4_294_967_295);
      expect(expires('1969-12-31T23:59:59Z')).toBeNull();
      expect(expires('1969-12-31T23:59:59.999Z')).toBeNull();
      expect(expires('2106-02-07T06:28:16Z')).toBeNull();
      expect(expires('"2106-02-07T06:28:16Z"')).toBeNull();
      expect(expires('0000-01-01')).toBeNull();
      expect(expires('"0000-01-01T00:00:00Z"')).toBeNull();
      expect(expires('9999-12-31T23:59:59Z')).toBeNull();
      expect(expires('"9999-12-31"')).toBeNull();
    });

    it('is null for a `modified` the column cannot hold, even one within a day of the fetch', () => {
      const modifiedAt = (line: string) => readToml(metadata(`modified = ${line}`), PROFILE, 4_294_967_295).modified;
      expect(modifiedAt('2106-02-07T06:28:15Z')).toBe(4_294_967_295);
      expect(modifiedAt('2106-02-07T06:28:16Z')).toBeNull();
      expect(modifiedAt('9999-12-31T23:59:59Z')).toBeNull();
    });

    it('reads both keys of a section', () => {
      const text = '[METADATA]\nmodified = 2026-10-02T00:00:00Z\nexpires = 2027-10-02T00:00:00Z\n';
      expect(read(text)).toEqual({ ...EMPTY_TOML_CONTENT, modified: OCTOBER_SECOND, expires: 1_822_435_200 });
    });
  });

  describe('a hostile file', () => {
    it('reads the keys it lists and nothing else, with a key of another type or a nested table ignored', () => {
      const text = [
        '[METADATA]',
        'modified = 2026-10-02T00:00:00Z',
        'unknown = "x"',
        '[ORGANIZATION]',
        'name = "Northpeak Foundation"',
        '[[SERVERS]]',
        'url = "wss://s.northpeak.example"',
        '[[ACCOUNTS]]',
        `address = "${address(1)}"`,
        'desc = "Treasury"',
        'nested = { deep = { deeper = 1 } }',
        '[[CURRENCIES]]',
        'code = "NPD"',
        'issuer = { not = "text" }',
      ].join('\n');
      expect(read(text)).toEqual({
        modified: OCTOBER_SECOND,
        expires: null,
        accounts: [{ address: address(1), network: '', desc: 'Treasury' }],
        currencies: [{ code: 'NPD', issuer: '', network: '', fields: '{}' }],
        validators: [],
        principals: [],
      });
    });
  });
});

describe('EMPTY_TOML_CONTENT and TOML_LIMITS', () => {
  it('is nulls and empty lists, frozen all the way down', () => {
    expect(EMPTY_TOML_CONTENT).toEqual({
      modified: null,
      expires: null,
      accounts: [],
      currencies: [],
      validators: [],
      principals: [],
    });
    expect(Object.isFrozen(EMPTY_TOML_CONTENT)).toBe(true);
    for (const list of [
      EMPTY_TOML_CONTENT.accounts,
      EMPTY_TOML_CONTENT.currencies,
      EMPTY_TOML_CONTENT.validators,
      EMPTY_TOML_CONTENT.principals,
    ]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });

  it('is not the object readToml returns: what a reader gets may be changed without changing it', () => {
    expect(read('')).not.toBe(EMPTY_TOML_CONTENT);
    expect(Object.isFrozen(read(''))).toBe(false);
  });

  it('holds the caps of the spec', () => {
    expect(TOML_LIMITS).toEqual({ accounts: 1_000, currencies: 200, validators: 100, principals: 10, fieldKeys: 16 });
    expect(MODIFIED_FLOOR_S).toBe(1_325_376_000);
  });
});
