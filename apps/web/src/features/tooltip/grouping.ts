import { incomingAliases } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { canonicalHash, variantHashes } from '../navigation/catalog';
import { isEnhancedPair } from './variants';

/**
 * How a manifest perk ended up in an editor entry:
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

export const joinLabel: Record<JoinReason, string> = {
  canonical: 'Canonical',
  enhanced: 'Enhanced pair',
  variant: 'Base pointer',
  alias: 'Alias group',
  numbered: 'Numbered exotic intrinsic',
  frame: 'Legendary frame group',
  sandbox: 'Sandbox alias',
};

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
  /** The hash it joins through when that is not the canonical (an alias of an enhanced version). */
  via?: number;
  /** How it joined, in words: "Sandbox alias of the enhanced version 3684445958". */
  how: string;
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
    const shown = via !== undefined && via !== canonical ? via : undefined;
    perks.push({
      hash: member,
      name:
        data.items[member]?.name.trim() || data.bundle.tooltips[member]?.custom?.name.trim() || '',
      enhanced: ofEnhanced || isEnhanced(member, data),
      reason,
      ...(shown !== undefined ? { via: shown } : {}),
      how: ofEnhanced
        ? `${joinLabel[reason]} of the enhanced version${shown !== undefined ? ` ${shown}` : ''}`
        : `${joinLabel[reason]}${shown !== undefined ? ` via ${shown}` : ''}`,
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
