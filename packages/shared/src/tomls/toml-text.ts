/** A control or format character (Cc, Cf) that is not white space: tab, newline, NBSP and U+FEFF are kept for the next step. */
const INVISIBLE = /(?!\s)[\p{Cc}\p{Cf}]/gu;
const WHITE_SPACE_RUN = /\s+/gu;

/**
 * A text a toml file holds, made safe to show (spec 3.3): `undefined` for a value that is not a string; else NFC, with
 * every control and format character that is not white space removed (a bidirectional override or isolate included),
 * every run of white space one space, and trimmed. `undefined` when nothing is left or the text is longer than `max`
 * code points. Nothing is cut: a text too long is no text.
 */
export function cleanTomlText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.normalize('NFC').replace(INVISIBLE, '').replace(WHITE_SPACE_RUN, ' ').trim();
  return text === '' || [...text].length > max ? undefined : text;
}
