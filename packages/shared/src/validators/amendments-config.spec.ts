import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getNetworkProfile } from '../network';
import { amendmentId, loadAmendmentsConfig, parseAmendmentsConfig } from './amendments-config';

const XRPL = getNetworkProfile('xrpl');
const XAHAU = getNetworkProfile('xahau');
const XRPL_TESTNET = getNetworkProfile('xrpl-testnet');
const XAHAU_TESTNET = getNetworkProfile('xahau-testnet');

const AMM_URL = 'https://github.com/XRPLF/XRPL-Standards/tree/master/XLS-0030-automated-market-maker';

/** A valid XRPL file with two entries; the tests change one thing at a time. */
function xrplFile(): Record<string, any> {
  return {
    network: 'xrpl',
    updated: '2026-10-19',
    amendments: [
      {
        name: 'AMM',
        introduced: '1.12.0',
        xls: 'XLS-30',
        xls_url: AMM_URL,
        description: 'Automated market makers: pools that trade two assets against each other.',
        enabled: { ledger_index: 86795265, date: '2024-03-22' },
      },
      { name: 'CryptoConditionsSuite', introduced: '0.60.0', obsolete: true },
    ],
  };
}

function xahauFile(): Record<string, any> {
  return {
    network: 'xahau',
    updated: '2026-10-19',
    amendments: [
      { name: 'Remit', introduced: '2024.3.12', xls: 'XLS-55' },
      { name: 'MultiSign', retired: true },
    ],
  };
}

