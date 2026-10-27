import { cleanTomlText } from './toml-text';

describe('cleanTomlText', () => {
  it('trims and turns every run of white space into one space', () =>
    expect(cleanTomlText('  Northpeak\tTreasury \n', 64)).toBe('Northpeak Treasury'));

  it('removes a bidirectional override (Cf)', () => expect(cleanTomlText('North\u202Epeak', 64)).toBe('Northpeak'));

  it('removes Cf and Cc characters and collapses the spaces around them', () =>
    expect(cleanTomlText('a \u200E b\u0007c', 64)).toBe('a bc'));

  it('treats NBSP and the byte order mark as white space, not as characters to remove', () =>
    expect(cleanTomlText('a\u00A0\uFEFFb', 64)).toBe('a b'));

  it('composes to NFC: a decomposed e with an acute accent is one code point', () => {
    const decomposed = 'e\u0301';
    expect([...decomposed]).toHaveLength(2);
    expect(cleanTomlText(decomposed, 1)).toBe('\u00E9');
  });

  it('keeps a text of exactly max code points and refuses one code point more, cutting nothing', () =>
    expect([cleanTomlText('x'.repeat(64), 64), cleanTomlText('x'.repeat(65), 64)]).toEqual([
      'x'.repeat(64),
      undefined,
    ]));

  it('counts code points, not UTF-16 units', () =>
    expect(cleanTomlText('\u{1F600}'.repeat(64), 64)).toBe('\u{1F600}'.repeat(64)));

  it('measures the length after the cleaning', () =>
    expect(cleanTomlText(`  ${'x'.repeat(9)}\u0007  `, 9)).toBe('x'.repeat(9)));

  it('names no text for an empty one, one of only controls and white space, or a value that is not a string', () =>
    expect([
      cleanTomlText('', 9),
      cleanTomlText(' \u0007 ', 9),
      cleanTomlText(42, 9),
      cleanTomlText(undefined, 9),
    ]).toEqual([undefined, undefined, undefined, undefined]));
});
