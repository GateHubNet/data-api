import { readFileSync } from 'fs';
import { join } from 'path';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import {
  cutText,
  decodeMptMetadata,
  MPT_METADATA_KEYS,
  MPT_NAME_MAX,
  MPT_TICKER_MAX,
  MPT_URI_KEYS,
  MptMetadata,
  mptMetadataConforms,
  mptMetadataHexConforms,
} from './mpt-metadata';

/** The `MPTokenMetadata` of a case of `xrpl/mpt`, as the transaction has it. */
function recordedMetadata(name: string): string {
  const dir = join(__dirname, '..', '..', 'test', 'fixtures', 'xrpl', 'mpt');
  const { cases } = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
    cases: Record<string, { ledger: number; hash: string }>;
  };
  const { ledger, hash } = cases[name];
  const found = FixtureLedgerSource.fromDir(dir)
    .list()
    .find((l) => l.header.ledger_index === ledger)
    ?.transactions.find((t) => t.hash === hash);
  return found?.tx.MPTokenMetadata as string;
}

const hexOf = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('hex');

/** A full XLS-89 object: every rule holds, so that each test of `mptMetadataConforms` breaks one. */
const CONFORMING: MptMetadata = {
  ticker: 'HTF',
  name: 'Hello Token Fund',
  desc: 'A fund',
  icon: 'https://example.com/icon.png',
  asset_class: 'rwa',
  asset_subclass: 'treasury',
  issuer_name: 'Hello Inc',
  uris: [{ uri: 'https://example.com', category: 'website', title: 'Home' }],
  additional_info: { cusip: '123' },
};

