import { incomingAliases, isSandboxDecision } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { canonicalHash, variantHashes } from '../navigation/catalog';
import { isBlankCopy, isEnhancedPair, variantForm } from './variants';

/**
 * How a game item or perk effect ended up in an editor entry (`entryView` says it in plain words):
 * - `canonical`: the hash the entry is stored under;
 * - `enhanced`: an enhanced version paired with the canonical (manifest base pointer);
 * - `variant`: another manifest base pointer (weapon-perk copy, origin trait, exotic frame copy);
 * - `alias`: an approved alias group member (same name and facts);
 * - `numbered`: a numbered exotic intrinsic ("Name II") aliased to its unnumbered canonical;
 * - `frame`: a legendary frame group member;
 * - `sandbox`: a generated sandbox-perk alias.
 */
export type JoinReason =
  'canonical' | 'enhanced' | 'variant' | 'alias' | 'numbered' | 'frame' | 'sandbox';

export interface GroupedPerk {
  hash: number;
  /**
   * In-game name from the item catalog; empty for a hash the catalog does not list (sandbox perks
   * are named from the bundled sandbox perk text when the list is shown).
   */
  name: string;
  /** Its own hash is an enhanced item, or it is an alias of the enhanced version. */
  enhanced: boolean;
  reason: JoinReason;
  /** Owner names when two or more differently named items share this one perk hash. */
  sharedBy?: string[];
}

const order: JoinReason[] = [
  'canonical',
  'enhanced',
  'variant',
  'alias',
  'numbered',
  'frame',
  'sandbox',
];
const numberedName = / (II|III|IV)$/;

function isEnhanced(hash: number, data: EditorData): boolean {
  const item = data.items[hash];
  if (!item) return false;
  const legacyType = data.categories.find(
    (category) => category.id === item.categoryId,
  )?.legacyType;
  return item.categoryId.endsWith('-enhanced') || Boolean(legacyType?.endsWith(' Enhanced'));
}

function sharedBy(hash: number, data: EditorData): string[] | undefined {
  const item = data.items[hash];
  if (!item?.owners || item.owners.length < 2) return undefined;
  const names = [
    ...new Set(
      item.owners.map(
        (owner) =>
          data.items[owner]?.name.trim() || item.ownerNames?.[owner]?.trim() || String(owner),
      ),
    ),
  ];
  return names.length > 1 ? names : undefined;
}

const cache = new WeakMap<EditorData, Map<number, GroupedPerk[]>>();

/**
 * Every manifest perk hash that opens this editor entry, and how it joined. Read-only: derived from
 * the generator catalog and aliases already loaded; memoised per data bundle.
 */
export function groupedPerks(hash: number, data: EditorData): GroupedPerk[] {
  let byHash = cache.get(data);
  if (!byHash) cache.set(data, (byHash = new Map()));
  const canonical = canonicalHash(hash, data);
  const cached = byHash.get(canonical);
  if (cached) return cached;
  const perks: GroupedPerk[] = [];
  const seen = new Set<number>();
  const add = (member: number, reason: JoinReason, via?: number) => {
    if (seen.has(member)) return;
    seen.add(member);
    // An alias takes the side of the perk it aliases: a sandbox perk paired with the enhanced
    // version is the enhanced perk (aliasOf points at the enhanced hash), whatever its own hash is.
    const ofEnhanced =
      reason !== 'canonical' &&
      reason !== 'enhanced' &&
      reason !== 'variant' &&
      via !== undefined &&
      isEnhanced(via, data);
    perks.push({
      hash: member,
      name:
        data.items[member]?.name.trim() || data.bundle.tooltips[member]?.custom?.name.trim() || '',
      enhanced: ofEnhanced || isEnhanced(member, data),
      reason,
      ...(sharedBy(member, data) ? { sharedBy: sharedBy(member, data) } : {}),
    });
  };
  const members = variantHashes(canonical, data);
  for (const member of members) {
    if (member === canonical) add(member, 'canonical');
    else
      add(
        member,
        isEnhancedPair(canonical, member, data) ? 'enhanced' : 'variant',
        data.items[member]?.baseHash,
      );
  }
  for (const member of members) {
    for (const [alias, kind] of incomingAliases(member, data.aliases)) {
      const item = data.items[alias];
      const reason: JoinReason =
        kind === 'frame'
          ? 'frame'
          : kind === 'sandbox'
            ? 'sandbox'
            : item?.categoryId === 'weapon-frame-exotic' && numberedName.test(item.name.trim())
              ? 'numbered'
              : 'alias';
      add(alias, reason, data.aliases[alias]?.to);
    }
  }
  perks.sort(
    (left, right) =>
      order.indexOf(left.reason) - order.indexOf(right.reason) || left.hash - right.hash,
  );
  byHash.set(canonical, perks);
  return perks;
}

