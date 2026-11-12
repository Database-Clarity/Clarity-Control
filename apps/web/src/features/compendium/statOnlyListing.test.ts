import { expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import fixture from './fixtures/stat-only-census.json';
import {
  attachmentCategory,
  classifyItem,
  describesEffect,
  effectCategory,
  listingCategoryId,
} from './itemClassification';
import { loadManifestFacts } from './manifestFacts';
import { navigationGroups } from '../navigation/catalog';
import type { EditorData } from '../../stores/data';
import type { Item } from '../../services/generator';

// Real records from the live catalogue (owner 2026-11-11: Balanced Tang and Combat Sights were
// listed as Stat-only Parts although they are effect perks of their exotic weapons).
const items = fixture.items as unknown as Record<string, Item>;
const expected = fixture.expected as Record<
  string,
  { before: string; listed: string; ruleId: string; excluded: boolean; group: string }
>;
const saved = (hash: number): Tooltip => ({
  hash,
  text: fixture.savedText.includes(hash)
    ? { en: { text: 'Saved text', updatedAt: '2026-11-11T00:00:00Z', updatedBy: 'fixture' } }
    : {},
  associated: [],
});
const listed = (hash: number, tooltip = saved(hash)) =>
  listingCategoryId(items[hash], classifyItem(items[hash], tooltip));

it('keeps census listings while superseding exotic part tooltip scope', () => {
  for (const [hash, want] of Object.entries(expected)) {
    const c = classifyItem(items[hash], saved(Number(hash)));
    expect(listed(Number(hash)), items[hash].name).toBe(want.listed);
    expect({ ruleId: c?.ruleId, excluded: c?.excluded }, items[hash].name).toEqual({
      ruleId:
        want.ruleId === 'manifest-weapon-stat' && fixture.savedText.includes(Number(hash))
          ? 'exotic-part-no-weapon-row'
          : want.ruleId,
      excluded:
        want.ruleId === 'manifest-weapon-stat' && fixture.savedText.includes(Number(hash))
          ? false
          : want.excluded,
    });
  }
  const groups = Object.values(expected).reduce<Record<string, number>>((n, e) => {
    n[e.group] = (n[e.group] ?? 0) + 1;
    return n;
  }, {});
  expect(groups).toEqual({ moved: 17, unchanged: 20, 'owner-kept': 7 });
});

it('keeps exotic weapon parts under their weapon, also with an editor category override', () => {
  for (const hash of [3514694513, 1408087974]) {
    const item = items[hash];
    expect(item.categoryId).toBe('weapon-perk-exotic');
    // Saved text supersedes the historic stat-only exception and needs source review.
    expect(classifyItem(item, saved(hash))).toMatchObject({
      categoryId: effectCategory,
      ruleId: 'exotic-part-no-weapon-row',
      excluded: false,
    });
    // ...but the finder lists it with its weapon, never in Stat-only Parts or Parts with Effects.
    expect(listed(hash)).toBe('weapon-perk-exotic');
    for (const categoryId of [attachmentCategory, effectCategory])
      expect(listed(hash, { ...saved(hash), custom: { name: item.name, categoryId } })).toBe(
        'weapon-perk-exotic',
      );
  }
  const data = {
    categories: [
      { id: 'weapon-perk-exotic', label: 'Exotic Weapon Parts', group: 'Weapons', order: 152 },
    ],
    items,
    aliases: {},
    bundle: { tooltips: { 3514694513: saved(3514694513), 1408087974: saved(1408087974) } },
  } as unknown as EditorData;
  const sections = navigationGroups(data, '').flatMap((group) => group.sections);
  const section = (id: string) => sections.find((s) => s.id === id)?.items.map((i) => i.hash);
  expect(section('exotic-weapons')).toEqual(expect.arrayContaining([3514694513, 1408087974]));
  expect(section(attachmentCategory)).not.toContain(3514694513);
  expect(section(attachmentCategory)).not.toContain(1408087974);
  expect(items[3514694513].itemName).toBe('Praxic Blade');
  expect(items[1408087974].itemName).toBe('The Queenbreaker');
});

it('never infers stat-only for manifest effect wording (Phase Magazine)', () => {
  const facts = loadManifestFacts();
  const phase = items[830282363];
  expect(describesEffect(facts.items[830282363].inventory!.description ?? '')).toBe(true);
  expect(classifyItem(phase)).toMatchObject({
    categoryId: effectCategory,
    ruleId: 'attachment-evidence-needed',
    excluded: false,
  });
  // Stat wording and flavour lead-ins of the genuinely stat-only spot list never count as effects.
  for (const [hash, want] of Object.entries(expected))
    if (want.group === 'unchanged')
      expect(
        describesEffect(facts.items[hash].inventory!.description ?? ''),
        items[hash].name,
      ).toBe(false);
});

it('never lists a manifest stat-only part with tooltip text as stat-only', () => {
  const rod = items[5699512];
  const text: Tooltip = {
    ...saved(5699512),
    text: { en: { text: 'Text', updatedAt: '2026-11-11T00:00:00Z', updatedBy: 'fixture' } },
  };
  expect(classifyItem(rod, saved(5699512))).toMatchObject({
    categoryId: attachmentCategory,
    ruleId: 'weapon-attachment',
  });
  expect(classifyItem(rod, text)).toMatchObject({
    categoryId: effectCategory,
    ruleId: 'attachment-saved-text',
    excluded: false,
    priority: 'required',
  });
  // An editor can still demote it explicitly; owner decisions are never overridden by text.
  expect(
    classifyItem(rod, { ...text, custom: { name: rod.name, categoryId: attachmentCategory } }),
  ).toMatchObject({ categoryId: attachmentCategory, origin: 'editor' });
  const honed = items[2827049491];
  expect(
    classifyItem(honed, {
      ...saved(2827049491),
      text: { en: { text: 'Text', updatedAt: '2026-11-11T00:00:00Z', updatedBy: 'fixture' } },
    }),
  ).toMatchObject({ categoryId: attachmentCategory, origin: 'owner' });
});
