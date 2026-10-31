import { resolveAlias, type Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Category, Item } from '../../services/generator';

export function canonicalHash(hash: number, data: EditorData): number {
  const seen = new Set<number>();
  while (!seen.has(hash)) {
    seen.add(hash);
    const resolved = resolveAlias(hash, data.aliases);
    if (resolved !== hash) {
      hash = resolved;
      continue;
    }
    const item = data.items[hash];
    // A grouped frame owns one editor even if manifest pairing points elsewhere.
    if (frameGroupSize(hash, data) > 1) return hash;
    const target = item?.baseHash;
    if (target === undefined) return hash;
    hash = target;
  }
  throw new Error(`Cyclic tooltip alias at ${hash}`);
}

export function tooltipFor(hash: number, data: EditorData): Tooltip {
  return data.bundle.tooltips[hash] ?? { hash, text: {}, associated: [] };
}

export function itemFor(hash: number, data: EditorData): Item | undefined {
  const item = data.items[hash];
  if (item) return item;
  const custom = data.bundle.tooltips[hash]?.custom;
  if (!custom) return undefined;
  return { hash, ...custom, icon: '', inGameDescription: '' };
}

/** "Shared perk — used on: A, B" for perks owned by 2+ exotics; undefined otherwise. */
export function sharedPerkLabel(hash: number, data: EditorData): string | undefined {
  const owners = data.items[hash]?.owners;
  if (!owners || owners.length < 2) return undefined;
  const names = owners.map((owner) => itemFor(owner, data)?.name ?? String(owner));
  return `Shared perk — used on: ${names.join(', ')}`;
}

const variants = new WeakMap<EditorData, Map<number, number[]>>();
export function variantHashes(hash: number, data: EditorData): number[] {
  let index = variants.get(data);
  if (!index) {
    index = new Map<number, number[]>();
    for (const item of Object.values(data.items)) {
      if (resolveAlias(item.hash, data.aliases) !== item.hash) continue;
      const base = canonicalHash(item.hash, data);
      const hashes = index.get(base) ?? [base];
      hashes.push(item.hash);
      index.set(base, hashes);
    }
    for (const [base, hashes] of index) index.set(base, [...new Set(hashes)]);
    variants.set(data, index);
  }
  return index.get(hash) ?? [hash];
}

const frameCounts = new WeakMap<EditorData, Map<number, number>>();
export function frameGroupSize(hash: number, data: EditorData): number {
  let counts = frameCounts.get(data);
  if (!counts) {
    counts = new Map();
    for (const [alias, entry] of Object.entries(data.aliases)) {
      if (entry.kind !== 'frame') continue;
      const target = resolveAlias(Number(alias), data.aliases);
      counts.set(target, (counts.get(target) ?? 1) + 1);
    }
    frameCounts.set(data, counts);
  }
  return counts.get(hash) ?? 1;
}

export interface CategorySection extends Category {
  items: Item[];
}
export interface CategoryGroup {
  name: string;
  sections: CategorySection[];
}

export function navigationGroups(data: EditorData, query: string): CategoryGroup[] {
  const search = query.trim().toLocaleLowerCase();
  const matchingAliases = new Set<number>();
  if (search) {
    for (const alias of Object.keys(data.aliases)) {
      if (alias.includes(search) || data.items[alias]?.name.toLocaleLowerCase().includes(search)) {
        matchingAliases.add(canonicalHash(Number(alias), data));
      }
    }
  }
  const items = Object.values(data.items)
    .concat(
      Object.values(data.bundle.tooltips)
        .filter((tooltip) => !data.items[tooltip.hash] && tooltip.custom)
        .map((tooltip) => itemFor(tooltip.hash, data)!),
    )
    .filter(
      (item) =>
        canonicalHash(item.hash, data) === item.hash &&
        (!search ||
          item.name.toLocaleLowerCase().includes(search) ||
          variantHashes(item.hash, data).some(
            (hash) =>
              String(hash).includes(search) ||
              data.items[hash]?.name.toLocaleLowerCase().includes(search),
          ) ||
          matchingAliases.has(item.hash)),
    );
  const categories = [...data.categories];
  for (const item of items) {
    if (!categories.some((category) => category.id === item.categoryId)) {
      categories.push({ id: item.categoryId, label: item.categoryId, group: 'Other', order: 9999 });
    }
  }
  const groups = new Map<string, CategoryGroup>();
  for (const category of categories.sort((a, b) => a.order - b.order)) {
    const entries = items
      .filter((item) => item.categoryId === category.id)
      .sort((a, b) => a.name.localeCompare(b.name) || a.hash - b.hash);
    if (!entries.length) continue;
    const group = groups.get(category.group) ?? { name: category.group, sections: [] };
    group.sections.push({ ...category, items: entries });
    groups.set(category.group, group);
  }
  return [...groups.values()];
}
