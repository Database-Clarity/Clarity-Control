import { resolveAlias } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { editorDraftIndex } from '../../services/editorDrafts';
import {
  canonicalHash,
  classifiedCategory,
  editorName,
  finderCategoryId,
  itemFor,
  navigationGroups,
} from '../navigation/catalog';
import { editorPath } from './editorPath';
import type { QueueItem } from './model';
import { reviewStamp } from './model';
import type { WorklistEntry } from '../../../../../packages/core/src/worklists';

export function worklistAvailable(hash: number, data: EditorData): boolean {
  try {
    canonicalHash(hash, data); // Reject cyclic identities, while allowing enhanced override paths.
    return (
      resolveAlias(hash, data.aliases) === hash &&
      !data.bundle.tooltips[hash]?.archive &&
      !!itemFor(hash, data)
    );
  } catch {
    return false;
  }
}
export function savedItems(items: WorklistEntry[], data: EditorData): QueueItem[] {
  return items.map((item) => ({
    ...item,
    name:
      item.name ||
      (itemFor(item.hash, data) ? editorName(itemFor(item.hash, data)!) : String(item.hash)),
    key: String(item.hash),
    path: editorPathSafe(item.hash, data),
    detail: worklistStamp(item.hash, data),
  }));
}
/** Unresolvable aliases leave a frozen entry open, without inventing a save baseline. */
export function worklistStamp(hash: number, data: EditorData): string | undefined {
  try {
    return reviewStamp(data.bundle.tooltips[hash], data.aliases);
  } catch {
    return undefined;
  }
}
function editorPathSafe(hash: number, data: EditorData) {
  try {
    return editorPath(hash, data);
  } catch {
    return `/t/${hash}`;
  }
}
export async function draftItems(data: EditorData): Promise<QueueItem[]> {
  const hashes = await editorDraftIndex();
  return savedItems(
    [...hashes]
      .filter(
        (hash) =>
          worklistAvailable(hash, data) && !data.bundle.tooltips[hash]?.text.en?.text.trim(),
      )
      .map((hash) => ({
        hash,
        name: editorName(itemFor(hash, data)!),
      })),
    data,
  );
}

/** A built-in Drafts worklist: the drafts of one finder category. */
export interface DraftGroup {
  /** The finder section's id. */
  id: string;
  label: string;
  items: QueueItem[];
}
type Section = Omit<DraftGroup, 'items'> & { rank: number };
interface Sections {
  byHash: Map<number, Section>;
  byId: Map<string, Section>;
}
const sections = new WeakMap<EditorData, Sections>();
/** The finder section of every listed entry, ranked in finder order (Globals left out). */
function finderSections(data: EditorData): Sections {
  let found = sections.get(data);
  if (!found) {
    found = { byHash: new Map(), byId: new Map() };
    let groups: ReturnType<typeof navigationGroups> = [];
    try {
      groups = navigationGroups(data, '', []);
    } catch {
      // An alias cycle elsewhere in the catalogue: every draft falls back to its own category.
    }
    for (const group of groups)
      for (const { id, label, items } of group.sections) {
        const section = { id, label, rank: found.byId.size };
        found.byId.set(id, section);
        for (const item of items)
          if (!found.byHash.has(item.hash)) found.byHash.set(item.hash, section);
      }
    sections.set(data, found);
  }
  return found;
}
/**
 * The finder section an entry is listed in. An enhanced variant is listed under its base entry
 * (draftItems already rejected alias cycles); an entry the finder hides (an armor set's selector)
 * goes to its category's section.
 */
function sectionOf(hash: number, data: EditorData): Section {
  const { byHash, byId } = finderSections(data);
  const listed = byHash.get(hash) ?? byHash.get(canonicalHash(hash, data));
  if (listed) return listed;
  const category = classifiedCategory(itemFor(hash, data), data);
  const id = finderCategoryId(category?.id ?? 'other');
  return byId.get(id) ?? { id, label: category?.label ?? 'Other', rank: Infinity };
}
/** Drafts split by finder category, in finder order; categories without drafts are left out. */
export function draftGroups(items: QueueItem[], data: EditorData): DraftGroup[] {
  const groups = new Map<string, DraftGroup & { rank: number }>();
  for (const item of items) {
    const section = sectionOf(item.hash, data);
    const group = groups.get(section.id) ?? { ...section, items: [] };
    group.items.push(item);
    groups.set(section.id, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.rank - b.rank)
    .map(({ id, label, items }) => ({ id, label, items }));
}
