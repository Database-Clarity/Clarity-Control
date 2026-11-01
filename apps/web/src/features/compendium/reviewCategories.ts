import type { EditorData } from '../../stores/data';
import { groupManifestItems } from './manifestItems';
import type { ReviewProposal } from './rapidReview';
import type { applyReviewProgress } from './reviewQueue';

export type ReviewEntry = ReturnType<typeof applyReviewProgress>[number];
export const reasonLabels = {
  validated: 'Validated proposals',
  fuzzy: 'Fuzzy candidates only',
  none: 'No resolver candidate',
  'missing-description': 'Missing manifest description',
  pending: 'Matching in progress',
  failed: 'Matching unavailable',
};
export type CategoryReason = keyof typeof reasonLabels;
export interface ReviewCategory {
  id: string;
  name: string;
  group: string;
  rule: string;
  entries: ReviewEntry[];
  reasons: Record<CategoryReason, ReviewEntry[]>;
  samples: ReviewEntry[];
}

export function categoryId(category: string) {
  return `catalog:${encodeURIComponent(category)}`;
}

export function reviewCategories(
  entries: ReviewEntry[],
  editor: EditorData,
  proposals: Map<number, ReviewProposal>,
  matching: boolean,
  failed = false,
): ReviewCategory[] {
  const manifest = groupManifestItems(editor.items, editor.aliases);
  const groups = new Map<string, ReviewCategory>();
  for (const entry of entries) {
    const id = categoryId(entry.category);
    const definition = editor.categories.find((category) => category.id === entry.category);
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        name: definition?.label ?? `Other: ${entry.category}`,
        group: definition?.group ?? 'Other',
        rule: `Canonical review entries whose catalog categoryId is exactly ${JSON.stringify(entry.category)}. Includes unlinked/repair entries and local review history; healthy saved links without local history and sandbox/frame aliases are excluded. Matching reason is a subgroup, never category identity.`,
        entries: [],
        reasons: {
          validated: [],
          fuzzy: [],
          none: [],
          'missing-description': [],
          pending: [],
          failed: [],
        },
        samples: [],
      };
      groups.set(id, group);
    }
    const proposal = proposals.get(entry.hash);
    const reason: CategoryReason = !(manifest.get(entry.hash) ?? []).some((item) =>
      item.inGameDescription.trim(),
    )
      ? 'missing-description'
      : matching
        ? 'pending'
        : failed
          ? 'failed'
          : proposal?.link
            ? 'validated'
            : proposal?.candidates.length
              ? 'fuzzy'
              : 'none';
    group.entries.push(entry);
    group.reasons[reason].push(entry);
  }
  for (const group of groups.values()) {
    group.entries.sort((a, b) => a.name.localeCompare(b.name) || a.hash - b.hash);
    // Cover distinct matching reasons, then spread the remaining samples across the category.
    const samples = new Map<number, ReviewEntry>();
    for (const entries of Object.values(group.reasons)) {
      entries.sort((a, b) => a.name.localeCompare(b.name) || a.hash - b.hash);
      if (entries[0]) samples.set(entries[0].hash, entries[0]);
    }
    for (
      let i = 0;
      samples.size < Math.min(5, group.entries.length) && i < group.entries.length;
      i++
    ) {
      const entry = group.entries[Math.floor((i * group.entries.length) / 5)] ?? group.entries[i];
      samples.set(entry.hash, entry);
    }
    for (const entry of group.entries) {
      if (samples.size >= Math.min(5, group.entries.length)) break;
      samples.set(entry.hash, entry);
    }
    group.samples = [...samples.values()].slice(0, 5);
  }
  return [...groups.values()].sort((a, b) => {
    const order = (id: string) =>
      editor.categories.find((category) => categoryId(category.id) === id)?.order ?? 9999;
    return order(a.id) - order(b.id) || a.id.localeCompare(b.id);
  });
}
