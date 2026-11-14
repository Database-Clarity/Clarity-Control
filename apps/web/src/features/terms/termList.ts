import type { Lang } from '@clarity/core';
import type { Item } from '../../services/generator';
import type { NamesFile } from './names';
import type { TermEntry } from './match';

/**
 * One resolved term list per language: official game names now (computed from the names file,
 * never stored); the glossary (TR9) will overlay its own entries on the same list, so marks,
 * popover, and Insert stay one path.
 */
export type TermKind = 'keyword' | 'name';
export interface Term extends TermEntry {
  kind: TermKind;
  /** The in-game names in the language, most used first (one English name can map to several). */
  official: string[];
}
export interface TermList {
  /** Stable for this list's lifetime: the worker keeps the compiled list under it. */
  id: string;
  lang: Lang;
  terms: Term[];
}

/** Shorter English names mark too much ordinary prose ("Arc" is an icon, not a name to insert). */
const minimumLength = 4;
let sequence = 0;
const lists = new WeakMap<NamesFile, WeakMap<Record<string, Item>, TermList>>();

export function buildTermList(items: Record<string, Item>, file: NamesFile, lang: Lang): TermList {
  let byItems = lists.get(file);
  if (!byItems) lists.set(file, (byItems = new WeakMap()));
  const cached = byItems.get(items);
  if (cached) return cached;
  const grouped = new Map<string, { kind: TermKind; counts: Map<string, number> }>();
  const add = (en: string | undefined, official: string | undefined, kind: TermKind) => {
    en = en?.trim();
    official = official?.trim();
    if (!en || !official || en.length < minimumLength) return;
    let entry = grouped.get(en);
    if (!entry) grouped.set(en, (entry = { kind, counts: new Map() }));
    // A keyword spelling wins over an item of the same name: keywords match any case.
    if (kind === 'keyword') entry.kind = 'keyword';
    entry.counts.set(official, (entry.counts.get(official) ?? 0) + 1);
  };
  for (const item of Object.values(items)) {
    if (item.hiddenFromEditor) continue;
    const keyword = item.definitionType === 'DestinyTraitDefinition';
    add(item.name, file.names[item.hash], keyword ? 'keyword' : 'name');
    if (item.itemHash !== undefined) add(item.itemName, file.itemNames[item.itemHash], 'name');
    for (const [hash, name] of Object.entries(item.ownerNames ?? {}))
      add(name, file.itemNames[hash], 'name');
    if (item.setHash !== undefined) add(item.setName, file.setNames[item.setHash], 'name');
  }
  const terms: Term[] = [...grouped]
    .map(([en, { kind, counts }]) => ({
      en,
      kind,
      matchCase: kind === 'name',
      official: [...counts].sort((a, b) => b[1] - a[1]).map(([name]) => name),
    }))
    .sort((a, b) => (a.en < b.en ? -1 : a.en > b.en ? 1 : 0));
  const list: TermList = { id: `${lang}:${file.manifestVersion}:${++sequence}`, lang, terms };
  byItems.set(items, list);
  return list;
}
