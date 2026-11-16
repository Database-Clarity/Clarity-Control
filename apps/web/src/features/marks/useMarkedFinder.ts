import { useMemo } from 'react';
import type { CategoryGroup, CategorySection } from '../navigation/catalog';
import { parseScope } from '../navigation/stepping';
import {
  buildMarkedSection,
  markedCategoryId,
  markSearchMatches,
  markTypeFromGroup,
} from './finder';
import { useMarksStore } from './store';

export function useMarkedFinder(
  base: CategoryGroup[],
  found: CategoryGroup[],
  query: string,
  routeSearch: string,
) {
  const marks = useMarksStore((state) => state.marks);
  const index = useMarksStore((state) => state.index);
  const search = query.trim().toLocaleLowerCase();
  const markedRoute = !!markTypeFromGroup(
    parseScope(new URLSearchParams(routeSearch).get('g'))?.group ?? '',
  );
  const needed = !!search || markedRoute;
  const section = useMemo(
    () => (needed ? buildMarkedSection(base, marks) : undefined),
    [base, marks, needed],
  );
  // Keep the category available without enumerating or grouping its entries.
  const category = useMemo<CategorySection | undefined>(
    () =>
      section ??
      (marks.types.length && index.size
        ? {
            id: markedCategoryId,
            label: 'Marked',
            group: 'Worklists',
            order: 0,
            grouping: 'mark',
            items: [],
          }
        : undefined),
    [section, marks, index],
  );
  const groups = useMemo(
    () => (category ? [...base, { name: 'Worklists', sections: [category] }] : base),
    [base, category],
  );
  const results = useMemo(() => {
    if (!search) return groups;
    if (!section) return found;
    const matches = markSearchMatches(index, search);
    // Preserve catalogue order and combine text results with mark label/note matches.
    const foundSections = new Map(
      found.flatMap((group) => group.sections.map((category) => [category.id, category] as const)),
    );
    const result = base
      .map((group) => ({
        ...group,
        sections: group.sections.flatMap((category) => {
          const original = foundSections.get(category.id);
          if (!category.items.some((item) => matches.has(item.hash)))
            return original ? [original] : [];
          const hashes = new Set(original?.items.map((item) => item.hash));
          return [
            {
              ...category,
              items: category.items.filter(
                (item) => hashes.has(item.hash) || matches.has(item.hash),
              ),
            },
          ];
        }),
      }))
      .filter((group) => group.sections.length);
    const matchingHashes = new Set([
      ...matches,
      ...found.flatMap((group) =>
        group.sections.flatMap((category) => category.items.map((item) => item.hash)),
      ),
    ]);
    const filtered =
      section &&
      buildMarkedSection(base, {
        ...marks,
        entries: Object.fromEntries(
          Object.entries(marks.entries).filter(([hash]) => matchingHashes.has(Number(hash))),
        ),
      });
    return filtered ? [...result, { name: 'Worklists', sections: [filtered] }] : result;
  }, [base, found, groups, section, search, marks, index]);
  return {
    groups,
    found: results,
    marksIndex: index,
    loadMarkedSection: () => section ?? buildMarkedSection(base, marks),
  };
}
