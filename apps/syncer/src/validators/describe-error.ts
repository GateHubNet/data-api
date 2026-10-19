/** The message of an error, or the text of whatever else was thrown: for a log line that may carry it. */
export const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));