/** A perk effect the game lists on this entry's items that does not open the entry. */
export interface UnattachedPerk {
  /** Why, in words. */
  why: string;
  /** The names behind a count in `why`, for its tooltip. */
  others?: string;
  /** The Sandbox perks page has a row for it. */
  review: boolean;
}
export interface EntryRow {
  hash: number;
  kind: 'Item' | 'Keyword' | 'Custom tooltip' | 'Perk effect';
  /** Set when the row opens this entry; otherwise `unattached` says why it does not. */
  perk?: GroupedPerk;
  unattached?: UnattachedPerk;
  /** The text's home ("Text is here"), or a version that does not share the text. */
  mark?: string;
  /** How it joined, or the other version using it, when its block does not already say so. */
  joined?: string;
}
export interface EntryBlock {
  /** Empty when the entry has only a base version (frames are always named). */
  title: string;
  enhanced: boolean;
  rows: EntryRow[];
}
export interface EntryView {
  blocks: EntryBlock[];
  /** "2 items, 2 perk effects (1 not attached)". */
  summary: string;
}

const joinedLabel: Partial<Record<JoinReason, string>> = {
  alias: 'Same-name copy',
  numbered: 'Numbered copy',
};

function kindOf(perk: GroupedPerk, data: EditorData | null): EntryRow['kind'] {
  const item = data?.items[perk.hash];
  if (perk.reason === 'sandbox' || item?.definitionType === 'DestinySandboxPerkDefinition')
    return 'Perk effect';
  if (item?.definitionType === 'DestinyTraitDefinition') return 'Keyword';
  return !item && data?.bundle.tooltips[perk.hash]?.custom ? 'Custom tooltip' : 'Item';
}

function markOf(perk: GroupedPerk, canonical: number, data: EditorData | null) {
  if (perk.reason === 'canonical') return 'Text is here';
  if (!data || (perk.reason !== 'enhanced' && perk.reason !== 'variant')) return undefined;
  if (variantForm(canonical, perk.hash, data) === 'derived') return undefined;
  return isBlankCopy(canonical, perk.hash, data) ? 'Has no text' : 'Has its own text';
}

type Side = 'base' | 'enhanced' | 'other';
const sideOf = (perk: GroupedPerk): Side =>
  perk.reason === 'variant' ? 'other' : perk.enhanced ? 'enhanced' : 'base';

