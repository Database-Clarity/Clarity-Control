import { markupIcons } from '@clarity/core';
import { EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { useDataStore, type EditorData } from '../../../stores/data';
import { loadManifestFacts } from '../../compendium/manifestFacts';

const icons = new Set(markupIcons);
// Hand-kept keyword fallback, only when the catalogue provides no element.
// Apply after grouping duplicate names so any data-derived element wins.
const keywordElements: Readonly<Record<string, string>> = {
  radiant: 'solar',
  restoration: 'solar',
  blind: 'arc',
  'bolt charge': 'arc',
  devour: 'void',
  invisibility: 'void',
  suppression: 'void',
  weaken: 'void',
  sever: 'strand',
  threadling: 'strand',
  shatter: 'stasis',
  slow: 'stasis',
};
const categories = new Set([
  'verbs',
  'subclass-aspect',
  'subclass-fragment',
  'subclass-super',
  'subclass-grenade',
  'subclass-melee',
  'subclass-class',
]);
interface Name {
  name: string;
  icon: string | null;
}
interface Index {
  endings: Map<string, Name[]>;
  longest: number;
}
/** Regular word forms only; full phrases remain intact, and no keyword names are hard-coded. */
function wordForms(name: string): string[] {
  const split = name.lastIndexOf(' ') + 1;
  const prefix = name.slice(0, split);
  let word = name.slice(split);
  if (word.endsWith('ied')) word = word.slice(0, -3) + 'y';
  else if (word.endsWith('ed')) word = word.slice(0, -2);
  else if (word.endsWith('ing')) word = word.slice(0, -3);
  else if (word.endsWith('ies')) word = word.slice(0, -3) + 'y';
  else if (word.endsWith('s') && !word.endsWith('ss')) word = word.slice(0, -1);
  const stem = word.endsWith('e') && !word.endsWith('ee') ? word.slice(0, -1) : word;
  return [
    ...new Set([
      name,
      prefix + word,
      prefix +
        (word.endsWith('y')
          ? word.slice(0, -1) + 'ies'
          : word + (/(s|x|z|ch|sh)$/.test(word) ? 'es' : 's')),
      prefix +
        (word.endsWith('y') ? word.slice(0, -1) + 'ied' : word + (word.endsWith('e') ? 'd' : 'ed')),
      prefix + stem + 'ing',
    ]),
  ];
}
function indexNames(data: EditorData | null): Index {
  const endings = new Map<string, Name[]>();
  let longest = 0;
  if (!data) return { endings, longest };
  const facts = loadManifestFacts().items;
  const named = new Map<string, { icons: Set<string>; keyword: boolean; hasElement: boolean }>();
  for (const item of Object.values(data.items)) {
    if (!categories.has(item.categoryId)) continue;
    const category = facts[item.hash]?.inventory?.plug?.plugCategoryIdentifier;
    const rawElement = category?.split('.')[1];
    const element = rawElement === 'prism' ? 'prismatic' : rawElement;
    const tooltip = data.bundle.tooltips[item.hash]?.text.en?.text ?? '';
    const descriptionElements = [
      ...item.inGameDescription.matchAll(/\[(Arc|Solar|Void|Stasis|Strand|Prismatic)\]/g),
    ].map((match) => match[1]!.toLowerCase());
    const icon =
      element && icons.has(element)
        ? element
        : (tooltip.match(/<(kinetic|arc|solar|void|stasis|strand|prismatic)\/>/)?.[1] ??
          (new Set(descriptionElements).size === 1 ? descriptionElements[0] : null) ??
          null);
    const original = item.name.toLowerCase();
    const known = named.get(original) ?? {
      icons: new Set<string>(),
      keyword: item.categoryId === 'verbs',
      hasElement: false,
    };
    if (icon) known.icons.add(icon);
    // Multiple description elements are ambiguous data, not missing data.
    known.hasElement ||= Boolean(icon) || descriptionElements.length > 0;
    named.set(original, known);
  }
  for (const [original, known] of named) {
    if (known.icons.size > 1) known.icons.delete('prismatic');
    const icon =
      known.icons.size === 1
        ? [...known.icons][0]!
        : !known.hasElement && known.keyword && Object.hasOwn(keywordElements, original)
          ? (keywordElements[original] ?? null)
          : null;
    for (const name of known.keyword && icon ? wordForms(original) : [original]) {
      const key = name.split(' ').at(-1)!;
      const entries = endings.get(key) ?? [];
      const existing = entries.find((entry) => entry.name === name);
      if (!existing) entries.push({ name, icon });
      endings.set(
        key,
        entries.sort((a, b) => b.name.length - a.name.length),
      );
      longest = Math.max(longest, name.length);
    }
  }
  return { endings, longest };
}
let catalogue = useDataStore.getState().data;
let index = indexNames(catalogue);
// Catalogue loads, not keystrokes, build the index. No document or catalogue scan while typing.
useDataStore.subscribe(({ data }) => {
  if (data === catalogue) return;
  catalogue = data;
  index = indexNames(data);
});
export const longestSymbolName = () => index.longest;

/** The editor already configures a static language attribute. */
export function englishSymbols(state: EditorState): boolean {
  return !state
    .facet(EditorView.contentAttributes)
    .some((value) => typeof value !== 'function' && value.lang && value.lang !== 'en');
}

/** Whole subclass names ending at the caret, longest first. */
export function subclassSymbol(before: string, lastWord: string) {
  for (const entry of index.endings.get(lastWord.toLowerCase()) ?? []) {
    const start = before.length - entry.name.length;
    if (start < 0 || before.slice(start).toLowerCase() !== entry.name) continue;
    if (start > 0 && /[\p{L}\p{N}_<#$/{|]/u.test(before[start - 1]!)) continue;
    return { icon: entry.icon, word: before.slice(start) };
  }
  return null;
}