describe('decodeMptMetadata', () => {
  it('reads long keys in XLS-89 order', () => {
    const written = {
      additional_info: 'more',
      uris: [{ title: 'Home', category: 'website', uri: 'https://example.com' }],
      issuer_name: 'Hello Inc',
      asset_subclass: 'treasury',
      asset_class: 'rwa',
      icon: 'https://example.com/icon.png',
      desc: 'A fund',
      name: 'Hello Token Fund',
      ticker: 'HTF',
    };
    const decoded = decodeMptMetadata(hexOf(written));
    expect(decoded).toEqual(written);
    expect(Object.keys(decoded as object)).toEqual([...MPT_METADATA_KEYS]);
    expect(Object.keys((decoded as MptMetadata).uris?.[0] as object)).toEqual([...MPT_URI_KEYS]);
  });

  it('has no key for a field with no value', () => {
    expect(Object.keys(decodeMptMetadata(hexOf({ name: 'Hello' })) as object)).toEqual(['name']);
    expect(
      Object.keys(decodeMptMetadata(hexOf({ uris: [{ uri: 'https://a.example' }] }))?.uris?.[0] as object),
    ).toEqual(['uri']);
  });

  it('reads the recorded metadata: long keys with the draft urls, short keys, and a URL as text', () => {
    const long = decodeMptMetadata(recordedMetadata('issuance_create')) as MptMetadata;
    expect(long).toMatchObject({ ticker: 'XAU', name: 'Tokenized Gold (XAU)', asset_class: 'rwa' });
    expect(long.uris?.[0]).toEqual({
      uri: 'https://helveticmetals.ch/xau',
      category: 'website',
      title: 'Helvetic Metals',
    });
    expect(mptMetadataConforms(long)).toBe(true);
    const short = decodeMptMetadata(recordedMetadata('issuance_create_short_keys')) as MptMetadata;
    expect(short).toMatchObject({ ticker: 'XDRAGO', name: 'XDRAGO', asset_class: 'memes', issuer_name: 'XDRAGO' });
    expect(mptMetadataConforms(short)).toBe(true);
    expect(decodeMptMetadata(recordedMetadata('issuance_create_raw_metadata'))).toBeUndefined();
  });

  it('reads the upper-case and the lower-case hex alike', () => {
    const hex = hexOf({ ticker: 'HTF' });
    expect(decodeMptMetadata(hex.toUpperCase())).toEqual({ ticker: 'HTF' });
    expect(decodeMptMetadata(hex.toLowerCase())).toEqual({ ticker: 'HTF' });
  });

  it('reads short keys as long ones', () => {
    const decoded = decodeMptMetadata(
      hexOf({
        t: 'HTF',
        n: 'Hello Token Fund',
        d: 'A fund',
        i: 'https://example.com/icon.png',
        ac: 'rwa',
        as: 'treasury',
        in: 'Hello Inc',
        us: [{ u: 'https://example.com', c: 'website', t: 'Home' }],
        ai: { cusip: '123' },
      }),
    );
    expect(decoded).toEqual(CONFORMING);
    expect(Object.keys(decoded as object)).toEqual([...MPT_METADATA_KEYS]);
  });

  it('prefers the long key when both are there', () => {
    expect(
      decodeMptMetadata(
        hexOf({
          t: 'SHORT',
          ticker: 'LONG',
          us: [{ u: 'https://short.example' }],
          uris: [{ u: 'https://short.example', uri: 'https://long.example', c: 'social', category: 'docs' }],
        }),
      ),
    ).toEqual({ ticker: 'LONG', uris: [{ uri: 'https://long.example', category: 'docs' }] });
  });

  it('takes the long key of the wrong type over a right short one, and drops it', () => {
    expect(decodeMptMetadata(hexOf({ t: 'SHORT', ticker: 5 }))).toEqual({});
  });

  it('reads the draft urls as uris', () => {
    expect(
      decodeMptMetadata(hexOf({ urls: [{ url: 'https://example.com', type: 'website', title: 'Home' }] })),
    ).toEqual({ uris: [{ uri: 'https://example.com', category: 'website', title: 'Home' }] });
  });

  it('reads the draft urls only when neither uris nor us is there', () => {
    const urls = [{ url: 'https://draft.example' }];
    expect(decodeMptMetadata(hexOf({ urls, uris: [{ uri: 'https://long.example' }] }))).toEqual({
      uris: [{ uri: 'https://long.example' }],
    });
    expect(decodeMptMetadata(hexOf({ urls, us: [{ u: 'https://short.example' }] }))).toEqual({
      uris: [{ uri: 'https://short.example' }],
    });
    expect(decodeMptMetadata(hexOf({ urls, uris: 'x' }))).toEqual({});
  });

  it('drops fields of the wrong type and unknown keys', () => {
    expect(
      decodeMptMetadata(
        hexOf({
          ticker: 5,
          name: null,
          desc: ['a'],
          icon: {},
          uris: 'x',
          additional_info: 7,
          foo: 1,
          issuer_name: 'Hello Inc',
        }),
      ),
    ).toEqual({ issuer_name: 'Hello Inc' });
    expect(decodeMptMetadata(hexOf({ additional_info: ['a'] }))).toEqual({});
    expect(decodeMptMetadata(hexOf({ additional_info: null }))).toEqual({});
  });

  it('drops the items of uris that are not objects with a string uri, and their keys of the wrong type', () => {
    expect(
      decodeMptMetadata(
        hexOf({
          uris: [
            'x',
            null,
            5,
            ['y'],
            { title: 'no uri' },
            { uri: 5 },
            { uri: 'https://a.example', category: 5, title: 7, z: 1 },
          ],
        }),
      ),
    ).toEqual({ uris: [{ uri: 'https://a.example' }] });
  });

  it('leaves uris out when no item is left, as a key with no value is absent', () => {
    expect(decodeMptMetadata(hexOf({ uris: [] }))).toEqual({});
    expect(decodeMptMetadata(hexOf({ uris: [{ title: 'no uri' }] }))).toEqual({});
  });

  it('keeps additional_info as an object or a string', () => {
    expect(decodeMptMetadata(hexOf({ additional_info: { a: [1] } }))).toEqual({ additional_info: { a: [1] } });
    expect(decodeMptMetadata(hexOf({ ai: 'text' }))).toEqual({ additional_info: 'text' });
  });

  it('is not misled by keys of the Object prototype', () => {
    expect(decodeMptMetadata(hexOf(JSON.parse('{"__proto__":{"ticker":"X"},"constructor":{"name":"Y"}}')))).toEqual({});
  });

  it('undefined for hex that is not UTF-8, not JSON, not an object, empty, odd, not hex, or more than 1024 bytes', () => {
    const padded = (bytes: number): string => '7B7D' + '20'.repeat(bytes - 2);
    for (const hex of ['FF', '6869', '5B5D', '6E756C6C', '35', '', 'ABC', 'ZZ', '7B7Z', padded(1025)]) {
      expect(decodeMptMetadata(hex)).toBeUndefined();
    }
    expect(decodeMptMetadata(padded(1024))).toEqual({});
  });
});