function whyUnattached(
  hash: number,
  sides: ReadonlySet<Side>,
  canonical: number,
  data: EditorData,
): UnattachedPerk {
  const pointer = data.bundle.sandboxPointers?.pointers[hash];
  const users = data.sandboxConflicts?.[hash];
  const review = !!users || isSandboxDecision(pointer);
  const nameOf = (entry: number) =>
    data.items[entry]?.name.trim() ||
    data.bundle.tooltips[entry]?.custom?.name.trim() ||
    String(entry);
  if (data.aliases[hash])
    return { why: `Attached to ${nameOf(canonicalHash(hash, data))} instead`, review };
  if (isSandboxDecision(pointer) && 'none' in pointer)
    return { why: 'Not attached: set to no tooltip', review };
  const others = new Set((users ?? []).map((user) => canonicalHash(user, data)));
  others.delete(canonical);
  if (others.size === 1) {
    const other = [...others][0]!;
    const name = nameOf(other);
    return {
      why: `Not attached: also used by ${name === nameOf(canonical) ? `${name} ${other}` : name}`,
      review,
    };
  }
  if (others.size)
    return {
      why: `Not attached: also used by ${others.size} other entries`,
      others: new Intl.ListFormat('en').format([...others].map(nameOf)),
      review,
    };
  if (sides.has('base') && sides.has('enhanced'))
    return { why: 'Not attached: used by base and enhanced', review };
  return {
    why: users ? `Not attached: used by ${users.length} items here` : 'Not attached',
    review,
  };
}

/**
 * What the maintainers' popover shows: an entry's items and perk effects by version, with the perk
 * effects the game lists on those items but nothing (or another entry) has attached. Computed only
 * while the popover is open. An attached perk effect shows once, under the version it is attached
 * to; an unattached one under each version whose items list it.
 */
export function entryView(perks: readonly GroupedPerk[], data: EditorData | null): EntryView {
  const canonical = (perks.find((perk) => perk.reason === 'canonical') ?? perks[0]!).hash;
  const listedBy = new Map<number, Set<Side>>();
  for (const perk of perks)
    for (const effect of data?.items[perk.hash]?.sandboxPerkHashes ?? [])
      listedBy.set(effect, (listedBy.get(effect) ?? new Set()).add(sideOf(perk)));
  const rows: Record<Side, EntryRow[]> = { base: [], enhanced: [], other: [] };
  for (const perk of perks) {
    const side = sideOf(perk);
    const other = side === 'base' ? 'enhanced' : 'base';
    rows[side].push({
      hash: perk.hash,
      kind: kindOf(perk, data),
      perk,
      mark: markOf(perk, canonical, data),
      joined:
        perk.reason === 'sandbox' && listedBy.get(perk.hash)?.has(other)
          ? `Also used by ${other}`
          : joinedLabel[perk.reason],
    });
  }
  const members = new Set(perks.map((perk) => perk.hash));
  const unattached = [...listedBy].filter(([hash]) => !members.has(hash));
  for (const [hash, sides] of unattached.sort(([left], [right]) => left - right))
    for (const side of sides)
      rows[side].push({
        hash,
        kind: 'Perk effect',
        unattached: whyUnattached(hash, sides, canonical, data!),
      });
  const frames = perks.some((perk) => perk.reason === 'frame') ? ' frames' : '';
  const titles: Record<Side, string> = {
    base: `Base${frames}`,
    enhanced: `Enhanced${frames}`,
    other: 'Other copies',
  };
  const sides = (['base', 'enhanced', 'other'] as const).filter((side) => rows[side].length);
  return {
    blocks: sides.map((side) => ({
      title: sides.length === 1 && side === 'base' && !frames ? '' : titles[side],
      enhanced: side === 'enhanced',
      rows: rows[side],
    })),
    summary: summarise(perks, unattached.length, data),
  };
}

function summarise(perks: readonly GroupedPerk[], unattached: number, data: EditorData | null) {
  const kinds = perks.map((perk) => kindOf(perk, data));
  const counts = (['Item', 'Keyword', 'Custom tooltip', 'Perk effect'] as const).flatMap((kind) => {
    const count =
      kinds.filter((value) => value === kind).length + (kind === 'Perk effect' ? unattached : 0);
    return count ? `${count} ${kind.toLowerCase()}${count === 1 ? '' : 's'}` : [];
  });
  return `${counts.join(', ')}${unattached ? ` (${unattached} not attached)` : ''}`;
}
