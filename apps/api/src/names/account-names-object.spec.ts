import type { AccountLabels } from './account-labels';
import {
  ACCOUNT_NAME_ENTRY_KEYS,
  ACCOUNT_NAMES_BODY_KEYS,
  accountNameObject,
  DISPLAY_NAME_KEYS,
  LABEL_KEYS,
} from './account-names-object';
import type { AccountNameData } from './display-names.service';

const TREASURY = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const HARBOR = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';

/** An input must not be changed: the labels of a name are the names service's own object, shared when an address repeats. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

describe('the keys of GET /v2/account_names', () => {
  it('are pinned, in the order of the answer', () => {
    expect(ACCOUNT_NAMES_BODY_KEYS).toEqual(['result', 'count', 'account_names']);
    expect(ACCOUNT_NAME_ENTRY_KEYS).toEqual([
      'address',
      'display_name',
      'domain',
      'account_name',
      'account_network_name',
      'labels',
    ]);
    expect(DISPLAY_NAME_KEYS).toEqual(['text', 'kind']);
    expect(LABEL_KEYS).toEqual(['description', 'source', 'url']);
  });
});

describe('accountNameObject', () => {
  it('gives an address nothing names as the address alone', () => {
    expect(accountNameObject({ address: TREASURY })).toEqual({ address: TREASURY });
    expect(Object.keys(accountNameObject({ address: TREASURY }))).toEqual(['address']);
  });

  it('keeps the keys of an entry that has them all in order, however the data was put together', () => {
    const data: AccountNameData = {
      labels: { advisory: { description: 'Withdrawals paused', url: 'https://harbor.example/status' } },
      account_network_name: 'hot wallet',
      account_name: 'Harborline Exchange',
      domain: 'harborline.example',
      display_name: { kind: 'verified', text: 'Harborline Exchange' },
      address: HARBOR,
    };
    const entry = accountNameObject(data);
    expect(Object.keys(entry)).toEqual([...ACCOUNT_NAME_ENTRY_KEYS]);
    expect(Object.keys(entry.display_name as object)).toEqual([...DISPLAY_NAME_KEYS]);
    expect(entry).toEqual({
      address: HARBOR,
      display_name: { text: 'Harborline Exchange', kind: 'verified' },
      domain: 'harborline.example',
      account_name: 'Harborline Exchange',
      account_network_name: 'hot wallet',
      labels: { advisory: { description: 'Withdrawals paused', url: 'https://harbor.example/status' } },
    });
  });

  it('leaves out each key that has no value, never null', () => {
    const named = accountNameObject({
      address: HARBOR,
      display_name: { text: 'Harborline Exchange', kind: 'account' },
      account_name: 'Harborline Exchange',
    });
    expect(Object.keys(named)).toEqual(['address', 'display_name', 'account_name']);

    const domain = accountNameObject({
      address: TREASURY,
      display_name: { text: 'lowtide.example', kind: 'domain' },
      domain: 'lowtide.example',
    });
    expect(Object.keys(domain)).toEqual(['address', 'display_name', 'domain']);

    const labelled = accountNameObject({ address: TREASURY, labels: { scam: { description: 'Fake giveaway' } } });
    expect(Object.keys(labelled)).toEqual(['address', 'labels']);
    expect(JSON.stringify([named, domain, labelled])).not.toContain('null');
  });

  it('gives the labels in the order scam, spam, advisory, each with description, source and url, the ones it has', () => {
    // put together in the opposite order, with the keys of each label scrambled
    const labels: AccountLabels = {
      advisory: { url: 'https://harbor.example/status', description: 'Withdrawals paused' },
      spam: { url: 'https://harbor.example/spam', source: 'Harbor desk', description: 'Dust' },
      scam: { source: 'Harbor desk', description: 'Fake giveaway' },
    };
    const entry = accountNameObject({ address: TREASURY, labels });

    const out = entry.labels as Record<string, Record<string, string>>;
    expect(Object.keys(out)).toEqual(['scam', 'spam', 'advisory']);
    expect(Object.keys(out.scam)).toEqual(['description', 'source']);
    expect(Object.keys(out.spam)).toEqual([...LABEL_KEYS]);
    expect(Object.keys(out.advisory)).toEqual(['description', 'url']);
    expect(out).toEqual({
      scam: { description: 'Fake giveaway', source: 'Harbor desk' },
      spam: { description: 'Dust', source: 'Harbor desk', url: 'https://harbor.example/spam' },
      advisory: { description: 'Withdrawals paused', url: 'https://harbor.example/status' },
    });
  });

  it('builds new objects and does not change what it was given: an address asked twice shares the labels of the names service', () => {
    const labels = deepFreeze<AccountLabels>({
      advisory: { url: 'https://harbor.example/status', description: 'Withdrawals paused' },
      scam: { description: 'Fake giveaway' },
    });
    const data = deepFreeze<AccountNameData>({
      address: HARBOR,
      display_name: { text: 'Harborline Exchange', kind: 'account' },
      account_name: 'Harborline Exchange',
      labels,
    });

    const first = accountNameObject(data);
    const second = accountNameObject(data);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.labels).not.toBe(labels);
    expect(first.labels).not.toBe(second.labels);
    expect(first.display_name).not.toBe(data.display_name);
    // the input still has the keys in its order
    expect(Object.keys(labels)).toEqual(['advisory', 'scam']);
  });
});
