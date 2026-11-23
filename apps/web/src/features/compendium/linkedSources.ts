import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { resolveAlias, type CompendiumData } from '@clarity/core';
import { useDataStore, type EditorData } from '../../stores/data';
import { itemFor } from '../navigation/catalog';
import { isSetSelector } from './itemClassification';
import { linkLocation, matchLocation, type SourceLocation } from './sourceLocation';
import { useCompendiumStore } from './store';
import { compendiumChanges } from './tracking';

export interface LinkedSource {
  hash: number;
  name: string;
  category: string;
  /** Unset for a tooltip without a link. */
  status?: 'Changed' | 'Needs relink' | 'Moved';
  snapshotAt?: string;
  location?: SourceLocation;
}

/** Saved links whose source is no longer as it was saved, newest snapshot first. */
function changedSources(editor: EditorData, data: CompendiumData): LinkedSource[] {
  return compendiumChanges(editor.bundle.tooltips, data).map(({ tooltip, resolution }) => {
    const item = itemFor(tooltip.hash, editor);
    return {
      hash: tooltip.hash,
      name: item?.name ?? String(tooltip.hash),
      category: item?.categoryId ?? 'other',
      status:
        'row' in resolution
          ? resolution.status === 'moved'
            ? 'Moved'
            : 'Changed'
          : 'Needs relink',
      snapshotAt: tooltip.compendium!.snapshotAt,
      location:
        'row' in resolution
          ? matchLocation(resolution, data)
          : linkLocation(tooltip.compendium!, data, { stale: true }),
    };
  });
}

function withoutLinks(editor: EditorData): LinkedSource[] {
  const hashes = new Set(
    [...Object.values(editor.items), ...Object.values(editor.bundle.tooltips)].map(
      (entry) => entry.hash,
    ),
  );
  return [...hashes]
    .filter(
      (hash) =>
        hash > 3 &&
        resolveAlias(hash, editor.aliases) === hash &&
        !editor.bundle.tooltips[hash]?.compendium,
    )
    .flatMap((hash) => {
      const item = itemFor(hash, editor);
      return item && !isSetSelector(item)
        ? [{ hash, name: item.name, category: item.categoryId }]
        : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type LinkedList = 'changes' | 'unlinked';

/** The Source changes view: its list and the filters, which live in the URL. */
export function useLinkedSources() {
  const editor = useDataStore((state) => state.data);
  const data = useCompendiumStore((state) => state.data);
  const [params, setParams] = useSearchParams();
  const list: LinkedList = params.get('linkedList') === 'unlinked' ? 'unlinked' : 'changes';
  const query = params.get('linkedQuery') ?? '';
  const category = params.get('linkedCategory') ?? '';
  /** null until the sheet is loaded. */
  const rows = useMemo(
    () =>
      !editor
        ? null
        : list === 'unlinked'
          ? withoutLinks(editor)
          : data && changedSources(editor, data),
    [editor, data, list],
  );
  const searched = useMemo(() => {
    const search = query.trim().toLowerCase();
    return (rows ?? []).filter(
      (row) => !search || `${row.name} ${row.hash}`.toLowerCase().includes(search),
    );
  }, [rows, query]);
  /** Categories with matching rows, in catalog order. */
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of searched) counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
    return (editor?.categories ?? [])
      .filter(({ id }) => counts.has(id) || id === category)
      .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999))
      .map(({ id, label }) => ({ id, label, count: counts.get(id) ?? 0 }));
  }, [editor, searched, category]);
  const shown = category ? searched.filter((row) => row.category === category) : searched;
  const set = (key: 'linkedList' | 'linkedQuery' | 'linkedCategory', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  return { editor, list, query, category, rows, searched, categories, shown, set };
}
