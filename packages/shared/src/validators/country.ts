/**
 * The country codes a validator's toml may name and the `country` parameter takes: the 249 ISO 3166-1 alpha-2 codes
 * assigned on 2026-10-24, and `XK`, which is user-assigned and used for Kosovo. The explorer's country table (E13) holds
 * the same 250, written by hand from the same list, so a new assignment is a change to both.
 */
export const ISO_COUNTRY_CODES: ReadonlySet<string> = new Set(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
    'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
    'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ ' +
    'NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
    'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
    'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW XK'
  ).split(' '),
);

/** Two ASCII letters. Checked before upper-casing, which folds `ß`, `ﬁ`, `ıd` and `ſe` into real codes. */
const TWO_LETTERS = /^[A-Za-z]{2}$/;

/** A string, trimmed and upper-cased, with `UK` read as `GB` (ISO reserves it for the United Kingdom): the code, if it is one. */
export function countryCodeOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!TWO_LETTERS.test(text)) return undefined;
  const upper = text.toUpperCase();
  const code = upper === 'UK' ? 'GB' : upper;
  return ISO_COUNTRY_CODES.has(code) ? code : undefined;
}
