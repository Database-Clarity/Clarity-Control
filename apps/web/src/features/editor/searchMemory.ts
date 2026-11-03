import {
  getSearchQuery,
  openSearchPanel,
  searchPanelOpen,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import type { EditorView, ViewUpdate } from '@codemirror/view';

/**
 * Find and replace outlives a tooltip: its open state, query, replacement and options are
 * remembered for this tab (a module value, mirrored to sessionStorage so a reload keeps them), and
 * put back whenever the editor is mounted or its state is rebuilt for another tooltip.
 */
export interface SearchMemory {
  open: boolean;
  search: string;
  replace: string;
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
}

const key = 'clarity.find';
const closed: SearchMemory = {
  open: false,
  search: '',
  replace: '',
  caseSensitive: false,
  regexp: false,
  wholeWord: false,
};

let memory: SearchMemory | null = null;
/** True while a restore is half way (query set, panel not yet open): nothing to remember yet. */
let restoring = false;

function parse(raw: string | null): SearchMemory | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SearchMemory>;
    return {
      open: value.open === true,
      search: typeof value.search === 'string' ? value.search : '',
      replace: typeof value.replace === 'string' ? value.replace : '',
      caseSensitive: value.caseSensitive === true,
      regexp: value.regexp === true,
      wholeWord: value.wholeWord === true,
    };
  } catch {
    return null;
  }
}

export function readSearchMemory(): SearchMemory {
  if (memory) return memory;
  try {
    memory = parse(sessionStorage.getItem(key));
  } catch {
    memory = null;
  }
  return memory ?? closed;
}

export function writeSearchMemory(next: SearchMemory): void {
  memory = next;
  try {
    sessionStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Storage can be unavailable; the module value still carries it across tooltips.
  }
}

/** Forget everything (tests, and a clean slate). */
export function resetSearchMemory(): void {
  memory = null;
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing to forget.
  }
}

/** What the editor's find state is right now. */
export function searchSnapshot(state: EditorView['state']): SearchMemory {
  const query = getSearchQuery(state);
  return {
    open: searchPanelOpen(state),
    search: query.search,
    replace: query.replace,
    caseSensitive: query.caseSensitive,
    regexp: query.regexp,
    wholeWord: query.wholeWord,
  };
}

const same = (a: SearchMemory, b: SearchMemory) =>
  a.open === b.open &&
  a.search === b.search &&
  a.replace === b.replace &&
  a.caseSensitive === b.caseSensitive &&
  a.regexp === b.regexp &&
  a.wholeWord === b.wholeWord;

/**
 * Remember the find state when this update changed it. An editor whose find never changed (a
 * second editor on the page) leaves the memory alone.
 */
export function rememberSearch(update: ViewUpdate): void {
  if (restoring) return;
  const now = searchSnapshot(update.state);
  if (!same(now, searchSnapshot(update.startState))) writeSearchMemory(now);
}

/**
 * Put the remembered find state into a (new) editor. The panel opens without taking focus, so
 * moving between tooltips never pulls the caret out of whatever the author was using.
 */
export function restoreSearch(view: EditorView): void {
  const saved = readSearchMemory();
  if (!saved.open && !saved.search && !saved.replace) return;
  const query = new SearchQuery({
    search: saved.search,
    replace: saved.replace,
    caseSensitive: saved.caseSensitive,
    regexp: saved.regexp,
    wholeWord: saved.wholeWord,
  });
  const active = document.activeElement;
  restoring = true;
  try {
    view.dispatch({ effects: setSearchQuery.of(query) });
    if (saved.open) openSearchPanel(view);
  } finally {
    restoring = false;
  }
  if (saved.open) {
    const focused = document.activeElement;
    // The panel focuses its field on opening; hand focus back to where it was.
    if (focused !== active && view.dom.contains(focused) && focused !== view.contentDOM) {
      if (active instanceof HTMLElement && active !== document.body && !view.dom.contains(active))
        active.focus();
      else if (focused instanceof HTMLElement) focused.blur();
    }
  }
}
