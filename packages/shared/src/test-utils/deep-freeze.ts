/**
 * Recursively freeze an object graph. Test helper: parsers must never mutate their input, so specs pass them frozen
 * data and a write throws in strict mode. Not exported from the package barrel and excluded from the build.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
