/**
 * Exact decimal arithmetic for the oracles of the e2e suites, with BigInt and no library: a quotient of decimals as a plain
 * decimal string, worked out as a fraction. It is the check on the code under test (which uses BigNumber), so it shares
 * nothing with it.
 */

/** `int / 10^scale`. */
interface Decimal {
  int: bigint;
  scale: number;
}

function parse(text: string): Decimal {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new Error(`not a decimal: ${text}`);
  const [, sign, whole, fraction = '', exponent = '0'] = m;
  const int = BigInt(`${whole || '0'}${fraction}`);
  return { int: sign === '-' ? -int : int, scale: fraction.length - Number(exponent) };
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
const pow10 = (n: number): bigint => 10n ** BigInt(n);
const digitsOf = (n: bigint): number => n.toString().length;

/** `q / 10^shift` as a plain decimal string, the trailing zeros of the fraction dropped. */
function shifted(q: bigint, shift: number): string {
  const negative = q < 0n;
  const digits = (negative ? -q : q).toString();
  let text: string;
  if (shift <= 0) text = digits === '0' ? '0' : digits + '0'.repeat(-shift);
  else {
    const padded = digits.padStart(shift + 1, '0');
    const fraction = padded.slice(padded.length - shift).replace(/0+$/, '');
    text =
      fraction === ''
        ? padded.slice(0, padded.length - shift)
        : `${padded.slice(0, padded.length - shift)}.${fraction}`;
  }
  return negative ? `-${text}` : text;
}

/** The reduced fraction `factors[0] * factors[1] * ... / divisor`, its denominator positive. */
function fraction(factors: string[], divisor: string): { num: bigint; den: bigint; negative: boolean } {
  const parts = factors.map(parse);
  const d = parse(divisor);
  if (d.int === 0n) throw new Error('division by zero');
  let num = parts.reduce((n, p) => n * p.int, 1n);
  let den = d.int;
  const scaleOfNum = parts.reduce((n, p) => n + p.scale, 0);
  // (num / 10^a) / (den / 10^b) = num * 10^b / (den * 10^a)
  if (d.scale >= scaleOfNum) num *= pow10(d.scale - scaleOfNum);
  else den *= pow10(scaleOfNum - d.scale);
  const negative = num < 0n !== den < 0n;
  num = num < 0n ? -num : num;
  den = den < 0n ? -den : den;
  if (num === 0n) return { num, den: 1n, negative: false };
  const g = gcd(num, den);
  return { num: num / g, den: den / g, negative };
}

/** The powers of 2 and 5 of a denominator, or `undefined` when it has another prime factor (the quotient does not end). */
function twosAndFives(den: bigint): { twos: number; fives: number } | undefined {
  let rest = den;
  let twos = 0;
  let fives = 0;
  while (rest % 2n === 0n) ((rest /= 2n), twos++);
  while (rest % 5n === 0n) ((rest /= 5n), fives++);
  return rest === 1n ? { twos, fives } : undefined;
}

/** Whether `factors / divisor` ends as a decimal: its reduced denominator has no prime factor but 2 and 5. */
export function quotientEnds(factors: string[], divisor: string): boolean {
  return twosAndFives(fraction(factors, divisor).den) !== undefined;
}

/**
 * `factors[0] * factors[1] * ... / divisor` as a plain decimal. The fraction is reduced: when its denominator has no prime
 * factor but 2 and 5 the quotient ends and is returned whole, whatever the number of its digits; otherwise it is rounded
 * (half up) to `digits` significant digits.
 */
export function decimalQuotient(factors: string[], divisor: string, digits = 30): string {
  const { num, den, negative } = fraction(factors, divisor);
  if (num === 0n) return '0';
  const sign = negative ? '-' : '';
  const ends = twosAndFives(den);
  if (ends !== undefined) {
    const places = Math.max(ends.twos, ends.fives);
    return sign + shifted(num * 2n ** BigInt(places - ends.twos) * 5n ** BigInt(places - ends.fives), places);
  }

  // it does not end: `digits` significant digits, the next one decides the last
  let t = digits - 1 - (digitsOf(num) - digitsOf(den));
  const floorAt = (at: number): bigint => (at >= 0 ? (num * pow10(at)) / den : num / (den * pow10(-at)));
  while (floorAt(t) >= pow10(digits)) t--;
  while (floorAt(t) < pow10(digits - 1)) t++;
  const scaledNum = t >= 0 ? num * pow10(t) : num;
  const scaledDen = t >= 0 ? den : den * pow10(-t);
  return sign + shifted((2n * scaledNum + scaledDen) / (2n * scaledDen), t);
}
