import { describe, expect, it } from 'vitest';
import { parseMarkup, type Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import {
  editableOverrides,
  enhancedPairs,
  enhancedRender,
  enhancedVariants,
  isBlankCopy,
  isEnhancedPair,
  previewedVariants,
  storedFormVariants,
  variantForm,
  variantMatchesBase,
} from './variants';

const stamp = { updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'x' };
const tip = (hash: number, text: Record<string, string>): Tooltip => ({
  hash,
  associated: [],
  text: Object.fromEntries(
    Object.entries(text).map(([lang, value]) => [lang, { text: value, ...stamp }]),
  ),
});
const item = (hash: number, categoryId: string, extra = {}) => ({
  hash,
  name: `Item ${hash}`,
  icon: '',
  categoryId,
  inGameDescription: '',
  ...extra,
});

const BASE = 'Deals #e${1+#d} damage.\n\nenhanced (\n#e Bonus\n)';
function build(tooltips: Tooltip[], aliases = {}, extraItems = {}): EditorData {
  return {
    categories: [
      { id: 'trait', label: 'Trait', group: 'W', order: 1, legacyType: 'Weapon Trait' },
      {
        id: 'enhanced',
        label: 'Enhanced',
        group: 'W',
        order: 2,
        legacyType: 'Weapon Trait Enhanced',
      },
      { id: 'origin', label: 'Origin', group: 'W', order: 3, legacyType: 'Weapon Trait Origin' },
      { id: 'frame', label: 'Frame', group: 'W', order: 4, legacyType: 'Weapon Frame' },
    ],
    items: {
      10: item(10, 'trait'),
      11: item(11, 'enhanced', { baseHash: 10 }),
      12: item(12, 'enhanced', { baseHash: 10 }),
      13: item(13, 'enhanced', { baseHash: 10 }),
      ...extraItems,
    },
    aliases,
    bundle: {
      sourceCommit: 'x',
      generatedAt: '2026-11-01T00:00:00Z',
      tooltips: Object.fromEntries(tooltips.map((tooltip) => [tooltip.hash, tooltip])),
      permissions: { users: {} },
      pushed: {},
    },
  } as unknown as EditorData;
}

describe('variants', () => {
  const data = build([
    tip(2, { en: '' }),
    tip(3, { en: '' }),
    tip(10, { en: BASE, de: 'Verursacht #e${1+#d} Schaden.' }),
    tip(11, { en: 'import main from 10', de: 'import main from 10' }),
    tip(12, { en: 'Adhesive text of its own', de: 'Verursacht #e${1+#d} Schaden.' }),
  ]);

  it('lists the variants of a base, from any of its hashes, without the base', () => {
    expect(enhancedVariants(10, data)).toEqual([11, 12, 13]);
    expect(enhancedVariants(11, data)).toEqual([11, 12, 13].filter((hash) => hash !== 10));
    expect(enhancedVariants(404, data)).toEqual([]);
  });

  it('is derived when the stored text imports the base, in every language', () => {
    expect(variantForm(10, 11, data)).toBe('derived');
  });

  it('is an override when any language has text of its own', () => {
    expect(variantForm(10, 12, data)).toBe('override');
    // English alone differs; German renders like the base.
    expect(variantMatchesBase(10, 12, 'en', data)).toBe(false);
    expect(variantMatchesBase(10, 12, 'de', data)).toBe(true);
  });

  it('is an override when empty over a base that has text, and derived when both are empty', () => {
    expect(variantForm(10, 13, data)).toBe('override');
    const empty = build([tip(2, {}), tip(3, {}), tip(10, {}), tip(11, {})]);
    expect(variantForm(10, 11, empty)).toBe('derived');
  });

  it('treats text that differs only in how it is written as derived when it renders the same', () => {
    const same = build([
      tip(2, { en: '' }),
      tip(3, { en: '' }),
      tip(10, { en: 'Plain text' }),
      tip(11, { en: 'Plain text\n// a comment' }),
    ]);
    expect(variantForm(10, 11, same)).toBe('derived');
  });

  it('reads the base with the variant type: enhanced blocks survive only for the enhanced type', () => {
    const derived = enhancedRender(10, 11, 'en', data);
    expect(derived).toEqual({ text: BASE, type: 'Weapon Trait Enhanced', form: 'derived' });
    const override = enhancedRender(10, 12, 'en', data);
    expect(override).toEqual({
      text: 'Adhesive text of its own',
      type: 'Weapon Trait Enhanced',
      form: 'override',
    });
    // The same base text renders differently under the two types, which is why derived uses the variant's.
    const lines = (type: string) =>
      JSON.stringify(parseMarkup(BASE, { variables: '', titles: '', type }).lines);
    expect(lines(derived.type!)).toContain('Bonus');
    expect(lines('Weapon Trait')).not.toContain('Bonus');
  });

  it('keeps frame groups and aliases out of the variant list', () => {
    const frames = build(
      [tip(2, {}), tip(3, {}), tip(10, { en: 'Frame' })],
      {
        11: { to: 10, kind: 'frame' },
        12: { to: 10, kind: 'frame' },
        99: { to: 10, kind: 'sandbox' },
      },
      { 11: item(11, 'frame'), 12: item(12, 'frame', { baseHash: 10 }), 13: item(13, 'frame') },
    );
    // A frame group owns one editor: its members are aliases, never variants.
    expect(enhancedVariants(10, frames)).toEqual([]);
    expect(enhancedVariants(11, frames)).toEqual([]);
    expect(enhancedVariants(99, frames)).toEqual([]);
  });

  it('resolves a sandbox alias of a variant to its base', () => {
    const aliased = build([tip(10, {})], { 99: { to: 11, kind: 'sandbox' } });
    expect(enhancedVariants(99, aliased)).toEqual([11, 12, 13]);
  });
});

describe('enhanced pairs, override candidates and blank copies', () => {
  // 11 derives from 10; 12 keeps text of its own; 13 is a blank same-name copy; 14 is a same-type
  // copy (a weapon-perk duplicate) with identical text; 15 is a same-type copy with its own text.
  const data = build(
    [
      tip(2, { en: '' }),
      tip(3, { en: '' }),
      tip(10, { en: BASE, de: 'Verursacht #e${1+#d} Schaden.' }),
      tip(11, { en: 'import main from 10', de: 'import main from 10' }),
      tip(12, { en: 'Adhesive text of its own', de: 'Verursacht #e${1+#d} Schaden.' }),
      tip(13, { en: '' }),
      tip(14, { en: BASE, de: 'Verursacht #e${1+#d} Schaden.' }),
      tip(15, { en: 'A copy with its own words' }),
    ],
    {},
    {
      13: item(13, 'trait', { baseHash: 10 }),
      14: item(14, 'trait', { baseHash: 10 }),
      15: item(15, 'trait', { baseHash: 10 }),
    },
  );

  it('counts only the base + " Enhanced" category as an enhanced pair', () => {
    expect([11, 12].map((variant) => isEnhancedPair(10, variant, data))).toEqual([true, true]);
    expect([13, 14, 15].map((variant) => isEnhancedPair(10, variant, data))).toEqual([
      false,
      false,
      false,
    ]);
    expect(enhancedPairs(10, data)).toEqual([11, 12]);
    // From the variant's own hash too, and for a base with none.
    expect(enhancedPairs(11, data)).toEqual([11, 12]);
    expect(enhancedPairs(404, data)).toEqual([]);
  });

  it('never calls an exotic frame or origin trait variant an enhanced pair', () => {
    const frames = build(
      [tip(2, { en: '' }), tip(3, { en: '' }), tip(20, { en: 'x' }), tip(21, { en: 'y' })],
      {},
      {
        20: item(20, 'frame'),
        21: item(21, 'frame', { baseHash: 20 }),
        22: item(22, 'origin', { baseHash: 20 }),
      },
    );
    expect(enhancedPairs(20, frames)).toEqual([]);
    expect(enhancedVariants(20, frames)).toEqual([21, 22]);
  });

  it('treats a variant with no text in any language while its base has some as a blank copy', () => {
    expect([11, 12, 13, 14, 15].map((variant) => isBlankCopy(10, variant, data))).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
    // Both empty is not a blank copy of anything.
    const empty = build([
      tip(2, { en: '' }),
      tip(3, { en: '' }),
      tip(10, { en: '' }),
      tip(13, { en: '' }),
    ]);
    expect(isBlankCopy(10, 13, empty)).toBe(false);
  });

  it('offers Edit override only for variants with text of their own, never for blank copies', () => {
    expect(variantForm(10, 13, data)).toBe('override');
    expect(editableOverrides(10, data)).toEqual([12, 15]);
  });

  it('lists Stored form only for derived enhanced pairs', () => {
    expect(storedFormVariants(10, data)).toEqual([11]);
  });

  it('previews the enhanced pairs and editable overrides, not blank or identical copies', () => {
    expect(previewedVariants(10, data)).toEqual([11, 12, 15]);
  });
});
