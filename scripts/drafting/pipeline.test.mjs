import { expect, it } from 'vitest';
import * as core from '../../packages/core/src/index.ts';
import { tooltipImports } from '../../apps/web/src/services/tooltipImports.ts';
import {
  baseExoticFor,
  groupFor,
  numbers,
  sampleHtml,
  validateDraft,
  buildInputs,
  ownerExcludedHashes,
} from './pipeline.mjs';
import { guidedFixture } from '../../apps/web/test/guided-fixture.ts';
import { reviewEvidence } from '../../apps/web/src/features/compendium/reviewQueue.ts';
import { proposalFor } from '../../apps/web/src/features/compendium/rapidReview.ts';
import { emptyProgress } from '../../apps/web/src/features/compendium/reviewProgress.ts';
import { displayMatches } from '../../apps/web/src/features/compendium/displayMatches.ts';
import { canonicalHash, itemFor } from '../../apps/web/src/features/navigation/catalog.ts';
import { matchLocation } from '../../apps/web/src/features/compendium/sourceLocation.ts';
import { rangeText } from '../../apps/web/src/services/editorDrafts.ts';
import approved from '../../apps/web/src/features/compendium/approved-guidance.v1.json';

const app = {
  ...core,
  tooltipImports,
  reviewEvidence,
  proposalFor,
  emptyProgress,
  displayMatches,
  canonicalHash,
  itemFor,
  matchLocation,
  rangeText,
  scope: approved.scope,
};
const editor = { items: {}, aliases: {}, bundle: { tooltips: {} } };
const item = {
  hash: 100,
  category: 'armor-trait-exotic-class-item',
  source: { text: 'Grants 12% damage for 5 seconds.' },
  baseExotic: { english: 'Grants 99% damage.' },
};
it('allows enhanced pairs in catalog-confirmed mod categories and excludes unused owner hashes', () => {
  const mod = {
    ...item,
    category: 'weapon-mod',
    source: { text: 'Refills 50% ↑60% of Magazine.' },
    enhancedCategory: true,
  };
  const explained =
    'Refills {{50%}{60%}} of the magazine.\n\nenhanced (\n<enhanced/> Refill amount is increased (50%<arrow/>60%).\n)';
  expect(validateDraft(mod, explained, editor, app)).toEqual([]);
  expect(validateDraft(mod, 'Refills {{50%}{60%}} of the magazine.', editor, app)).toContain(
    'Style: enhanced value needs a separate enhanced-only explanation',
  );
  expect(
    validateDraft(
      mod,
      explained.replace('is increased (50%<arrow/>60%)', 'is increased to 60%'),
      editor,
      app,
    ),
  ).toContain('Style: enhanced explanation must state the change, not only the result');
  expect(
    validateDraft(
      { ...mod, enhancedCategory: false },
      'Refills {{50%}{60%}} of the magazine.',
      editor,
      app,
    ),
  ).toContain('Enhanced markup outside an enhanced-capable category');
  expect([...ownerExcludedHashes]).toEqual([2077016094, 2733010662, 2734970071, 3458160468]);
});
it('compares complete number tokens and never borrows class-item values from the base exotic', () => {
  expect([...numbers('12% 1.25x <title refill [G_100] /> #Chunk2')]).toEqual(['12', '1.25']);
  expect([...numbers('x10 [x5] Slow Stacks')]).toEqual(['10', '5']);
  expect([...numbers('1,574 damage, 1,202.5 HP, and 1,2 tiers')]).toEqual([
    '1574',
    '1202.5',
    '1',
    '2',
  ]);
  expect(validateDraft(item, 'Grants 2% damage.', editor, app)).toContain('Unsupported number: 2');
  expect(validateDraft(item, 'Grants 99% damage.', editor, app)).toContain(
    'Unsupported number: 99',
  );
  expect(validateDraft(item, 'Grants 12% damage for 5 seconds.', editor, app)).toEqual([]);
});
it('rejects parser errors, retired markup, invented names, and enhanced markup in unsupported categories', () => {
  expect(validateDraft(item, '<blue damage />', editor, app)).toContain('Retired markup');
  expect(validateDraft(item, '<yellow Imaginary Gun />', editor, app)).toContain(
    'Unsupported item name: Imaginary Gun',
  );
  expect(validateDraft(item, '{{12}{5}}', editor, app)).toContain(
    'Enhanced markup outside an enhanced-capable category',
  );
  expect(validateDraft(item, '\uE000', editor, app).length).toBeGreaterThan(0);
});
it('accepts only the guide-derived metric, value, and uncertainty together', () => {
  const input = {
    ...item,
    source: {
      text: 'Grants 0.6?x Ready Duration Multiplier, 0.8x Accuracy Cone Size, and 0.9x Reload Duration Multiplier.',
    },
  };
  expect(
    validateDraft(
      input,
      'Grants 40?% decreased Ready Animation Duration, 20% decreased Accuracy Cone Size, and 10% decreased Reload Animation Duration.',
      editor,
      app,
    ),
  ).toEqual([]);
  for (const text of [
    '40% decreased Ready Animation Duration.',
    '40?% decreased Damage.',
    '40? damage.',
    '41?% decreased Ready Animation Duration.',
    '20% decreased Accuracy Cone Size. Deals 20 damage.',
  ]) {
    expect(
      validateDraft(input, text, editor, app).some((error) =>
        error.startsWith('Unsupported number:'),
      ),
    ).toBe(true);
  }
});
it('accepts explicit numeric owner corrections without borrowing timestamp numbers', () => {
  const corrected = {
    ...item,
    ownerFeedback: {
      verdict: 'change',
      note: 'with 1|2|3 mods equipped',
      at: '2099-01-01T00:00:00Z',
    },
  };
  expect(
    validateDraft(corrected, 'Grants 12% damage with 1|2|3 mods equipped.', editor, app),
  ).toEqual([]);
  expect(validateDraft(corrected, 'Grants 2099% damage.', editor, app)).toContain(
    'Unsupported number: 2099',
  );
});
it('keeps stored drafts as plain text rather than HTML-escaped presentation strings', () => {
  expect(validateDraft(item, "Your weapon's damage.", editor, app)).toEqual([]);
  for (const escaped of ['&#x27;', '&#39;', '&apos;', '&amp;'])
    expect(validateDraft(item, `Your weapon${escaped}s damage.`, editor, app)).toContain(
      'HTML entities in draft text; use raw characters',
    );
});
it('licenses fragment result arithmetic only for verified pairs in this source', () => {
  const input = {
    ...item,
    source: { text: 'Field lasts 7+2 seconds.' },
    fragmentImprovements: [
      {
        fragment: 'Whisper of Durance',
        base: 7,
        bonus: 2,
        total: 9,
        sourceText: 'Durance extends this field.',
      },
    ],
  };
  expect(
    validateDraft(input, 'Field lasts 7s (9 with <stasis Whisper of Durance />).', editor, app),
  ).toEqual([]);
  expect(validateDraft(input, 'Deals 9 damage.', editor, app)).toContain('Unsupported number: 9');
  expect(
    validateDraft(
      { ...input, fragmentImprovements: [] },
      'Field lasts 7s (9 with <stasis Whisper of Durance />).',
      editor,
      app,
    ),
  ).toContain('Unsupported number: 9');
});
it('licenses percentage-of-normal ratios without licensing the number as unrelated damage', () => {
  const ratio = { ...item, source: { text: 'Minimum damage is 0.33x damage.' } };
  expect(validateDraft(ratio, 'Damage falls off to 33% of normal damage.', editor, app)).toEqual(
    [],
  );
  expect(validateDraft(ratio, 'Deals 33 damage.', editor, app)).toContain('Unsupported number: 33');
  const rates = { ...item, source: { text: 'Rates 1.16x, 1.64x, 2.6x, and 0.7x.' } };
  expect(
    validateDraft(
      rates,
      'Regenerates at 116%|164%|260% of normal rate. Scaled to 70% of its normal rate.',
      editor,
      app,
    ),
  ).toEqual([]);
  expect(validateDraft(rates, 'Restores 116 HP.', editor, app)).toContain(
    'Unsupported number: 116',
  );
  expect(validateDraft(rates, 'Scaled to 70% of the normal rate.', editor, app)).toEqual([]);
});
it('binds every converted range endpoint to the source metric and uncertainty', () => {
  const range = { ...item, source: { text: '0.85x–0.9x Draw Time Multiplier.' } };
  expect(validateDraft(range, '10%–15% decreased Draw Time.', editor, app)).toEqual([]);
  expect(validateDraft(range, '10%–16% decreased Draw Time.', editor, app)).toContain(
    'Unsupported number: 16',
  );
  expect(
    validateDraft(range, '10%–15% decreased Draw Time. Deals 15 damage.', editor, app),
  ).toContain('Unsupported number: 15');
});
it('normalizes the explicit duration a second without licensing indefinite counts', () => {
  const duration = { ...item, source: { text: 'Breaks out after a second. Grants a stack.' } };
  expect(validateDraft(duration, 'Breaks out after 1 second.', editor, app)).toEqual([]);
  expect(validateDraft(duration, 'Grants 1 stack.', editor, app)).toContain(
    'Unsupported number: 1',
  );
});
it('preserves an exact parent buff label only with its own sourced DR pair', () => {
  const english = 'Grants <pve 25% /> <pvp [5%] /> Damage Resistance (Resist x2) to you.';
  const input = {
    ...item,
    source: { text: 'Grants 25% [5%] Damage Resist.' },
    baseExotic: { english },
  };
  expect(validateDraft(input, english, editor, app)).toEqual([]);
  expect(validateDraft(input, english.replace('x2', 'x3'), editor, app)).toContain(
    'Unsupported number: 3',
  );
  expect(
    validateDraft(
      { ...input, source: { text: 'Grants 10% [5%] Damage Resist.' } },
      english,
      editor,
      app,
    ),
  ).toContain('Unsupported number: 2');
});
it('licenses explicit stack selectors for a source cap written as xN', () => {
  const input = { ...item, source: { text: 'Up to a maximum of x6 stacks. Grants 70% damage.' } };
  expect(validateDraft(input, 'Grants 70% damage at 1|2|3|4|5|6 stacks.', editor, app)).toEqual([]);
  expect(validateDraft(input, 'Deals 2 damage.', editor, app)).toContain('Unsupported number: 2');
});
it('does not turn an automatic magazine refill into a manual reload claim', () => {
  const refill = { ...item, source: { text: 'Refills 50% of Magazine.' } };
  expect(validateDraft(refill, 'Refills 50% of the magazine.\n\n#Reload', editor, app)).toContain(
    'Unsupported manual-reload claim: source does not say reload',
  );
  expect(validateDraft(refill, 'Refills 50% of the magazine.', editor, app)).toEqual([]);
});
it('recognizes a sourced equipment name despite misplaced possessives', () => {
  const source = {
    ...item,
    source: { text: "Does not work on Young Ahamkara Spine's Tripmines." },
  };
  const catalog = {
    ...editor,
    items: {
      1: { name: 'Wish-Dragon Teeth', itemName: "Young Ahamkara's Spine" },
      2: { name: 'Other Armor' },
    },
  };
  expect(
    validateDraft(source, "Does not work with <yellow Young Ahamkara's Spine />.", catalog, app),
  ).toEqual([]);
  expect(
    validateDraft(source, 'Does not work with <yellow Other Armor />.', catalog, app),
  ).toContain('Unsupported item name: Other Armor');
});
it('recognizes omitted articles but requires complete equipment-name words', () => {
  const catalog = { ...editor, items: { 1: { name: 'The Stag' }, 2: { name: 'The Huckleberry' } } };
  const source = { ...item, source: { text: 'Works with Huckleberry.' } };
  expect(validateDraft(source, 'Works with <yellow The Huckleberry />.', catalog, app)).toEqual([]);
  expect(
    validateDraft(
      { ...source, source: { text: 'Staggers enemies.' } },
      'Works with <yellow The Stag />.',
      catalog,
      app,
    ),
  ).toContain('Unsupported item name: The Stag');
});
it('recognizes a pluralized complete equipment name without permitting substrings', () => {
  const catalog = { ...editor, items: { 1: { name: 'Orpheus Rig' } } };
  const source = { ...item, source: { text: 'Lasts longer with Orpheus Rigs.' } };
  expect(validateDraft(source, 'Lasts longer with <yellow Orpheus Rig />.', catalog, app)).toEqual(
    [],
  );
  expect(
    validateDraft(
      { ...source, source: { text: 'Uses Orpheus Rigging.' } },
      'Lasts longer with <yellow Orpheus Rig />.',
      catalog,
      app,
    ),
  ).toContain('Unsupported item name: Orpheus Rig');
});
it('treats import IDs as references and preserves verbatim owner rewrites', () => {
  expect(validateDraft(item, 'import main from 2724068510', editor, app)).not.toContain(
    'Unsupported number: 2724068510',
  );
  expect(validateDraft(item, 'Deals 2724068510 damage.', editor, app)).toContain(
    'Unsupported number: 2724068510',
  );
  const english = 'The owner supplies this exact sentence. '.repeat(10).trim();
  const corrected = {
    ...item,
    ownerFeedback: { verdict: 'change', note: `Rewritten version:\n${english}` },
  };
  expect(validateDraft(corrected, english, editor, app)).not.toContain('Length sanity');
  expect(validateDraft(corrected, english + ' Changed.', editor, app)).toContain('Length sanity');
});
it('finds base exotic wording through item names and declines ambiguous base identities', () => {
  const e = {
    items: {
      101: {
        hash: 101,
        name: 'Fervid Coldsnap',
        itemName: 'Osmiomancy Gloves',
        categoryId: 'armor-trait-exotic',
      },
    },
    bundle: { tooltips: { 101: { text: { en: { text: 'Base wording' } } } } },
  };
  expect(baseExoticFor({ name: 'Spirit of Osmiomancy' }, e, (h) => h)).toEqual({
    hash: 101,
    name: 'Osmiomancy Gloves',
    english: 'Base wording',
  });
  e.items[102] = { ...e.items[101], hash: 102 };
  expect(baseExoticFor({ name: 'Spirit of Osmiomancy' }, e, (h) => h)).toBeUndefined();
  e.items = {
    101: {
      hash: 101,
      name: 'Wraithmetal Mail',
      itemName: "The Dragon's Shadow",
      categoryId: 'armor-trait-exotic',
    },
    102: {
      hash: 102,
      name: 'Wish-Dragon Teeth',
      itemName: "Young Ahamkara's Spine",
      categoryId: 'armor-trait-exotic',
    },
  };
  expect(baseExoticFor({ name: 'Spirit of the Dragon' }, e, (h) => h)?.hash).toBe(101);
});
it('never admits source identity without a real grid range, and respects saved English', () => {
  const f = guidedFixture();
  const result = buildInputs(f.editor, f.source, 'a'.repeat(40), app);
  expect(result.items).toEqual([]);
  f.editor.bundle.tooltips[100] = { hash: 100, text: { en: { text: 'Existing' } }, associated: [] };
  expect(buildInputs(f.editor, f.source, 'a'.repeat(40), app).counts['Weapon Perks'].hasText).toBe(
    1,
  );
});
it('excludes all Exotic Weapon categories and escapes review-page source content', () => {
  expect(groupFor('weapon-trait-exotic')).toBe('Exotic Weapons');
  const html = sampleHtml(
    [
      {
        ...item,
        name: '<script>',
        group: 'Subclass',
        source: { tab: 'Stasis', gid: '1', range: 'C2', text: '</pre><script>alert(1)</script>' },
      },
    ],
    { 100: '<solar Freeze />' },
    {},
  );
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;solar Freeze /&gt;');
});
