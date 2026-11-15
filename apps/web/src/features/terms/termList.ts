import type { Lang } from '@clarity/core';
import type { Item } from '../../services/generator';
import type { NamesFile } from './names';
import type { TermEntry } from './match';
import { englishEndings } from './match';
import {
  glossaryKey,
  type Glossary,
  type GlossaryEntry,
} from '../../../../../packages/core/src/glossary/schema';

/**
 * One resolved list per language of things in the English a translator can insert: official
 * game names now (computed from the names file, never stored). Glossary terms (TR9) and number
 * tokens (spec in progress) join as further kinds on the same list, so the marks, the popover, the
 * Terms list, and Insert stay one path.
 */
export type TermKind = 'keyword' | 'name' | 'glossary' | 'number';
export interface Term extends TermEntry {
  kind: TermKind;
  /** What Insert puts in the translation, most used first (an English name can map to several). */
  official: string[];
  glossary?: GlossaryEntry;
  inGame?: string[];
  /** Clicking the mark inserts at once (a single exact insert, such as a number token). */
  insertOnClick?: boolean;
  /** A source number uses the editor's atomic insertion command, including its declarations. */
  number?: { kind: string; context: string; scope: string; insert(): boolean };
}

/** Overlay agreed terms on the existing source; names remain available as the secondary row. */
export function mergeGlossary(
  list: TermList | undefined,
  glossary: Glossary,
  revision: string | null,
): TermList {
  const official = new Map((list?.terms ?? []).map((term) => [glossaryKey(term.en), term]));
  const terms: Term[] = [];
  for (const entry of Object.values(glossary.terms)) {
    const inGame = new Set<string>();
    for (const spelling of [entry.en, ...(entry.also ?? [])]) {
      const key = glossaryKey(spelling);
      const last = /[\p{L}\p{N}]+$/u.exec(key);
      const keys = last
        ? [...englishEndings(last[0])].map((word) => key.slice(0, last.index) + word)
        : [key];
      for (const form of keys) {
        for (const name of official.get(form)?.official ?? []) inGame.add(name);
        official.delete(form);
      }
    }
    const next: Term = {
      ...entry,
      kind: 'glossary',
      glossary: entry,
      official: [entry.term],
      inGame: [...inGame],
    };
    terms.push(next);
  }
  terms.push(...official.values());
  return {
    id: `${list?.id ?? glossary.lang}:glossary:${revision}:${++sequence}`,
    lang: glossary.lang,
    terms,
  };
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
