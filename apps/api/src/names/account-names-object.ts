import type { AccountLabelData, AccountLabels } from './account-labels';
import type { AccountNameData } from './display-names.service';

/** The keys of the body of `GET /v2/account_names`, in the order of the answer. */
export const ACCOUNT_NAMES_BODY_KEYS = ['result', 'count', 'account_names'] as const;

/** The keys of an entry of `account_names`, in order. A key without a value is left out, never `null`. */
export const ACCOUNT_NAME_ENTRY_KEYS = [
  'address',
  'display_name',
  'domain',
  'account_name',
  'account_network_name',
  'labels',
] as const;

/** The keys of `display_name`, in order. */
export const DISPLAY_NAME_KEYS = ['text', 'kind'] as const;

/** The keys of a label, in order: `source` and `url` are left out when the operator gave none. */
export const LABEL_KEYS = ['description', 'source', 'url'] as const;

/** The labels in the order of the `Enum8` of `account_labels`; each label's keys come in `LABEL_KEYS` order. */
const LABEL_ORDER = ['scam', 'spam', 'advisory'] as const;

/** One label with its keys in order, a new object. */
function labelObject(label: AccountLabelData): Record<string, string> {
  const object: Record<string, string> = { description: label.description };
  if (label.source !== undefined) object.source = label.source;
  if (label.url !== undefined) object.url = label.url;
  return object;
}

/** The labels of an address keyed scam, spam, advisory: new objects, as `labels` is the names service's own and shared. */
function labelsObject(labels: AccountLabels): Record<string, Record<string, string>> {
  const object: Record<string, Record<string, string>> = {};
  for (const name of LABEL_ORDER) {
    const label = labels[name];
    if (label !== undefined) object[name] = labelObject(label);
  }
  return object;
}

/**
 * An entry of `account_names` (spec 5.2): the keys in the order of `ACCOUNT_NAME_ENTRY_KEYS`, the ones without a value left out.
 * It builds new objects and changes nothing it is given: an address asked twice is answered with the same labels object of the
 * names service.
 */
export function accountNameObject(data: AccountNameData): Record<string, unknown> {
  const entry: Record<string, unknown> = { address: data.address };
  if (data.display_name !== undefined) {
    entry.display_name = { text: data.display_name.text, kind: data.display_name.kind };
  }
  if (data.domain !== undefined) entry.domain = data.domain;
  if (data.account_name !== undefined) entry.account_name = data.account_name;
  if (data.account_network_name !== undefined) entry.account_network_name = data.account_network_name;
  if (data.labels !== undefined) entry.labels = labelsObject(data.labels);
  return entry;
}