/** The refusal message of `parseAmendmentsConfig`, or `undefined` when the file is accepted. */
function refusal(file: unknown, profile = XRPL): string | undefined {
  try {
    parseAmendmentsConfig(file, profile);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

function withEntry(change: (entry: Record<string, any>) => void, file = xrplFile()): Record<string, any> {
  change(file.amendments[0]);
  return file;
}

describe('amendmentId (F9)', () => {
  it('is SHA-512Half of the name, upper-case hex', () => {
    expect(amendmentId('AMM')).toBe('8CC0774A3BF66D1D22E76BBDA8E8A232E6B6313834301B3B23E8601196AE6455');
    expect(amendmentId('XChainBridge')).toBe('C98D98EE9616ACD36E81FDEB8D41D349BF5F1B41DD64A0ABC1FE9AA5EA267E9C');
    expect(amendmentId('MultiSign')).toBe('4C97EBA926031A7CF7D7B36FDE3ED66DDA5421192D63DE53FFB46E43B9DC8373');
    expect(amendmentId('fixNFTokenNegOffer')).toBe('36799EA497B1369B170805C078AEFE6188345F9B3E324C21E9CA3FF574E3C3D6');
    expect(amendmentId('CryptoConditionsSuite')).toBe(
      '86E83A7D2ECE3AD5FA87AB2195AE015C950469ABF0B72EAACED318F74886AE90',
    );
  });

  it('is the ID of the amendment that has majority on XRPL, which the public node does not name (F10)', () => {
    expect(amendmentId('fixCleanup3_4_0')).toBe('98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76');
  });
});

describe('parseAmendmentsConfig (spec 2.6)', () => {
  it('accepts a file and computes the ID of every entry', () => {
    const config = parseAmendmentsConfig(xrplFile(), XRPL);
    expect(config.network).toBe('xrpl');
    expect(config.updated).toBe('2026-10-19');
    expect(config.amendments.map((a) => a.name)).toEqual(['AMM', 'CryptoConditionsSuite']);
    expect(config.amendments[0]).toEqual({
      name: 'AMM',
      id: '8CC0774A3BF66D1D22E76BBDA8E8A232E6B6313834301B3B23E8601196AE6455',
      introduced: '1.12.0',
      xls: 'XLS-30',
      xls_url: AMM_URL,
      description: 'Automated market makers: pools that trade two assets against each other.',
      enabled: { ledger_index: 86795265, date: '2024-03-22' },
    });
    expect(config.amendments[1]).toEqual({
      name: 'CryptoConditionsSuite',
      id: '86E83A7D2ECE3AD5FA87AB2195AE015C950469ABF0B72EAACED318F74886AE90',
      introduced: '0.60.0',
      obsolete: true,
    });
  });

  it('finds an entry by ID and by name', () => {
    const config = parseAmendmentsConfig(xrplFile(), XRPL);
    expect(config.byName.get('AMM')).toBe(config.amendments[0]);
    expect(config.byId.get('8CC0774A3BF66D1D22E76BBDA8E8A232E6B6313834301B3B23E8601196AE6455')).toBe(
      config.amendments[0],
    );
    expect(config.byName.get('Nope')).toBeUndefined();
    expect(config.byId.size).toBe(2);
    expect(config.byName.size).toBe(2);
  });

  it('accepts a Xahau file with a date version, a retired entry and an XLS tag', () => {
    const config = parseAmendmentsConfig(xahauFile(), XAHAU);
    expect(config.network).toBe('xahau');
    expect(config.byName.get('Remit')).toMatchObject({ introduced: '2024.3.12', xls: 'XLS-55' });
    expect(config.byName.get('MultiSign')).toMatchObject({ retired: true });
  });

  it('accepts a file with no amendments', () => {
    expect(parseAmendmentsConfig({ network: 'xrpl', updated: '2026-10-19', amendments: [] }, XRPL).amendments).toEqual(
      [],
    );
  });

  describe('the file', () => {
    it('must be an object with exactly network, updated and amendments', () => {
      expect(refusal(null)).toMatch(/^Invalid amendments config: .+: expected an object/);
      expect(refusal([])).toMatch(/^Invalid amendments config: .+: expected an object/);
      expect(refusal({ updated: '2026-10-19', amendments: [] })).toMatch(/^Invalid amendments config: network: /);
      expect(refusal({ network: 'xrpl', amendments: [] })).toMatch(/^Invalid amendments config: updated: /);
      expect(refusal({ network: 'xrpl', updated: '2026-10-19' })).toMatch(/^Invalid amendments config: amendments: /);
      const extra = { ...xrplFile(), foo: 1 };
      expect(refusal(extra)).toBe('Invalid amendments config: foo: unknown key');
    });

    it('must be for the network of the profile', () => {
      const wrong = { ...xrplFile(), network: 'xahau' };
      expect(refusal(wrong)).toMatch(/^Invalid amendments config: network: .*"xahau".*"xrpl"/);
      expect(refusal(xahauFile())).toMatch(/^Invalid amendments config: network: /);
      expect(refusal(xrplFile(), XAHAU)).toMatch(/^Invalid amendments config: network: /);
    });

    it("may also be its family's file for a testnet, and then drops the enabled entries", () => {
      const config = parseAmendmentsConfig(xrplFile(), XRPL_TESTNET);
      expect(config.network).toBe('xrpl-testnet');
      expect(config.amendments.map((a) => a.name)).toEqual(['AMM', 'CryptoConditionsSuite']);
      expect(config.byName.get('AMM')).toEqual({
        name: 'AMM',
        id: '8CC0774A3BF66D1D22E76BBDA8E8A232E6B6313834301B3B23E8601196AE6455',
        introduced: '1.12.0',
        xls: 'XLS-30',
        xls_url: AMM_URL,
        description: 'Automated market makers: pools that trade two assets against each other.',
      });
      expect(config.byName.get('CryptoConditionsSuite')).toMatchObject({ obsolete: true });
      const xahau = parseAmendmentsConfig(
        { ...xahauFile(), amendments: [{ name: 'Remit', enabled: { date: '2024-03-12' } }] },
        XAHAU_TESTNET,
      );
      expect(xahau.network).toBe('xahau-testnet');
      expect(xahau.byName.get('Remit')).toEqual({ name: 'Remit', id: amendmentId('Remit') });
    });

    it("keeps enabled in a file whose network is the testnet's own name", () => {
      const own = {
        network: 'xrpl-testnet',
        updated: '2026-10-24',
        amendments: [{ name: 'AMM', enabled: { ledger_index: 5, date: '2024-03-22' } }],
      };
      const config = parseAmendmentsConfig(own, XRPL_TESTNET);
      expect(config.network).toBe('xrpl-testnet');
      expect(config.byName.get('AMM')?.enabled).toEqual({ ledger_index: 5, date: '2024-03-22' });
    });

    it("refuses another family's file for a testnet, and a testnet's file for a mainnet", () => {
      expect(refusal({ ...xrplFile(), network: 'xahau' }, XRPL_TESTNET)).toBe(
        'Invalid amendments config: network: "xahau" is not the network of this deployment, "xrpl-testnet"',
      );
      expect(refusal(xahauFile(), XRPL_TESTNET)).toBe(
        'Invalid amendments config: network: "xahau" is not the network of this deployment, "xrpl-testnet"',
      );
      expect(refusal(xrplFile(), XAHAU_TESTNET)).toBe(
        'Invalid amendments config: network: "xrpl" is not the network of this deployment, "xahau-testnet"',
      );
      expect(refusal({ ...xrplFile(), network: 'xrpl-testnet' })).toBe(
        'Invalid amendments config: network: "xrpl-testnet" is not the network of this deployment, "xrpl"',
      );
      expect(refusal({ ...xahauFile(), network: 'xahau-testnet' }, XAHAU)).toBe(
        'Invalid amendments config: network: "xahau-testnet" is not the network of this deployment, "xahau"',
      );
      expect(refusal({ ...xrplFile(), network: 'xahau-testnet' }, XRPL_TESTNET)).toBe(
        'Invalid amendments config: network: "xahau-testnet" is not the network of this deployment, "xrpl-testnet"',
      );
    });

    it('needs `updated` as a day', () => {
      for (const updated of ['2026-10-1', '19-10-2026', '2026-02-30', '2026-13-01', 20261019, '']) {
        expect(refusal({ ...xrplFile(), updated })).toMatch(/^Invalid amendments config: updated: /);
      }
    });

    it('needs `amendments` as a list of objects', () => {
      expect(refusal({ ...xrplFile(), amendments: {} })).toMatch(/^Invalid amendments config: amendments: /);
      expect(refusal({ ...xrplFile(), amendments: ['AMM'] })).toMatch(/^Invalid amendments config: amendments\[0\]: /);
      expect(refusal({ ...xrplFile(), amendments: [null] })).toMatch(/^Invalid amendments config: amendments\[0\]: /);
    });
  });

  describe('name', () => {
    it('is required and names the entry by its position', () => {
      const file = xrplFile();
      delete file.amendments[1].name;
      expect(refusal(file)).toMatch(/^Invalid amendments config: amendments\[1\]: name: required/);
    });

    it('is a letter followed by up to 63 letters, digits and underscores', () => {
      for (const name of ['', '1AMM', 'AM M', 'AMM-1', '_AMM', 'A'.repeat(65), 'Ämm', 5]) {
        expect(refusal(withEntry((e) => (e.name = name)))).toMatch(/^Invalid amendments config: amendments\[0\]/);
      }
      expect(refusal(withEntry((e) => (e.name = 'A'.repeat(64))))).toBeUndefined();
      expect(refusal(withEntry((e) => (e.name = 'fixCleanup3_4_0')))).toBeUndefined();
    });

    it('is unique, and the message names both entries', () => {
      const file = xrplFile();
      file.amendments.push({ name: 'AMM' });
      expect(refusal(file)).toBe('Invalid amendments config: amendments[2] (AMM): name: duplicate of amendments[0]');
    });

    it('is the only identity: an `id` is never written', () => {
      expect(refusal(withEntry((e) => (e.id = amendmentId('AMM'))))).toBe(
        'Invalid amendments config: amendments[0] (AMM): id: unknown key',
      );
    });
  });

  describe('entries', () => {
    it('refuse an unknown key, naming the entry', () => {
      expect(refusal(withEntry((e) => (e.foo = 1)))).toBe(
        'Invalid amendments config: amendments[0] (AMM): foo: unknown key',
      );
    });

    it('accept a retired entry on both families', () => {
      const file = xrplFile();
      file.amendments[1].retired = true;
      expect(refusal(file)).toBeUndefined();
      expect(parseAmendmentsConfig(file, XRPL).byName.get('CryptoConditionsSuite')).toMatchObject({ retired: true });
      const xahau = xahauFile();
      xahau.amendments[1].retired = true;
      expect(refusal(xahau, XAHAU)).toBeUndefined();
    });

    it('allow only `true` for obsolete and retired', () => {
      expect(refusal(withEntry((e) => (e.obsolete = false)))).toMatch(
        /^Invalid amendments config: amendments\[0\] \(AMM\): obsolete: /,
      );
      expect(refusal(withEntry((e) => (e.obsolete = 'yes')))).toMatch(
        /^Invalid amendments config: amendments\[0\] \(AMM\): obsolete: /,
      );
      expect(
        refusal(
          withEntry((e) => (e.retired = false), xahauFile()),
          XAHAU,
        ),
      ).toMatch(/^Invalid amendments config: amendments\[0\] \(Remit\): retired: /);
      expect(refusal(withEntry((e) => (e.retired = false)))).toMatch(
        /^Invalid amendments config: amendments\[0\] \(AMM\): retired: can only be true/,
      );
    });
  });

  describe('introduced', () => {
    it('is a rippled version on XRPL', () => {
      for (const ok of ['0.60.0', '1.12.0', '3.4.1', '10.10.10']) {
        expect(refusal(withEntry((e) => (e.introduced = ok)))).toBeUndefined();
      }
      for (const bad of ['2024.4.21', '100.1.1', '1.12', '1.12.0.1', 'v1.12.0', '1.12.0-rc1', '', 1.12]) {
        expect(refusal(withEntry((e) => (e.introduced = bad)))).toMatch(
          /^Invalid amendments config: amendments\[0\] \(AMM\): introduced: /,
        );
      }
    });

    it("follows the software of the testnet, which is its family's", () => {
      expect(
        refusal(
          withEntry((e) => (e.introduced = '1.12.0')),
          XRPL_TESTNET,
        ),
      ).toBeUndefined();
      expect(
        refusal(
          withEntry((e) => (e.introduced = '2024.4.21')),
          XRPL_TESTNET,
        ),
      ).toMatch(/^Invalid amendments config: amendments\[0\] \(AMM\): introduced: /);
      const xahau = (introduced: string) =>
        refusal(
          withEntry((e) => (e.introduced = introduced), xahauFile()),
          XAHAU_TESTNET,
        );
      expect(xahau('2024.4.21')).toBeUndefined();
      expect(xahau('1.12.0')).toMatch(/^Invalid amendments config: amendments\[0\] \(Remit\): introduced: /);
    });

    it('is a date version on Xahau', () => {
      for (const ok of ['2024.4.21', '2023.12.29', '2026.10.13']) {
        expect(
          refusal(
            withEntry((e) => (e.introduced = ok), xahauFile()),
            XAHAU,
          ),
        ).toBeUndefined();
      }
      for (const bad of ['1.12.0', '24.4.21', '2024.4', '2024.4.21.1', '2024.004.21', '2024-04-21']) {
        expect(
          refusal(
            withEntry((e) => (e.introduced = bad), xahauFile()),
            XAHAU,
          ),
        ).toMatch(/^Invalid amendments config: amendments\[0\] \(Remit\): introduced: /);
      }
    });
  });

  describe('xls and xls_url (G2)', () => {
    it('take an XLS tag', () => {
      expect(refusal(withEntry((e) => (e.xls = 'XLS-0030')))).toBeUndefined();
      for (const bad of ['XLS30', 'xls-30', 'XLS-', 'XLS-30d', '30', '']) {
        expect(refusal(withEntry((e) => (e.xls = bad)))).toMatch(
          /^Invalid amendments config: amendments\[0\] \(AMM\): xls: /,
        );
      }
    });

    it('accept an address under the XRPL standards repository', () => {
      for (const url of [
        AMM_URL,
        'https://github.com/XRPLF/XRPL-Standards/discussions/212',
        'https://github.com/XRPLF/XRPL-Standards/blob/master/XLS-0047-PriceOracles/README.md',
        `${AMM_URL}#readme`,
      ]) {
        expect(refusal(withEntry((e) => (e.xls_url = url)))).toBeUndefined();
      }
    });

    it('refuse another scheme, host, port, credentials or path, naming the entry', () => {
      const bad = [
        'http://github.com/XRPLF/XRPL-Standards/x',
        'https://gitlab.com/XRPLF/XRPL-Standards/x',
        'https://github.com:8443/XRPLF/XRPL-Standards/x',
        'https://github.com:443/XRPLF/XRPL-Standards/x',
        'https://u:p@github.com/XRPLF/XRPL-Standards/x',
        'https://u@github.com/XRPLF/XRPL-Standards/x',
        'https://github.com/XRPLF/other/x',
        'https://github.com/XRPLF/XRPL-Standards',
        'https://github.com/XRPLF/XRPL-Standards/../../evil/x',
        'https://github.com/xrplf/xrpl-standards/x',
        'https://github.com.evil.example/XRPLF/XRPL-Standards/x',
        'https://sub.github.com/XRPLF/XRPL-Standards/x',
        'https://github.com\\@evil.example/XRPLF/XRPL-Standards/x',
        'ftp://github.com/XRPLF/XRPL-Standards/x',
        '//github.com/XRPLF/XRPL-Standards/x',
        'not a url',
        '',
        'https://github.com/XRPLF/XRPL-Standards/x y',
        'https://github.com/XRPLF/XRPL-Standards/x\ny',
      ];
      for (const url of bad) {
        expect(refusal(withEntry((e) => (e.xls_url = url)))).toMatch(
          /^Invalid amendments config: amendments\[0\] \(AMM\): xls_url: /,
        );
      }
    });
  });

  describe('description', () => {
    it('is one line of at most 200 characters', () => {
      expect(refusal(withEntry((e) => (e.description = 'a'.repeat(200))))).toBeUndefined();
      expect(refusal(withEntry((e) => (e.description = 'a'.repeat(201))))).toMatch(
        /^Invalid amendments config: amendments\[0\] \(AMM\): description: .*200/,
      );
      for (const bad of ['', 'two\nlines', 'two\r\nlines', 5]) {
        expect(refusal(withEntry((e) => (e.description = bad)))).toMatch(
          /^Invalid amendments config: amendments\[0\] \(AMM\): description: /,
        );
      }
    });
  });

  describe('enabled', () => {
    it('takes a ledger index and/or a date', () => {
      expect(refusal(withEntry((e) => (e.enabled = { ledger_index: 5 })))).toBeUndefined();
      expect(refusal(withEntry((e) => (e.enabled = { date: '2024-03-22' })))).toBeUndefined();
      expect(refusal(withEntry((e) => (e.enabled = { ledger_index: 5, date: '2024-03-22' })))).toBeUndefined();
    });

    it('needs at least one of them, and refuses anything else', () => {
      for (const bad of [{}, null, [], 'x', { ledger_index: 0 }, { ledger_index: -1 }, { ledger_index: 1.5 }]) {
        expect(refusal(withEntry((e) => (e.enabled = bad)))).toMatch(
          /^Invalid amendments config: amendments\[0\] \(AMM\): enabled/,
        );
      }
      for (const bad of ['2024-3-22', '22-03-2024', '2024-02-30', '2024-03-22T00:00:00Z', 20240322]) {
        expect(refusal(withEntry((e) => (e.enabled = { date: bad })))).toMatch(
          /^Invalid amendments config: amendments\[0\] \(AMM\): enabled/,
        );
      }
      expect(refusal(withEntry((e) => (e.enabled = { ledger_index: '5' })))).toMatch(
        /^Invalid amendments config: amendments\[0\] \(AMM\): enabled/,
      );
    });

    it('refuses an unknown key, naming the entry', () => {
      expect(refusal(withEntry((e) => (e.enabled = { ledger_index: 5, foo: 1 })))).toBe(
        'Invalid amendments config: amendments[0] (AMM): enabled: unknown key "foo"',
      );
    });
  });
});

describe('loadAmendmentsConfig', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'amendments-config-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads the file at the given path', () => {
    const file = join(dir, 'xrpl.json');
    writeFileSync(file, JSON.stringify(xrplFile()));
    expect(loadAmendmentsConfig(XRPL, file).amendments.map((a) => a.name)).toEqual(['AMM', 'CryptoConditionsSuite']);
  });

  it('names the file and the entry when it is invalid', () => {
    const file = join(dir, 'invalid.json');
    writeFileSync(file, JSON.stringify(withEntry((e) => (e.foo = 1))));
    expect(() => loadAmendmentsConfig(XRPL, file)).toThrow(
      `Invalid amendments config: amendments[0] (AMM): foo: unknown key (${file})`,
    );
  });

  it('names the file when it is not JSON, and when it is missing', () => {
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ "network": ');
    expect(() => loadAmendmentsConfig(XRPL, broken)).toThrow(
      new RegExp(`^Invalid amendments config: ${broken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `),
    );
    expect(() => loadAmendmentsConfig(XRPL, join(dir, 'missing.json'))).toThrow(/missing\.json/);
  });

  describe('a testnet (the family file without its enable ledgers)', () => {
    it("reads its family's file and drops the enabled entries", () => {
      const config = loadAmendmentsConfig(getNetworkProfile('xrpl-testnet'));
      expect(config.network).toBe('xrpl-testnet');
      expect(config.amendments).toHaveLength(loadAmendmentsConfig(getNetworkProfile('xrpl')).amendments.length);
      expect(config.amendments.filter((a) => a.enabled !== undefined)).toEqual([]);
      expect(config.byName.get('MultiSign')).toMatchObject({ retired: true, introduced: '0.31.0' });
      expect(config.byName.get('AMM')).toMatchObject({ introduced: '1.12.0', xls: 'XLS-30', xls_url: AMM_URL });
      expect(config.byName.get('CryptoConditionsSuite')).toMatchObject({ obsolete: true });
      expect(loadAmendmentsConfig(getNetworkProfile('xahau-testnet')).amendments.filter((a) => a.enabled)).toEqual([]);
    });

    it('is the family file otherwise: the same names, the same IDs, the same marks', () => {
      for (const [testnet, family] of [
        [XRPL_TESTNET, XRPL],
        [XAHAU_TESTNET, XAHAU],
      ]) {
        const shipped = loadAmendmentsConfig(family);
        const config = loadAmendmentsConfig(testnet);
        expect(config.updated).toBe(shipped.updated);
        expect(config.amendments.map(({ name, id, obsolete, retired }) => ({ name, id, obsolete, retired }))).toEqual(
          shipped.amendments.map(({ name, id, obsolete, retired }) => ({ name, id, obsolete, retired })),
        );
        expect(config.byId.size).toBe(shipped.amendments.length);
        expect(loadAmendmentsConfig(testnet, '  ')).toEqual(config);
      }
    });

    it('keeps enabled in a file of its own, given by path', () => {
      const file = join(dir, 'xrpl-testnet.json');
      writeFileSync(
        file,
        JSON.stringify({
          network: 'xrpl-testnet',
          updated: '2026-10-24',
          amendments: [{ name: 'AMM', enabled: { ledger_index: 5, date: '2024-03-22' } }],
        }),
      );
      expect(loadAmendmentsConfig(XRPL_TESTNET, file).byName.get('AMM')?.enabled).toEqual({
        ledger_index: 5,
        date: '2024-03-22',
      });
    });

    it("refuses another family's file, naming the path", () => {
      const file = join(dir, 'xahau-for-xrpl-testnet.json');
      writeFileSync(file, JSON.stringify(xahauFile()));
      expect(() => loadAmendmentsConfig(XRPL_TESTNET, file)).toThrow(
        `Invalid amendments config: network: "xahau" is not the network of this deployment, "xrpl-testnet" (${file})`,
      );
    });
  });

  describe('the shipped files', () => {
    for (const profile of [XRPL, XAHAU]) {
      describe(profile.name, () => {
        it('loads for its profile, with every ID computed from the name', () => {
          const config = loadAmendmentsConfig(profile);
          expect(config.network).toBe(profile.name);
          expect(config.amendments.length).toBeGreaterThan(100);
          expect(config.byId.size).toBe(config.amendments.length);
          expect(config.byName.size).toBe(config.amendments.length);
          for (const amendment of config.amendments) {
            expect(amendment.id).toBe(amendmentId(amendment.name));
          }
        });

        it('is also the file for an empty or blank path (GH_AMENDMENTS_CONFIG left empty)', () => {
          const shipped = loadAmendmentsConfig(profile);
          for (const path of ['', '  ']) {
            expect(loadAmendmentsConfig(profile, path)).toEqual(shipped);
          }
        });
      });
    }

    it('XRPL: knows the amendments the public node does not name', () => {
      const config = loadAmendmentsConfig(XRPL);
      expect(config.byId.get('98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76')?.name).toBe(
        'fixCleanup3_4_0',
      );
      expect(config.byId.get('14A2B45E48A4A124D1BBA657AC7B0DC3D5EA8C256C89E8F0D8142D32960A7944')?.name).toBe(
        'fixBatchV1_2',
      );
    });

    it('XRPL: AMM carries its version, standard and activation', () => {
      expect(loadAmendmentsConfig(XRPL).byName.get('AMM')).toMatchObject({
        introduced: '1.12.0',
        xls: 'XLS-30',
        xls_url: AMM_URL,
        enabled: { ledger_index: 86795265, date: '2024-03-22' },
      });
    });

    // rippled's `XRPL_RETIRE` list (features.macro): the amendments whose code is unconditional. xahaud retired the same 15.
    const RETIRED = [
      'MultiSign',
      'TrustSetAuth',
      'FeeEscalation',
      'PayChan',
      'CryptoConditions',
      'TickSize',
      'fix1368',
      'Escrow',
      'fix1373',
      'EnforceInvariants',
      'SortedDirectories',
      'fix1201',
      'fix1512',
      'fix1523',
      'fix1528',
    ];

    it('XRPL: the withdrawn amendments are obsolete, and none of them is retired or enabled', () => {
      const config = loadAmendmentsConfig(XRPL);
      for (const name of ['CryptoConditionsSuite', 'NonFungibleTokensV1', 'fixNFTokenDirV1', 'fixNFTokenNegOffer']) {
        expect(config.byName.get(name)).toMatchObject({ obsolete: true });
        expect(config.byName.get(name)?.enabled).toBeUndefined();
        expect(config.byName.get(name)?.retired).toBeUndefined();
      }
    });

    it('XRPL: exactly the 15 XRPL_RETIRE amendments are retired, keeping their enabled', () => {
      const config = loadAmendmentsConfig(XRPL);
      expect(RETIRED).toHaveLength(15);
      expect(
        config.amendments
          .filter((a) => a.retired)
          .map((a) => a.name)
          .sort(),
      ).toEqual([...RETIRED].sort());
      for (const name of RETIRED) expect(config.byName.get(name)?.enabled).toBeDefined();
      expect(config.byName.get('MultiSign')).toMatchObject({
        retired: true,
        introduced: '0.31.0',
        enabled: { ledger_index: 22178817, date: '2016-06-27' },
      });
    });

    it('Xahau: the amendments always on that the ledger does not list are retired', () => {
      const config = loadAmendmentsConfig(XAHAU);
      // exactly these 15: no other entry of the file is retired
      expect(
        config.amendments
          .filter((a) => a.retired)
          .map((a) => a.name)
          .sort(),
      ).toEqual([...RETIRED].sort());
      for (const name of RETIRED) expect(config.byName.get(name)?.enabled).toBeUndefined();
    });

    it('Xahau: dates its own amendments by xahaud release', () => {
      expect(loadAmendmentsConfig(XAHAU).byName.get('Remit')).toMatchObject({
        introduced: '2024.3.12',
        xls: 'XLS-55',
        xls_url: 'https://github.com/XRPLF/XRPL-Standards/discussions/156',
      });
    });
  });
});
