import { expect, it } from 'vitest';
import type { InactiveMoves, Tooltip } from '@clarity/core';
import { classifyItem, inactiveCategory } from './itemClassification';
import { loadManifestFacts } from './manifestFacts';
import { classifiedCategory, navigationGroups } from '../navigation/catalog';
import { translatableEntry } from '../translations/queue';
import type { EditorData } from '../../stores/data';
import type { Item } from '../../services/generator';

const stamp = { by: 1, at: '2026-11-14T00:00:00Z' };
const item: Item = {
  hash: 9999000,
  name: 'Example',
  categoryId: 'weapon-trait-exotic',
  icon: '',
  inGameDescription: '',
};
const tooltip: Tooltip = {
  hash: item.hash,
  associated: [],
  text: {
    en: { text: 'Retained English', updatedAt: stamp.at, updatedBy: 'alice' },
  },
};
const data = (moves: InactiveMoves): EditorData => ({
  items: { [item.hash]: item },
  aliases: {},
  categories: [],
  bundle: {
    sourceCommit: 'fixture',
    generatedAt: stamp.at,
    tooltips: { [item.hash]: tooltip },
    permissions: { users: {} },
    pushed: {},
    inactiveMoves: moves,
  },
});

it('overrides computed rules and authored text, then restores the native classification', () => {
  const enhanced = { ...item, categoryId: 'weapon-mod-enhanced', baseHash: 9999001 };
  expect(classifyItem(enhanced, tooltip)?.ruleId).toBe('enhanced-mod');
  expect(classifyItem(enhanced, tooltip, { [item.hash]: stamp })).toMatchObject({
    categoryId: inactiveCategory,
    ruleId: 'maintainer-inactive',
    excluded: true,
  });
  expect(classifyItem(enhanced, tooltip, {})).toEqual(classifyItem(enhanced, tooltip));
  const facts = loadManifestFacts();
  const deprecated = Object.entries(facts.items).find(
    ([, fact]) => fact.inventory?.plug?.plugCategoryIdentifier === 'deprecated',
  );
  expect(deprecated).toBeDefined();
  const [hash, fact] = deprecated!;
  const manifestItem = {
    ...item,
    hash: Number(hash),
    name: fact.inventory!.displayName ?? '',
    inGameDescription: fact.inventory!.description ?? '',
  };
  const original = classifyItem(manifestItem);
  expect(original?.categoryId).toBe(inactiveCategory);
  expect(classifyItem(manifestItem, undefined, { [hash]: stamp })?.ruleId).toBe(
    'maintainer-inactive',
  );
  expect(classifyItem(manifestItem, undefined, {})).toEqual(original);
});

it('moves an exotic entry into Inactive in the finder and removes it from translation work', () => {
  const moved = data({ [item.hash]: stamp });
  expect(classifiedCategory(item, moved)?.id).toBe(inactiveCategory);
  const section = navigationGroups(moved, '')
    .flatMap((group) => group.sections)
    .find((group) => group.id === inactiveCategory);
  expect(section?.items.map((entry) => entry.hash)).toContain(item.hash);
  expect(translatableEntry(tooltip, moved)).toBeNull();
  const restored = data({});
  expect(classifiedCategory(item, restored)?.id).toBe(item.categoryId);
  expect(translatableEntry(tooltip, restored)?.hash).toBe(item.hash);
  expect(moved.bundle.tooltips[item.hash]).toBe(tooltip);
});
