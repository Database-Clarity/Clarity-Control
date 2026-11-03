import { describe, expect, it } from 'vitest';
import { defaultMode, effectiveMode, previewedHashes } from './previewMode';

describe('preview modes', () => {
  it('defaults to Compare on a desktop and Enhanced on a phone', () => {
    expect(defaultMode(false)).toBe('compare');
    expect(defaultMode(true)).toBe('enhanced');
  });

  it('keeps an item with no enhanced version on its Base, whatever was chosen', () => {
    expect(effectiveMode('compare', false, false)).toBe('base');
    expect(effectiveMode(null, true, false)).toBe('base');
    expect(effectiveMode(null, false, true)).toBe('compare');
    expect(effectiveMode('base', true, true)).toBe('base');
  });

  describe('what counts as previewed', () => {
    const derived = { hash: 11, derived: true };
    const override = { hash: 12, derived: false };
    it('is the base for Base and for a derived Enhanced, which is the base text', () => {
      expect(previewedHashes('base', 10, derived)).toEqual([10]);
      expect(previewedHashes('enhanced', 10, derived)).toEqual([10]);
    });
    it('is the override itself for an override Enhanced', () => {
      expect(previewedHashes('enhanced', 10, override)).toEqual([12]);
    });
    it('is nothing for Compare, a working view and never a render a consumer sees', () => {
      expect(previewedHashes('compare', 10, derived)).toEqual([]);
      expect(previewedHashes('compare', 10, override)).toEqual([]);
      expect(previewedHashes('compare', 10, undefined)).toEqual([]);
    });
  });
});
