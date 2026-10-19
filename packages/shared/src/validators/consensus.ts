/** The share of trusted validators an amendment needs on both networks, in percent. */
const AMENDMENT_THRESHOLD_PERCENT = 80;
/** Ledgers between flag ledgers on both networks. */
const FLAG_INTERVAL = 256;

/** ⌊a / b⌋ for whole non-negative numbers, exact (no floating point division). */
function floorDiv(a: number, b: number): number {
  return (a - (a % b)) / b;
}

/** ⌈a / b⌉ for whole non-negative numbers, exact. */
function ceilDiv(a: number, b: number): number {
  return floorDiv(a + b - 1, b);
}

/**
 * The validations a ledger needs to be fully validated (F12, rippled's `ValidatorList::calculateQuorum`):
 * max(⌈0.8 × (unl − negative)⌉, ⌈0.6 × unl⌉). `negativeOnUnl` counts only negative-UNL members that are on the UNL.
 */
export function quorumOf(unlSize: number, negativeOnUnl: number): number {
  return Math.max(ceilDiv(4 * (unlSize - negativeOnUnl), 5), ceilDiv(3 * unlSize, 5));
}

/** The votes an amendment has to exceed (F7): max(1, ⌊trusted × percent / 100⌋). */
export function amendmentThreshold(trusted: number, percent: number = AMENDMENT_THRESHOLD_PERCENT): number {
  return Math.max(1, floorDiv(trusted * percent, 100));
}

/** The votes that make an amendment pass: 1 for up to one trusted validator, else the threshold + 1. */
export function amendmentNeeded(trusted: number, percent: number = AMENDMENT_THRESHOLD_PERCENT): number {
  return trusted <= 1 ? 1 : amendmentThreshold(trusted, percent) + 1;
}

/** Whether `yes` votes carry an amendment (F7): more than the threshold, or the threshold itself for one validator. */
export function amendmentPasses(yes: number, trusted: number, percent: number = AMENDMENT_THRESHOLD_PERCENT): boolean {
  const threshold = amendmentThreshold(trusted, percent);
  return trusted === 1 ? yes >= threshold : yes > threshold;
}

/** The voting ledger of a round: the ledger before a flag ledger, index % 256 = 255. */
export function isVotingLedger(index: number): boolean {
  return index % FLAG_INTERVAL === FLAG_INTERVAL - 1;
}

/** The first voting ledger at or after `index`. */
export function votingLedgerAtOrAfter(index: number): number {
  return ceilDiv(index + 1, FLAG_INTERVAL) * FLAG_INTERVAL - 1;
}

/** The first flag ledger (a multiple of 256) above `index`. */
export function nextFlagLedger(index: number): number {
  return (floorDiv(index, FLAG_INTERVAL) + 1) * FLAG_INTERVAL;
}
