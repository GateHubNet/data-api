import { badRequest } from '../common/errors';

/** An object id: 64 hex digits, any case (the ids are stored and answered in upper case). */
const OBJECT_ID = /^[0-9A-Fa-f]{64}$/;

/**
 * An object id from the path, upper-cased. 400 with `message` (`invalid escrow id`, ...) for anything that is not 64 hex
 * digits; the message is the route's own, so each kind of object says its name.
 */
export function objectIdParam(raw: string, message: string): string {
  if (!OBJECT_ID.test(raw)) throw badRequest(message);
  return raw.toUpperCase();
}