describe('mptMetadataHexConforms', () => {
  const REQUIRED = { t: 'HTF', n: 'Hello', i: 'https://example.com/i.png', ac: 'defi', in: 'Hello Inc' };
  const LINK = { u: 'https://example.com', c: 'docs', t: 'Docs' };

  it.each<[string, Record<string, unknown>]>([
    ['the required keys alone', {}],
    ['a full item of uris', { us: [LINK] }],
    ['no item of uris', { us: [] }],
    ['an unknown key, which XLS-89 does not forbid', { extra: 5 }],
  ])('is true for %s', (_, over) => {
    expect(mptMetadataHexConforms(hexOf({ ...REQUIRED, ...over }))).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ['an item of uris with no uri', { us: [LINK, { c: 'docs', t: 'no uri' }] }],
    ['an item of uris that is no object', { us: [LINK, 5] }],
    ['uris that is no array', { us: 'http://x' }],
    ['uris of a single item with no uri', { us: [{ c: 'docs' }] }],
    ['a uri that is no string', { us: [{ u: 5, c: 'docs', t: 'x' }] }],
    ['a draft urls that is no array', { urls: 5 }],
    ['a draft urls with an item with no url', { urls: [{ type: 'docs', title: 'x' }] }],
    ['an asset_subclass that is no string', { as: 5 }],
    ['additional_info that is neither an object nor a string', { ai: 5 }],
    ['a desc that is no string', { d: 5 }],
    ['a null where a value belongs', { d: null }],
  ])('is false for %s, which decoding drops', (_, over) => {
    expect(mptMetadataHexConforms(hexOf({ ...REQUIRED, ...over }))).toBe(false);
  });

  it('is false for a rule of the decoded object, and for hex that does not decode', () => {
    expect(mptMetadataHexConforms(hexOf({ ...REQUIRED, ac: 'nope' }))).toBe(false);
    expect(mptMetadataHexConforms('6e6f74206a736f6e')).toBe(false);
    expect(mptMetadataHexConforms('')).toBe(false);
  });
});

