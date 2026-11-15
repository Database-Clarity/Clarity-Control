import type {
  CategoryGroup,
  CategorySection,
  GroupedSection,
  FinderGroup,
} from '../navigation/catalog';
import { entryKey, parseScope, scopeValue, type Entry } from '../navigation/stepping';
import type { Marks, EntryMark, MarkType } from '@clarity/core/marks';

export interface MarkDisplay extends EntryMark {
  label: string;
  colour: MarkType['colour'];
}
export type MarksIndex = ReadonlyMap<number, readonly MarkDisplay[]>;

export const markedCategoryId = 'marked';
const prefix = 'mark.';
export const markTypeFromGroup = (group: string) =>
  group.startsWith(prefix) ? group.slice(prefix.length) : undefined;
const groupings = new WeakMap<CategorySection, GroupedSection>();
const listedIndexes = new WeakMap<CategoryGroup[], Map<number, CategorySection['items'][number]>>();
export const markedGrouping = (section: CategorySection) => groupings.get(section);
export function markSearchMatches(index: MarksIndex, query: string): Set<number> {
  const search = query.trim().toLocaleLowerCase();
  return new Set(
    [...index]
      .filter(([, entries]) =>
        entries.some((entry) =>
          `${entry.label} ${entry.note ?? ''}`.toLocaleLowerCase().includes(search),
        ),
      )
      .map(([hash]) => hash),
  );
}
export function markedScopeValue(entry: Entry, all: boolean, first: ReadonlyMap<number, string>) {
  return markTypeFromGroup(entry.group)
    ? `${all ? 'all:' : ''}${entry.group}`
    : scopeValue(entry, all, first);
}
export function markedRowScope(entry: Entry & { all?: boolean }): string | undefined {
  return markTypeFromGroup(entry.group) ? `${entry.all ? 'all:' : ''}${entry.group}` : undefined;
}
export function markedRouteCategory(
  hash: number,
  search: string,
  sections: CategorySection[],
): string | undefined {
  const group = parseScope(new URLSearchParams(search).get('g'))?.group;
  if (!group || !markTypeFromGroup(group)) return undefined;
  const section = sections.find((section) => section.id === markedCategoryId);
  return group && markTypeFromGroup(group) && section && groupings.get(section)?.items.has(hash)
    ? markedCategoryId
    : undefined;
}

/** Built on demand for a Marked scope or a search, never for ordinary finder opening. */
export function buildMarkedSection(
  base: CategoryGroup[],
  marks: Marks,
): CategorySection | undefined {
  if (!marks.types.length || !Object.keys(marks.entries).length) return undefined;
  let listed = listedIndexes.get(base);
  if (!listed) {
    listed = new Map(
      base.flatMap((group) =>
        group.sections.flatMap((section) =>
          section.items.map((item) => [item.hash, item] as const),
        ),
      ),
    );
    listedIndexes.set(base, listed);
  }
  const items = new Map<number, CategorySection['items'][number]>();
  const groups: FinderGroup[] = marks.types
    .map((type) => {
      const id = prefix + type.id;
      const entries = Object.entries(marks.entries)
        .filter(
          ([hash, entries]) =>
            listed.has(Number(hash)) && entries.some((entry) => entry.type === type.id),
        )
        .map(([hash]) => {
          const item = listed.get(Number(hash))!;
          items.set(item.hash, item);
          return { hash: item.hash, group: id };
        })
        .sort(
          (a, b) =>
            items.get(a.hash)!.name.localeCompare(items.get(b.hash)!.name) || a.hash - b.hash,
        );
      return {
        id,
        label: type.label,
        entries,
        index: new Map(entries.map((entry, index) => [entryKey(entry.hash, id), index])),
      };
    })
    .filter((group) => group.entries.length);
  if (!items.size) return undefined;
  const all = groups.flatMap((group) => group.entries);
  const firstGroup = new Map<number, string>();
  const owners = new Map<number, FinderGroup[]>();
  for (const group of groups)
    for (const entry of group.entries) {
      if (!firstGroup.has(entry.hash)) firstGroup.set(entry.hash, group.id);
      owners.set(entry.hash, [...(owners.get(entry.hash) ?? []), group]);
    }
  for (const [hash, memberOf] of owners) if (memberOf.length < 2) owners.delete(hash);
  const section: CategorySection = {
    id: markedCategoryId,
    label: 'Marked',
    group: 'Worklists',
    order: 0,
    grouping: 'mark',
    items: [...items.values()],
  };
  groupings.set(section, {
    grouping: 'mark',
    groups,
    byId: new Map(groups.map((group) => [group.id, group])),
    groupIndex: new Map(groups.map((group, index) => [group.id, index])),
    all,
    allIndex: new Map(all.map((entry, index) => [entryKey(entry.hash, entry.group), index])),
    firstGroup,
    owners,
    items,
    allLabel: 'All mark types',
    groupLabel: 'Mark type',
  });
  return section;
}
