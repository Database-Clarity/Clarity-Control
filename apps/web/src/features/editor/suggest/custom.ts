import { create } from 'zustand';
import { Facet } from '@codemirror/state';
import { expandTemplate, type Lang, type Snippet } from '@clarity/core';
import {
  customSnippetScope,
  type CustomSnippet,
} from '../../../../../../packages/core/src/customSnippets';
import { getLocalizedSnippets, loadEditorSnippets } from '../../../services/snippets';

/**
 * Personal ("Mine") and team snippets, and the target language's words for built-in and team
 * snippets while translating. Loaded once per account and language; the menus read it without
 * waiting, so a menu opened before it arrives (or after a failed load) lists the built-ins only.
 */
export interface CustomEntry {
  source: 'mine' | 'team';
  /** The snippet as the menus insert it, with its derived scope (line start, enhanced, link). */
  snippet: Snippet;
  enhanced: boolean;
  link: boolean;
  /** Team snippet shown in English while translating (no current translation). */
  english: boolean;
}

export interface LocalWords {
  label: string;
  keywords: string;
  template: string;
  /** Served in English: no translation, or one older than the English. */
  english: boolean;
}

export interface SnippetCatalogue {
  mine: CustomEntry[];
  team: CustomEntry[];
  /** Built-in and team ids to the target language's words; empty for English. */
  local: ReadonlyMap<string, LocalWords>;
}

export const emptyCatalogue: SnippetCatalogue = { mine: [], team: [], local: new Map() };

const never = /(?!)/;

function entry(source: 'mine' | 'team', snippet: CustomSnippet, english = false): CustomEntry {
  const scope = customSnippetScope(snippet.template);
  return {
    source,
    snippet: {
      id: snippet.id,
      label: snippet.label,
      group: 'Values',
      template: snippet.template,
      keywords: snippet.keywords ?? '',
      // No usage count for a free template: it would mean nothing.
      usage: never,
      block: scope.lineStart,
      // A selection fills the first field, as with the built-ins that take one.
      fromSelection: expandTemplate(snippet.template).stops.length > 0,
      about: source === 'mine' ? 'One of your snippets.' : 'A team snippet.',
    },
    enhanced: scope.enhanced,
    link: scope.link,
    english,
  };
}

interface CatalogueState {
  /** Keyed by language; replaced whole on every load. */
  byLang: Partial<Record<Lang, SnippetCatalogue>>;
  /** The account the loaded catalogues belong to. */
  account: string | null;
}

export const useSnippetCatalogue = create<CatalogueState>(() => ({ byLang: {}, account: null }));

/** The current read per account and language; a superseded read's answer is dropped. */
const loading = new Map<string, Promise<void>>();
/** Languages asked for by this account's editors: a change reads them all again. */
const requested = new Set<Lang>();

/** Loads (once per account and language) what the menus offer beside the built-ins. */
export function loadSnippetCatalogue(account: string | null, lang: Lang): Promise<void> {
  if (useSnippetCatalogue.getState().account !== account) {
    loading.clear();
    requested.clear();
    useSnippetCatalogue.setState({ byLang: {}, account });
  }
  if (!account) return Promise.resolve();
  requested.add(lang);
  const key = `${account}:${lang}`;
  const running = loading.get(key);
  if (running) return running;
  // Assigned before any of its awaits resolve; the read compares itself with the current one.
  let load: Promise<void> | undefined = undefined;
  load = (async () => {
    const [custom, local] = await Promise.all([
      loadEditorSnippets(),
      lang === 'en' ? Promise.resolve(null) : getLocalizedSnippets(lang).catch(() => null),
    ]);
    const words = new Map<string, LocalWords>(
      (local?.snippets ?? []).map((found) => [
        found.id,
        {
          label: found.label,
          keywords: found.keywords,
          template: found.template,
          english: found.hint === 'EN',
        },
      ]),
    );
    const team = custom.team.map((snippet) => {
      const translated = words.get(snippet.id);
      return translated && !translated.english
        ? entry('team', {
            ...snippet,
            label: translated.label,
            keywords: translated.keywords,
            template: translated.template,
          })
        : entry('team', snippet, lang !== 'en');
    });
    // A later read (after another save) or another account replaced this one.
    if (loading.get(key) !== load) return;
    useSnippetCatalogue.setState((state) => ({
      byLang: {
        ...state.byLang,
        [lang]: {
          mine: custom.mine.map((snippet) => entry('mine', snippet)),
          team,
          local: words,
        },
      },
    }));
  })().catch(() => {
    // Built-ins only, no error in the editor; the next editor mount tries again.
    if (loading.get(key) === load) loading.delete(key);
  });
  loading.set(key, load);
  return load;
}

/** After a change in Settings, Management, or Translations: the menus read afresh. */
export function invalidateSnippetCatalogue(): void {
  const { account } = useSnippetCatalogue.getState();
  loading.clear();
  // Every language asked for (loaded or still loading) reads again; reads already in flight are
  // dropped. The menus keep the old lists until the new ones arrive.
  for (const lang of [...requested]) void loadSnippetCatalogue(account, lang);
}

/** What the menus offer now for this language (built-ins only until loaded). */
export function snippetCatalogue(lang: Lang | undefined): SnippetCatalogue {
  return (lang && useSnippetCatalogue.getState().byLang[lang]) || emptyCatalogue;
}

/** A built-in snippet with the target language's words, and whether it is shown in English. */
export function localSnippet(
  snippet: Snippet,
  catalogue: SnippetCatalogue,
  lang: Lang | undefined,
): { snippet: Snippet; english: boolean } {
  if (!lang || lang === 'en') return { snippet, english: false };
  const words = catalogue.local.get(snippet.id);
  if (!words || words.english) return { snippet, english: true };
  return {
    snippet: {
      ...snippet,
      label: words.label,
      keywords: words.keywords,
      template: words.template,
    },
    english: false,
  };
}

/** Signed in with an editor role (the catalogue loads only then): "Save as snippet" is offered. */
export const canSaveSnippets = (): boolean => useSnippetCatalogue.getState().account !== null;

/** "Save as snippet" from the Ctrl+Space menu: the selected text waiting for a label. */
export const useSaveSnippet = create<{ text: string | null; owner: object | null }>(() => ({
  text: null,
  owner: null,
}));
/** `owner` is the editor view that asked: only that editor shows the form. */
export const askSaveSnippet = (text: string, owner: object) =>
  useSaveSnippet.setState({ text, owner });
export const closeSaveSnippet = () => useSaveSnippet.setState({ text: null, owner: null });

/** The language this editor writes: the menus offer that language's snippet words. */
export const snippetLang = Facet.define<Lang, Lang | undefined>({
  combine: (values) => values[values.length - 1],
});