describe('mptMetadataConforms', () => {
  it('is true for a full XLS-89 object', () => {
    expect(mptMetadataConforms(CONFORMING)).toBe(true);
  });

  it('is true without what XLS-89 leaves optional', () => {
    const required: MptMetadata = {
      ticker: 'HTF',
      name: 'Hello',
      icon: 'https://example.com/i.png',
      asset_class: 'defi',
      issuer_name: 'Hello Inc',
    };
    expect(mptMetadataConforms(required)).toBe(true);
  });

  it('accepts every class, subclass and category XLS-89 names', () => {
    for (const asset_class of ['rwa', 'memes', 'wrapped', 'gaming', 'defi', 'other']) {
      expect(mptMetadataConforms({ ...CONFORMING, asset_class })).toBe(true);
    }
    for (const asset_subclass of [
      'stablecoin',
      'commodity',
      'real_estate',
      'private_credit',
      'equity',
      'treasury',
      'other',
    ]) {
      expect(mptMetadataConforms({ ...CONFORMING, asset_subclass })).toBe(true);
    }
    for (const category of ['website', 'social', 'docs', 'other']) {
      expect(mptMetadataConforms({ ...CONFORMING, uris: [{ uri: 'https://a.example', category, title: 'A' }] })).toBe(
        true,
      );
    }
  });

  it.each<[string, MptMetadata]>([
    ['a ticker over six characters', { ...CONFORMING, ticker: 'TOOLONG' }],
    ['a ticker in lower case', { ...CONFORMING, ticker: 'htf' }],
    ['no ticker', { ...CONFORMING, ticker: undefined }],
    ['an empty ticker', { ...CONFORMING, ticker: '' }],
    ['no name', { ...CONFORMING, name: undefined }],
    ['no icon', { ...CONFORMING, icon: undefined }],
    ['no issuer_name', { ...CONFORMING, issuer_name: undefined }],
    ['no asset_class', { ...CONFORMING, asset_class: undefined }],
    ['asset_class stocks', { ...CONFORMING, asset_class: 'stocks' }],
    ['rwa without a subclass', { ...CONFORMING, asset_subclass: undefined }],
    ['asset_subclass bonds', { ...CONFORMING, asset_subclass: 'bonds' }],
    ['an empty uri', { ...CONFORMING, uris: [{ uri: '', category: 'website', title: 'A' }] }],
    ['a uri without a title', { ...CONFORMING, uris: [{ uri: 'https://a.example', category: 'website' }] }],
    ['a uri without a category', { ...CONFORMING, uris: [{ uri: 'https://a.example', title: 'A' }] }],
    ['category blog', { ...CONFORMING, uris: [{ uri: 'https://a.example', category: 'blog', title: 'A' }] }],
  ])('is false for %s', (_name, metadata) => {
    expect(mptMetadataConforms(metadata)).toBe(false);
  });

  it('judges the object whichever keys spelled it', () => {
    const short = decodeMptMetadata(
      hexOf({
        t: 'HTF',
        n: 'Hello',
        i: 'https://example.com/i.png',
        ac: 'defi',
        in: 'Hello Inc',
        us: [{ u: 'https://a.example', c: 'docs', t: 'A' }],
      }),
    );
    expect(mptMetadataConforms(short as MptMetadata)).toBe(true);
    const draft = decodeMptMetadata(
      hexOf({
        ticker: 'HTF',
        name: 'Hello',
        icon: 'https://example.com/i.png',
        asset_class: 'defi',
        issuer_name: 'Hello Inc',
        urls: [{ url: 'https://a.example', type: 'docs', title: 'A' }],
      }),
    );
    expect(mptMetadataConforms(draft as MptMetadata)).toBe(true);
  });
});

describe('cutText', () => {
  it("is '' for undefined", () => {
    expect(cutText(undefined, 16)).toBe('');
  });

  it('leaves a text within the limit as it is', () => {
    expect(cutText('HTF', MPT_TICKER_MAX)).toBe('HTF');
    expect(cutText('a'.repeat(MPT_NAME_MAX), MPT_NAME_MAX)).toBe('a'.repeat(MPT_NAME_MAX));
  });

  it('cuts to the limit', () => {
    expect(cutText('a'.repeat(MPT_NAME_MAX + 1), MPT_NAME_MAX)).toBe('a'.repeat(MPT_NAME_MAX));
    expect(cutText('a'.repeat(1025), 1024)).toBe('a'.repeat(1024));
  });

  it('keeps a 16-code-point emoji ticker whole and cuts the 17th', () => {
    expect(cutText('😀'.repeat(MPT_TICKER_MAX), MPT_TICKER_MAX)).toBe('😀'.repeat(MPT_TICKER_MAX));
    expect(cutText('😀'.repeat(MPT_TICKER_MAX + 1), MPT_TICKER_MAX)).toBe('😀'.repeat(MPT_TICKER_MAX));
  });
});

describe('constants', () => {
  it('names the keys in the order of the answers', () => {
    expect(MPT_METADATA_KEYS).toEqual([
      'ticker',
      'name',
      'desc',
      'icon',
      'asset_class',
      'asset_subclass',
      'issuer_name',
      'uris',
      'additional_info',
    ]);
    expect(MPT_URI_KEYS).toEqual(['uri', 'category', 'title']);
    expect([MPT_TICKER_MAX, MPT_NAME_MAX]).toEqual([16, 128]);
  });
});
