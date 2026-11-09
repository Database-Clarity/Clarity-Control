import { describe, expect, it } from 'vitest';
import { requireEnglish } from './requireEnglish';

describe('requireEnglish (editor empty-English diagnostic)', () => {
  it('stays quiet on an untouched, unwritten English', () => {
    expect(requireEnglish(123, 'en', '', '')).toBe(false);
  });
  it('stays quiet while typing over unwritten English, and after clearing back to it', () => {
    expect(requireEnglish(123, 'en', '', 'Typed')).toBe(false);
    expect(requireEnglish(123, 'en', '', '')).toBe(false);
  });
  it('reports blank text edited over unwritten English, as saving does', () => {
    expect(requireEnglish(123, 'en', '', '  ')).toBe(true);
    expect(requireEnglish(123, 'en', '  ', '  ')).toBe(false);
    expect(requireEnglish(123, 'en', '  ', '')).toBe(true);
  });
  it('requires written English, so clearing it (or undoing back to blank) is an error', () => {
    expect(requireEnglish(123, 'en', 'Saved', 'Saved')).toBe(true);
    expect(requireEnglish(123, 'en', 'Saved', '')).toBe(true);
  });
  it('is constant for translations and exempts the reserved global documents', () => {
    expect(requireEnglish(123, 'fr', '', '')).toBe(true);
    expect(requireEnglish(2, 'en', 'x', '')).toBe(false);
    expect(requireEnglish(3, 'en', '', '')).toBe(false);
  });
});
