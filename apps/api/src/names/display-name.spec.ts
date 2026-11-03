import { DisplayNameInput, displayNameOf, VERIFIED_DESC_MAX } from './display-name';

const TREASURY = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const PAYROLL = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const DOMAIN = 'northpeak.example';

/** An account whose domain's toml lists it (with `desc`); `over` changes what a test needs. */
const listedWith = (desc: string, over: Partial<DisplayNameInput> = {}): DisplayNameInput => ({
  address: TREASURY,
  domain: DOMAIN,
  listing: { desc },
  ...over,
});

describe('displayNameOf', () => {
  it('caps the verified name at 64 characters', () => {
    expect(VERIFIED_DESC_MAX).toBe(64);
  });

  describe('verified', () => {
    it('is the desc of the entry that lists the address under the domain', () => {
      expect(displayNameOf(listedWith('Northpeak Treasury'))).toEqual({ text: 'Northpeak Treasury', kind: 'verified' });
    });

    it('takes a desc of 64 characters and not one of 65: the domain is the name then', () => {
      const sixtyFour = 'N'.repeat(64);
      expect(displayNameOf(listedWith(sixtyFour))).toEqual({ text: sixtyFour, kind: 'verified' });
      expect(displayNameOf(listedWith('N'.repeat(65)))).toEqual({ text: DOMAIN, kind: 'verified' });
    });

    it('counts code points, not UTF-16 units: 64 astral characters are a name, 65 are not', () => {
      const sixtyFour = '\u{1F680}'.repeat(64);
      expect(sixtyFour.length).toBe(128);
      expect(displayNameOf(listedWith(sixtyFour))).toEqual({ text: sixtyFour, kind: 'verified' });
      expect(displayNameOf(listedWith('\u{1F680}'.repeat(65)))).toEqual({ text: DOMAIN, kind: 'verified' });
    });

    it('is the domain when the entry has no desc', () => {
      expect(displayNameOf(listedWith(''))).toEqual({ text: DOMAIN, kind: 'verified' });
    });

    it('stays verified when the address has an account name and a network name too', () => {
      const input = listedWith('Northpeak Treasury', { accountName: 'Treasury', accountNetworkName: 'cold wallet' });
      expect(displayNameOf(input)).toEqual({ text: 'Northpeak Treasury', kind: 'verified' });
    });

    it('needs the domain: a listing without one vouches for nothing', () => {
      expect(displayNameOf(listedWith('Northpeak Treasury', { domain: undefined }))).toBeUndefined();
    });

    it('needs a listing of the address: a toml that does not list it does not verify it', () => {
      expect(displayNameOf(listedWith('Northpeak Treasury', { address: PAYROLL, listing: null }))).toEqual({
        text: DOMAIN,
        kind: 'domain',
      });
    });
  });

  describe('account', () => {
    it('is the account name when the domain does not list the address', () => {
      const input: DisplayNameInput = { address: TREASURY, accountName: 'Harborline Exchange' };
      expect(displayNameOf(input)).toEqual({ text: 'Harborline Exchange', kind: 'account' });
    });

    it('is the account name before the account network name', () => {
      const input: DisplayNameInput = {
        address: TREASURY,
        accountName: 'Harborline Exchange',
        accountNetworkName: 'hot wallet',
      };
      expect(displayNameOf(input)).toEqual({ text: 'Harborline Exchange', kind: 'account' });
    });

    it('is the account network name when there is no account name', () => {
      const input: DisplayNameInput = { address: TREASURY, accountNetworkName: 'hot wallet' };
      expect(displayNameOf(input)).toEqual({ text: 'hot wallet', kind: 'account' });
    });

    it('beats an unverified domain, and a domain whose toml could not be read', () => {
      for (const listing of [null, undefined]) {
        const input: DisplayNameInput = {
          address: TREASURY,
          domain: DOMAIN,
          listing,
          accountName: 'Harborline Exchange',
        };
        expect([listing, displayNameOf(input)]).toEqual([listing, { text: 'Harborline Exchange', kind: 'account' }]);
      }
    });
  });

  describe('domain', () => {
    it('is the unverified domain when its toml does not list the address and nothing else names it', () => {
      expect(displayNameOf({ address: TREASURY, domain: DOMAIN, listing: null })).toEqual({
        text: DOMAIN,
        kind: 'domain',
      });
    });

    it('gives no domain kind when the toml of the domain could not be read: unknown is not "not verified"', () => {
      expect(displayNameOf({ address: TREASURY, domain: DOMAIN })).toBeUndefined();
      expect(displayNameOf({ address: TREASURY, domain: DOMAIN, listing: undefined })).toBeUndefined();
    });
  });

  it('gives no name to an address with no domain and no names', () => {
    expect(displayNameOf({ address: TREASURY, listing: null })).toBeUndefined();
    expect(displayNameOf({ address: TREASURY })).toBeUndefined();
  });
});
