import { AmendmentsConfig } from './amendments-config';

/** What `amendments:check` reports (spec 2.6). Every list is sorted; an empty one means that check passed. */
export interface AmendmentsCheckFindings {
  /** Names the node knows that the file lacks. */
  missingNames: string[];
  /** IDs of the ledger or of the current votes that neither the file nor the node names. */
  unnamedIds: string[];
  /** Entries whose `enabled.ledger_index` differs from the ledger of the indexed `EnableAmendment`, once per entry and ledger. */
  contradictions: { name: string; file: number; indexed: number }[];
}

export interface AmendmentsCheckInput {
  config: AmendmentsConfig;
  /** The entries of the node's `feature` answer: the ID, and the name when the node knows it. */
  nodeFeatures: { id: string; name?: string }[];
  /** The IDs of the Amendments object: enabled, and with a majority. */
  ledgerIds: string[];
  /** The IDs voted for in the newest round. */
  votedIds?: string[];
  /** The indexed `EnableAmendment` transactions with flags 0, and the ledger each one is in. */
  enabledEvents?: { id: string; ledgerIndex: number }[];
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Compare the metadata file with what the node, the ledger and the index say. Pure: the script fetches the inputs.
 * IDs are compared without regard to case.
 */
export function amendmentsCheckFindings(input: AmendmentsCheckInput): AmendmentsCheckFindings {
  const { config } = input;

  const missingNames = new Set<string>();
  const namedByNode = new Set<string>();
  for (const feature of input.nodeFeatures) {
    if (!feature.name) continue;
    namedByNode.add(feature.id.toUpperCase());
    if (!config.byName.has(feature.name)) missingNames.add(feature.name);
  }

  const unnamedIds = new Set<string>();
  for (const raw of [...input.ledgerIds, ...(input.votedIds ?? [])]) {
    const id = raw.toUpperCase();
    if (!config.byId.has(id) && !namedByNode.has(id)) unnamedIds.add(id);
  }

  // once per entry and indexed ledger: the index can hold an event twice, or under an ID of another case
  const contradictions: AmendmentsCheckFindings['contradictions'] = [];
  const listed = new Set<string>();
  for (const event of input.enabledEvents ?? []) {
    const entry = config.byId.get(event.id.toUpperCase());
    const file = entry?.enabled?.ledger_index;
    const key = `${entry?.name}\u0000${event.ledgerIndex}`;
    if (entry && file !== undefined && file !== event.ledgerIndex && !listed.has(key)) {
      listed.add(key);
      contradictions.push({ name: entry.name, file, indexed: event.ledgerIndex });
    }
  }
  contradictions.sort((a, b) => byText(a.name, b.name) || a.indexed - b.indexed);

  return {
    missingNames: [...missingNames].sort(byText),
    unnamedIds: [...unnamedIds].sort(byText),
    contradictions,
  };
}
