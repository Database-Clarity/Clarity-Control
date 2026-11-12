import { globalDefinitions, globalTypes, type GlobalDefinition } from '../globals/model';
import {
  classifyItem,
  listingCategoryId,
  derivedCategories,
  isSetSelector,
  manifestArtifacts,
  manifestPlug,
} from '../compendium/itemClassification';
import { currentArtifactOwners } from '../compendium/artifactIdentity';
import { resolveAlias, type Tooltip, type CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Category, Item } from '../../services/generator';
import { categoryDisplay, groupRank } from '../../services/categoryLabels';
import { activityDisplay, missingActivity } from '../../services/activityLabels';
import { artifactOrder, noArtifact, noArtifactLabel } from '../../services/artifactLabels';
import { entryKey, type Entry } from './stepping';

const canonicalIndexes = new WeakMap<EditorData, Map<number, number>>();
export function canonicalHash(hash: number, data: EditorData): number {
  let index = canonicalIndexes.get(data);
  if (!index) canonicalIndexes.set(data, (index = new Map()));
  const cached = index.get(hash);
  if (cached !== undefined) return cached;
  const seen = new Set<number>();
  const remember = (canonical: number) => {
    for (const member of seen) index.set(member, canonical);
    return canonical;
  };
  while (!seen.has(hash)) {
    seen.add(hash);
    const resolved = resolveAlias(hash, data.aliases);
    if (resolved !== hash) {
      hash = resolved;
      continue;
    }
    const item = data.items[hash];
    // A grouped frame owns one editor even if manifest pairing points elsewhere.
    if (frameGroupSize(hash, data) > 1) return remember(hash);
    const target = item?.baseHash;
    if (target === undefined) return remember(hash);
    hash = target;
  }
  throw new Error(`Cyclic tooltip alias at ${hash}`);
}

/**
 * The category the finder lists this item under: the generator's, unless the editor reclassifies
 * it (Stat-only Parts, Parts with Effects, Inactive & Placeholders). Labels and section choice use
 * this; the generator category stays the item's identity for matching and export.
 */
export function classifiedCategory(
  item: Item | null | undefined,
  data: EditorData,
): Category | undefined {
  if (!item) return undefined;
  const id = listingCategoryId(item, classifyItem(item, data.bundle.tooltips[item.hash]));
  // An id the catalog does not know is listed under its own "Other: <id>" section.
  return (
    data.categories.find((category) => category.id === id) ??
    derivedCategories.find((category) => category.id === id) ?? { id, ...categoryDisplay(id) }
  );
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
  if (!item || !owners || owners.length < 2) return undefined;
  // Two definitions of one item (same name) are not a shared perk.
  const distinct = [...new Set(owners.map((owner) => ownerName(owner, item, data)))];
  return distinct.length > 1 ? `Shared perk — used on: ${distinct.join(', ')}` : undefined;
}

function ownerName(owner: number, item: Item, data: EditorData): string {
  return (
    data.items[owner]?.name.trim() ||
    data.bundle.tooltips[owner]?.custom?.name.trim() ||
    item.ownerNames?.[owner]?.trim() ||
    String(owner)
  );
}

