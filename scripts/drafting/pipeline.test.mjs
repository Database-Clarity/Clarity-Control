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
it('compares complete number tokens and never borrows class-item values from the base exotic', () => {
  expect([...numbers('12% 1.25x <title refill [G_100] /> #Chunk2')]).toEqual(['12', '1.25']);
  expect([...numbers('x10 [x5] Slow Stacks')]).toEqual(['10', '5']);
  expect(validateDraft(item, 'Grants 2% damage.', editor, app)).toContain('Unsupported number: 2');
  expect(validateDraft(item, 'Grants 99% damage.', editor, app)).toContain(
    'Unsupported number: 99',
  );
  expect(validateDraft(item, 'Grants 12% damage for 5 seconds.', editor, app)).toEqual([]);
});
it('rejects parser errors, retired markup, invented exotic names, and non-trait enhanced markup', () => {
  expect(validateDraft(item, '<blue damage />', editor, app)).toContain('Retired markup');
  expect(validateDraft(item, '<yellow Imaginary Gun />', editor, app)).toContain(
    'Unsupported item name: Imaginary Gun',
  );
  expect(validateDraft(item, '{{12}{5}}', editor, app)).toContain(
    'Enhanced markup outside weapon-trait',
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
  const corrected = { ...item, ownerFeedback: { verdict: 'change', note: 'with 1|2|3 mods equipped', at: '2099-01-01T00:00:00Z' } };
  expect(validateDraft(corrected, 'Grants 12% damage with 1|2|3 mods equipped.', editor, app)).toEqual([]);
  expect(validateDraft(corrected, 'Grants 2099% damage.', editor, app)).toContain('Unsupported number: 2099');
});
it('keeps stored drafts as plain text rather than HTML-escaped presentation strings', () => {
  expect(validateDraft(item, "Your weapon's damage.", editor, app)).toEqual([]);
  for (const escaped of ['&#x27;', '&#39;', '&apos;', '&amp;'])
    expect(validateDraft(item, `Your weapon${escaped}s damage.`, editor, app)).toContain('HTML entities in draft text; use raw characters');
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
