/** The message of an error, or the text of whatever else was thrown: for a log line that may carry it. */
export const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A node's own answer (`RippledError`, matched by name: the class is not the same across package copies). */
export const isRippledError = (err: unknown): boolean => err instanceof Error && err.name === 'RippledError';

/** A plain name or code, safe to put in a log line or a label. */
export const SIMPLE_NAME = /^[A-Za-z0-9_.$]{1,64}$/;

/** The error code of an answer of the node (`actNotFound`, ...), `unknown` for anything that is not a plain code. */
export function rippledCodeOf(err: unknown): string {
  const data = (err as { data?: unknown }).data;
  const code = typeof data === 'object' && data !== null ? (data as { error?: unknown }).error : undefined;
  return typeof code === 'string' && SIMPLE_NAME.test(code) ? code : 'unknown';
}
