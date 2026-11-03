import { classifyItem, derivedCategories, isSetSelector } from '../compendium/itemClassification';
import { currentArtifactOwners } from '../compendium/artifactIdentity';
import { resolveAlias, type Tooltip, type CompendiumData } from '@clarity/core';
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
export function sharedPerkLabel(
  hash: number,
  data: EditorData,
  source?: CompendiumData | null,
): string | undefined {
  const item = data.items[hash];
  if (item?.categoryId === 'armor-mod-seasonal') {
    const names = [...new Set(currentArtifactOwners(hash, source).values())];
    return names.length > 1 ? `Shared perk — used on: ${names.join(', ')}` : undefined;
  }
  const owners = item?.owners;
  if (!owners || owners.length < 2) return undefined;
  const names = owners.map(
    (owner) =>
      data.items[owner]?.name.trim() ||
      data.bundle.tooltips[owner]?.custom?.name.trim() ||
      item.ownerNames?.[owner]?.trim() ||
      String(owner),
  );
  // Two definitions of one item (same name) are not a shared perk.
  const distinct = [...new Set(names)];
  return distinct.length > 1 ? `Shared perk — used on: ${distinct.join(', ')}` : undefined;
}

/** Single owning item identity, with catalog and embedded metadata fallbacks. */
export function singleOwnerLabel(hash: number, data: EditorData): string | undefined {
  const item = itemFor(hash, data);
  if (!item || (item.owners?.length ?? 0) > 1) return undefined;
  const owner = item.itemHash ?? item.owners?.[0];
  if (owner === undefined) return undefined;
  const name =
    data.items[owner]?.name.trim() ||
    data.bundle.tooltips[owner]?.custom?.name.trim() ||
    item.ownerNames?.[owner]?.trim() ||
    item.itemName?.trim();
  return `Owner: ${name ? `${name} / ` : ''}${owner}`;
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

function matchesOwner(item: Item, data: EditorData, search: string): boolean {
  const owners = new Set([
    ...(item.owners ?? []),
    ...(item.itemHash === undefined ? [] : [item.itemHash]),
  ]);
  return [...owners].some((owner) =>
    [
      String(owner),
      data.items[owner]?.name,
      data.bundle.tooltips[owner]?.custom?.name,
      item.ownerNames?.[owner],
      owner === item.itemHash ? item.itemName : undefined,
    ].some((value) => value?.toLocaleLowerCase().includes(search)),
  );
}

/** The generator category of exotic armour perks; the finder lists the armour pieces instead. */
export const exoticArmourCategory = 'armor-trait-exotic';
const exoticArmourLabel = 'Exotic Armor';

/** A finder entry. Exotic armour entries are named after the piece; `perkName` is the perk they open. */
export interface ListedItem extends Item {
  perkName?: string;
}

/** Armour pieces that carry this perk, sorted; empty when the data names none. */
function exoticPieceNames(item: Item): string[] {
  const named = Object.values(item.ownerNames ?? {});
  const names = (named.length ? named : [item.itemName ?? '']).map((name) => name.trim());
  return [...new Set(names.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** "Aeon Safe", "Aeon Soul" -> "Aeon Safe / Soul": a shared first word is written once. */
function joinPieceNames(names: string[]): string {
  const first = names[0]?.split(' ')[0];
  const shared =
    names.length > 1 && names.every((name) => name.includes(' ') && name.startsWith(`${first} `));
  return shared
    ? `${names[0]}/${names
        .slice(1)
        .map((name) => name.slice(first!.length + 1))
        .join('/')}`
    : names.join(' / ');
}

const pieceSiblings = new WeakMap<EditorData, Map<string, number>>();
function siblingCount(key: string, data: EditorData): number {
  let counts = pieceSiblings.get(data);
  if (!counts) {
    counts = new Map();
    for (const item of Object.values(data.items)) {
      if (item.categoryId !== exoticArmourCategory) continue;
      const names = joinPieceNames(exoticPieceNames(item));
      counts.set(names, (counts.get(names) ?? 0) + 1);
    }
    pieceSiblings.set(data, counts);
  }
  return counts.get(key) ?? 1;
}

/**
 * How an item is named in the finder. Exotic armour perks are listed as the armour piece that
 * carries them (the editor still edits the perk); a perk shared by pieces of one set lists them
 * together, and several perks on the same piece(s) each add their own name.
 */
export function listedItem(item: Item, data: EditorData): ListedItem {
  if (item.categoryId !== exoticArmourCategory) return item;
  const names = exoticPieceNames(item);
  if (!names.length) return item;
  const piece = joinPieceNames(names);
  const crowded = siblingCount(piece, data) > 1;
  return { ...item, name: crowded ? `${piece} · ${item.name}` : piece, perkName: item.name };
}

export function listName(item: Item, data: EditorData): string {
  return listedItem(item, data).name;
}

export interface CategorySection extends Category {
  items: ListedItem[];
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
        !isSetSelector(item) &&
        canonicalHash(item.hash, data) === item.hash &&
        (!search ||
          item.name.toLocaleLowerCase().includes(search) ||
          item.setName?.toLocaleLowerCase().includes(search) ||
          variantHashes(item.hash, data).some(
            (hash) =>
              String(hash).includes(search) ||
              data.items[hash]?.name.toLocaleLowerCase().includes(search),
          ) ||
          variantHashes(item.hash, data).some((hash) => {
            const variant = itemFor(hash, data);
            return variant && matchesOwner(variant, data, search);
          }) ||
          matchingAliases.has(item.hash)),
    );
  const classifiedItems = items.map((item): ListedItem => {
    const c = classifyItem(item, data.bundle.tooltips[item.hash]);
    return listedItem(c ? { ...item, categoryId: c.categoryId } : item, data);
  });
  const categories = [
    ...data.categories,
    ...derivedCategories.filter((c) => !data.categories.some((existing) => existing.id === c.id)),
  ];
  for (const item of classifiedItems) {
    if (!categories.some((category) => category.id === item.categoryId)) {
      categories.push({ id: item.categoryId, label: item.categoryId, group: 'Other', order: 9999 });
    }
  }
  const groups = new Map<string, CategoryGroup>();
  for (const category of categories.sort((a, b) => a.order - b.order)) {
    const entries = classifiedItems
      .filter((item) => item.categoryId === category.id)
      .sort(
        (a, b) =>
          (a.setName ?? a.name).localeCompare(b.setName ?? b.name) ||
          (a.pieceCount ?? 0) - (b.pieceCount ?? 0) ||
          a.name.localeCompare(b.name) ||
          a.hash - b.hash,
      );
    if (!entries.length) continue;
    const group = groups.get(category.group) ?? { name: category.group, sections: [] };
    group.sections.push({
      ...category,
      label: category.id === exoticArmourCategory ? exoticArmourLabel : category.label,
      items: entries,
    });
    groups.set(category.group, group);
  }
  return [...groups.values()];
}