/** Single owning item identity, with catalog and embedded metadata fallbacks. */
export function singleOwnerLabel(hash: number, data: EditorData): string | undefined {
  const item = itemFor(hash, data);
  if (!item) return undefined;
  const owners = item.owners ?? [];
  if (owners.length > 1) {
    // Several definitions of one item (same name): name it once, list every hash.
    const names = new Set(owners.map((owner) => ownerName(owner, item, data)));
    if (names.size > 1) return undefined;
    return `Owner: ${[...names][0]} / ${owners.join(', ')}`;
  }
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

/**
 * The legacy bundle's placeholder tooltip (hash 0, "Default perk", custom category "none"): it
 * carries the editor's sample text and no item, so it is not listed. The tooltip stays in the
 * bundle and in the export; only the finder skips it.
 */
export function isDefaultPerkPlaceholder(hash: number, data: EditorData): boolean {
  const custom = data.bundle.tooltips[hash]?.custom;
  return hash === 0 && !data.items[0] && custom?.name === 'Default perk';
}

/** What the editor calls the exotic armour perk category (registry label, also used by worklists). */
export const exoticArmourLabel = categoryDisplay(exoticArmourCategory).label;

/**
 * A finder entry. Exotic armour entries are named after the piece; `perkName` is the perk they
 * open, `piece` the piece label alone (the name also carries the perk when pieces repeat) and
 * `pieces` how many differently named pieces the label joins.
 */
export interface ListedItem extends Item {
  global?: GlobalDefinition;
  perkName?: string;
  piece?: string;
  pieces?: number;
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
  return {
    ...item,
    name: crowded ? `${piece} · ${item.name}` : piece,
    perkName: item.name,
    piece,
    pieces: names.length,
  };
}

/**
 * The armour piece(s) an exotic armour perk belongs to, written once for the editor's headings;
 * nothing when the perk is already named after its piece (Blastwave Striders).
 */
export function exoticPiece(item: Item): string | undefined {
  if (item.categoryId !== exoticArmourCategory) return undefined;
  const names = exoticPieceNames(item);
  const piece = names.length ? joinPieceNames(names) : undefined;
  return piece === item.name.trim() ? undefined : piece;
}

/**
 * The preview header's piece row: exotic armour always has one (empty when the perk is named after
 * its piece), so stepping through the category never moves the version tabs under the header.
 */
export function previewPiece(item: Item): string | undefined {
  return exoticPiece(item) ?? (item.categoryId === exoticArmourCategory ? '' : undefined);
}

/** How the editor names the open item: "Piece · Perk" for exotic armour, the item's name otherwise. */
export function editorName(item: Item): string {
  const piece = exoticPiece(item);
  return piece ? `${piece} · ${item.name}` : item.name;
}

export function listName(item: Item, data: EditorData): string {
  return listedItem(item, data).name;
}

/**
 * What a category's second dropdown groups by: a weapon (exotic owner), an activity (plug), or
 * an artifact (the current artifacts whose sockets offer the perk).
 */
export type Grouping = 'weapon' | 'activity' | 'artifact';
export interface CategorySection extends Category {
  items: ListedItem[];
  grouping?: Grouping;
}
export interface CategoryGroup {
  name: string;
  sections: CategorySection[];
}

/**
 * The finder's "Exotic Weapons" category: each weapon's perks, frames, catalysts, and parts in one
 * list, grouped by weapon. A presentation category only; the four generator categories keep their
 * ids, their editor labels, and export.
 */
export const exoticWeaponsCategory = 'exotic-weapons';
const exoticWeaponsSpec: Category = {
  id: exoticWeaponsCategory,
  label: 'Exotic Weapons',
  group: 'Weapons',
  order: 102,
};
/** Kind order within a weapon: Frame, Perk, Catalyst, Part. */
const exoticWeaponKinds: Readonly<Record<string, { label: string; rank: number }>> = {
  'weapon-frame-exotic': { label: 'Frame', rank: 0 },
  'weapon-trait-exotic': { label: 'Perk', rank: 1 },
  'weapon-catalyst-exotic': { label: 'Catalyst', rank: 2 },
  'weapon-perk-exotic': { label: 'Part', rank: 3 },
};
const activityModCategory = 'armor-mod-activity';
const artifactPerkCategory = 'armor-mod-seasonal';
const groupings: Readonly<Record<string, Grouping>> = {
  [exoticWeaponsCategory]: 'weapon',
  [activityModCategory]: 'activity',
  [artifactPerkCategory]: 'artifact',
};
const groupingLabels: Readonly<Record<Grouping, { all: string; group: string }>> = {
  weapon: { all: 'All exotic weapons', group: 'Weapon' },
  activity: { all: 'All activities', group: 'Activity' },
  artifact: { all: 'All artifacts', group: 'Artifact' },
};

/** The finder section a category id is listed in. */
export function finderCategoryId(categoryId: string): string {
  return categoryId in exoticWeaponKinds ? exoticWeaponsCategory : categoryId;
}

/** Kind label of an exotic weapon entry (Frame, Perk, Catalyst, Part). */
export function exoticWeaponKind(item: Pick<Item, 'categoryId'>): string {
  return exoticWeaponKinds[item.categoryId]?.label ?? 'Entry';
}

export interface FinderGroup {
  /**
   * The owner's lowest hash for its name, the manifest plug category of an activity, or the
   * socketed artifact's hash.
   */
  id: string;
  label: string;
  entries: Entry[];
  index: Map<string, number>;
}
/** A grouped category's entries, built once per section: per group, and all of them in group order. */
export interface GroupedSection {
  grouping: Grouping;
  groups: FinderGroup[];
  byId: Map<string, FinderGroup>;
  groupIndex: Map<string, number>;
  all: Entry[];
  allIndex: Map<string, number>;
  /** The group an item belongs to when the route names none: its first owner, in generator order. */
  firstGroup: Map<number, string>;
  /** Every group a shared item is listed under (only items listed under two or more). */
  owners: Map<number, FinderGroup[]>;
  items: Map<number, ListedItem>;
  allLabel: string;
  groupLabel: string;
}

function entryOwnerLabel(owner: number, item: Item, data: EditorData): string {
  return (
    data.items[owner]?.name.trim() ||
    data.bundle.tooltips[owner]?.custom?.name.trim() ||
    item.ownerNames?.[owner]?.trim() ||
    (owner === item.itemHash ? item.itemName?.trim() : undefined) ||
    String(owner)
  );
}

const ownerIds = new WeakMap<EditorData, Map<string, number>>();
/**
 * Two definitions of one weapon share a name: they are one group, identified by the lowest hash.
 * Computed over every exotic weapon entry, so a search never renames a group.
 */
function weaponOwnerIds(data: EditorData): Map<string, number> {
  let ids = ownerIds.get(data);
  if (!ids) {
    ids = new Map();
    for (const item of Object.values(data.items)) {
      if (!(item.categoryId in exoticWeaponKinds)) continue;
      for (const owner of item.owners ?? (item.itemHash === undefined ? [] : [item.itemHash])) {
        const name = entryOwnerLabel(owner, item, data);
        ids.set(name, Math.min(owner, ids.get(name) ?? owner));
      }
    }
    ownerIds.set(data, ids);
  }
  return ids;
}

const groupedSections = new WeakMap<CategorySection, GroupedSection | undefined>();
export function groupedSection(
  section: CategorySection,
  data: EditorData,
): GroupedSection | undefined {
  if (!section.grouping) return undefined;
  if (groupedSections.has(section)) return groupedSections.get(section);
  const weapon = section.grouping === 'weapon';
  const groups = new Map<
    string,
    { id: string; label: string; order: number; items: ListedItem[] }
  >();
  const firstGroup = new Map<number, string>();
  const itemGroups = new Map<number, string[]>();
  const add = (id: string, label: string, order: number, item: ListedItem) => {
    const mine = itemGroups.get(item.hash) ?? [];
    // Two owners with one name are one weapon: listed once.
    if (mine.includes(id)) return;
    mine.push(id);
    itemGroups.set(item.hash, mine);
    const group = groups.get(id) ?? { id, label, order, items: [] };
    group.items.push(item);
    groups.set(id, group);
    if (!firstGroup.has(item.hash)) firstGroup.set(item.hash, id);
  };
  if (weapon) {
    const nameIds = weaponOwnerIds(data);
    for (const item of section.items) {
      const owners = item.owners ?? (item.itemHash === undefined ? [] : [item.itemHash]);
      if (!owners.length) add('0', 'No weapon', 0, item);
      for (const owner of owners) {
        const name = entryOwnerLabel(owner, item, data);
        add(String(nameIds.get(name) ?? owner), name, 0, item);
      }
    }
  } else if (section.grouping === 'artifact') {
    for (const item of section.items) {
      const artifacts = manifestArtifacts(item.hash);
      if (!artifacts.length) add(noArtifact, noArtifactLabel, artifactOrder(undefined), item);
      for (const artifact of artifacts)
        add(String(artifact.hash), artifact.name, artifactOrder(artifact.hash), item);
    }
  } else {
    for (const item of section.items) {
      const { plug, description } = manifestPlug(item.hash);
      const spec = activityDisplay(plug, description);
      add(plug ?? missingActivity, spec.label, spec.order, item);
    }
  }
  const kindRank = (item: ListedItem) => exoticWeaponKinds[item.categoryId]?.rank ?? 9;
  const built: FinderGroup[] = [...groups.values()]
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
    .map((group) => {
      const entries = group.items
        .sort(
          (a, b) =>
            (weapon ? kindRank(a) - kindRank(b) : 0) ||
            a.name.localeCompare(b.name) ||
            a.hash - b.hash,
        )
        .map((item) => ({ hash: item.hash, group: group.id }));
      return {
        id: group.id,
        label: group.label,
        entries,
        index: new Map(entries.map((entry, i) => [entryKey(entry.hash, entry.group), i])),
      };
    });
  const all = built.flatMap((group) => group.entries);
  const byId = new Map(built.map((group) => [group.id, group]));
  const owners = new Map<number, FinderGroup[]>();
  for (const [hash, ids] of itemGroups)
    if (ids.length > 1)
      owners.set(
        hash,
        ids.map((id) => byId.get(id)!),
      );
  const result: GroupedSection = {
    grouping: section.grouping,
    groups: built,
    byId,
    groupIndex: new Map(built.map((group, i) => [group.id, i])),
    all,
    allIndex: new Map(all.map((entry, i) => [entryKey(entry.hash, entry.group), i])),
    firstGroup,
    owners,
    items: new Map(section.items.map((item) => [item.hash, item])),
    allLabel: groupingLabels[section.grouping].all,
    groupLabel: groupingLabels[section.grouping].group,
  };
  groupedSections.set(section, result);
  return result;
}

export function navigationGroups(
  data: EditorData,
  query: string,
  definitions = globalDefinitions(data.bundle.tooltips),
): CategoryGroup[] {
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
        .filter(
          (tooltip) =>
            !data.items[tooltip.hash] &&
            tooltip.custom &&
            !isDefaultPerkPlaceholder(tooltip.hash, data),
        )
        .map((tooltip) => itemFor(tooltip.hash, data)!),
    )
    .filter(
      (item) =>
        ![1, 2, 3].includes(item.hash) &&
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
    const id = listingCategoryId(item, classifyItem(item, data.bundle.tooltips[item.hash]));
    return listedItem(id === item.categoryId ? item : { ...item, categoryId: id }, data);
  });
  const categories = [
    ...data.categories.filter((category) => !(category.id in exoticWeaponKinds)),
    ...derivedCategories.filter((c) => !data.categories.some((existing) => existing.id === c.id)),
    exoticWeaponsSpec,
  ];
  for (const item of classifiedItems) {
    const id = finderCategoryId(item.categoryId);
    if (!categories.some((category) => category.id === id)) {
      categories.push({ id, ...categoryDisplay(id) });
    }
  }
  const groups = new Map<string, CategoryGroup>();
  const ranked = categories.sort(
    (a, b) => groupRank(a.group) - groupRank(b.group) || a.order - b.order,
  );
  for (const category of ranked) {
    const entries = classifiedItems
      .filter((item) => finderCategoryId(item.categoryId) === category.id)
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
      items: entries,
      ...(groupings[category.id] && { grouping: groupings[category.id] }),
    });
    groups.set(category.group, group);
  }
  const globals: CategoryGroup = {
    name: 'Globals',
    sections: globalTypes
      .map(({ kind, label }) => ({
        id: `globals-${kind}`,
        label,
        group: 'Globals',
        order: 0,
        items: definitions
          .filter(
            (entry) =>
              entry.kind === kind && (!search || entry.name.toLocaleLowerCase().includes(search)),
          )
          .map((entry) => ({
            hash: entry.hash,
            name: entry.name,
            categoryId: `globals-${kind}`,
            icon: '',
            inGameDescription: '',
            global: entry,
          })),
      }))
      .filter((section) => section.items.length > 0),
  };
  if (globals.sections.length) groups.set('Globals', globals);
  return [...groups.values()];
}
