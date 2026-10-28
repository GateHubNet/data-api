import { DisplayNameInput, displayNameOf, VERIFIED_DESC_MAX } from './display-name';

const TREASURY = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const PAYROLL = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const DOMAIN = 'northpeak.example';

/** An account whose domain lists it (with `desc`) in a toml the directory has loaded; `over` changes what a test needs. */
const listedWith = (desc: string, over: Partial<DisplayNameInput> = {}): DisplayNameInput => ({
  address: TREASURY,
  domain: DOMAIN,
  listed: new Map([[TREASURY, desc]]),
  directoryLoaded: true,
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

    it('needs the domain: a list without one vouches for nothing', () => {
      expect(displayNameOf(listedWith('Northpeak Treasury', { domain: undefined }))).toBeUndefined();
    });

    it('needs the address in the list of the domain: another address of the toml is not verified', () => {
      expect(displayNameOf(listedWith('Northpeak Treasury', { address: PAYROLL }))).toEqual({
        text: DOMAIN,
        kind: 'domain',
      });
    });
  });

  describe('account', () => {
    it('is the account name when the domain does not list the address', () => {
      const input: DisplayNameInput = { address: TREASURY, directoryLoaded: true, accountName: 'Harborline Exchange' };
      expect(displayNameOf(input)).toEqual({ text: 'Harborline Exchange', kind: 'account' });
    });

    it('is the account name before the account network name', () => {
      const input: DisplayNameInput = {
        address: TREASURY,
        directoryLoaded: true,
        accountName: 'Harborline Exchange',
        accountNetworkName: 'hot wallet',
      };
      expect(displayNameOf(input)).toEqual({ text: 'Harborline Exchange', kind: 'account' });
    });

    it('is the account network name when there is no account name', () => {
      const input: DisplayNameInput = { address: TREASURY, directoryLoaded: true, accountNetworkName: 'hot wallet' };
      expect(displayNameOf(input)).toEqual({ text: 'hot wallet', kind: 'account' });
    });

    it('beats an unverified domain', () => {
      const input: DisplayNameInput = {
        address: TREASURY,
        domain: DOMAIN,
        listed: new Map([[PAYROLL, 'Northpeak Payroll']]),
        directoryLoaded: true,
        accountName: 'Harborline Exchange',
      };
      expect(displayNameOf(input)).toEqual({ text: 'Harborline Exchange', kind: 'account' });
    });
  });

  describe('domain', () => {
    it('is the unverified domain when the directory has loaded and nothing else names the address', () => {
      expect(displayNameOf({ address: TREASURY, domain: DOMAIN, directoryLoaded: true })).toEqual({
        text: DOMAIN,
        kind: 'domain',
      });
    });

    it('is the unverified domain when the toml of the domain lists other accounts only', () => {
      const input: DisplayNameInput = {
        address: TREASURY,
        domain: DOMAIN,
        listed: new Map([[PAYROLL, 'Northpeak Payroll']]),
        directoryLoaded: true,
      };
      expect(displayNameOf(input)).toEqual({ text: DOMAIN, kind: 'domain' });
    });

    it('gives no domain kind before the directory has loaded', () => {
      expect(displayNameOf({ address: TREASURY, domain: DOMAIN, directoryLoaded: false })).toBeUndefined();
    });
  });

  it('gives no name to an address with no domain and no names', () => {
    expect(displayNameOf({ address: TREASURY, directoryLoaded: true })).toBeUndefined();
    expect(displayNameOf({ address: TREASURY, directoryLoaded: false })).toBeUndefined();
  });
});
