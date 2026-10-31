import { DomainTomlsRow, EMPTY_TOML_CONTENT, getNetworkProfile } from '@gatehub/data-api-shared';
import { domainTomlFactsOf } from './domain-toml-facts';

const XRPL = getNetworkProfile('xrpl');
const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const ACCOUNT = 'rrrrrrrrrrrrrrrrrrrrrhoLvTp';

const row = (o: Partial<DomainTomlsRow> = {}): DomainTomlsRow => ({
  domain: 'northpeak.example',
  toml_url: 'https://northpeak.example/.well-known/xrp-ledger.toml',
  status: 'ok',
  reason: '',
  status_code: 0,
  checked_at: 1_793_000_000.5,
  fetched_at: 1_793_000_000.5,
  next_check_at: 1_793_086_400,
  failures: 0,
  ...EMPTY_TOML_CONTENT,
  ...o,
});
const currency = (code: string, network = '') => ({ code, issuer: ISSUER, network, fields: '{}' });
const account = (address: string, network = '') => ({ address, network, desc: '' });

describe('domainTomlFactsOf', () => {
  it('is undefined without a row and when fetched_at is null', () => {
    expect(domainTomlFactsOf(undefined, XRPL)).toBeUndefined();
    expect(domainTomlFactsOf(row({ status: 'failed', fetched_at: null }), XRPL)).toBeUndefined();
  });

  it('gives the facts of a row whose content is in effect, also a failure that carries it', () => {
    expect(
      domainTomlFactsOf(
        row({ status: 'failed', fetched_at: 1_793_000_000.5, modified: 1_790_000_000, principals: ['Mara'] }),
        XRPL,
      ),
    ).toEqual({
      principals: ['Mara'],
      modified: 1_790_000_000,
      accountsListed: 0,
      currencies: [],
      fetchedAt: 1_793_000_000.5,
    });
  });

  it('keeps the currencies that count on this network, in file order', () => {
    const facts = domainTomlFactsOf(
      row({ currencies: [currency('USD'), currency('EUR', 'main'), currency('TST', 'testnet')] }),
      XRPL,
    );
    expect(facts?.currencies).toEqual([
      { code: 'USD', issuer: ISSUER },
      { code: 'EUR', issuer: ISSUER },
    ]);
  });

  it('counts every account whatever its network, an address listed for two networks once', () => {
    const facts = domainTomlFactsOf(
      row({ accounts: [account(ISSUER), account(ISSUER, 'testnet'), account(ACCOUNT, 'testnet')] }),
      XRPL,
    );
    expect(facts?.accountsListed).toBe(2);
  });

  it('drops a principal holding @', () => {
    const facts = domainTomlFactsOf(row({ principals: ['Mara Lindqvist', 'ops@northpeak.example'] }), XRPL);
    expect(facts?.principals).toEqual(['Mara Lindqvist']);
  });

  it('drops a currency whose code holds @', () => {
    const facts = domainTomlFactsOf(row({ currencies: [currency('a@b'), currency('USD')] }), XRPL);
    expect(facts?.currencies).toEqual([{ code: 'USD', issuer: ISSUER }]);
  });
});
