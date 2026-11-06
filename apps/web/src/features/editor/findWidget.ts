import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, runScopeHandlers, type Panel, type ViewUpdate } from '@codemirror/view';
import {
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  SearchQuery,
  selectMatches,
  setSearchQuery,
  closeSearchPanel,
} from '@codemirror/search';

/**
 * The find and replace widget: one compact row at the top right of the text (find field with its
 * Aa / ab / .* toggles inside it, "n of m", previous, next, close) and, behind the chevron, a
 * second row for replace. It is a CodeMirror panel, so it lives inside the editor view: stepping
 * from tooltip to tooltip never remounts it, and the built-in commands (Ctrl+F, F3, Esc, ...)
 * drive it unchanged.
 *
 * "n of m" is the only costly part, so it is never computed on the input path: it is rescanned
 * after the document or the query stops changing (a quiet period, then in slices that yield), and
 * moving between matches only looks the selection up in the list from the last scan.
 */

/** Matches counted before the count reads "1000+". */
export const maxCounted = 1000;
/** Quiet time after a document or query change before the matches are recounted. */
const quietMs = 60;
/** Longest uninterrupted stretch of one counting slice. */
const sliceMs = 4;

export const setReplaceOpen = StateEffect.define<boolean>();

/** Whether the replace row is showing; remembered with the rest of the find state. */
export const replaceOpenField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setReplaceOpen)) return effect.value;
    return value;
  },
});

export function replaceRowOpen(state: EditorView['state']): boolean {
  return state.field(replaceOpenField, false) ?? false;
}

export interface MatchList {
  from: number[];
  to: number[];
  /** True when counting stopped at the cap. */
  capped: boolean;
}

/** The index of the match that is exactly the selection, or -1. */
export function currentMatch(list: MatchList, from: number, to: number): number {
  let low = 0;
  let high = list.from.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (list.from[mid] < from) low = mid + 1;
    else if (list.from[mid] > from) high = mid - 1;
    else return list.to[mid] === to ? mid : -1;
  }
  return -1;
}

/** What the count reads for a scanned list and the selection (pure, for tests). */
export function countLabel(
  list: MatchList | null,
  selection: { from: number; to: number },
  search: string,
  valid: boolean,
): string {
  if (!search) return '';
  if (!valid) return 'Invalid';
  if (!list) return '';
  if (!list.from.length) return 'No results';
  const total = list.capped ? `${maxCounted}+` : String(list.from.length);
  const at = currentMatch(list, selection.from, selection.to);
  return `${at < 0 ? '?' : at + 1} of ${total}`;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

const toggle = (name: string, label: string, title: string, glyph: string) =>
  element(
    'button',
    {
      type: 'button',
      name,
      class: 'fw-toggle',
      'aria-label': label,
      title,
      'aria-pressed': 'false',
    },
    [glyph],
  );

const action = (name: string, label: string, title: string, glyph: string) =>
  element('button', { type: 'button', name, class: 'fw-button', 'aria-label': label, title }, [
    glyph,
  ]);

const widgets = new WeakMap<HTMLElement, FindWidget>();

class FindWidget implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private readonly search: HTMLInputElement;
  private readonly replace: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly flags: Record<'case' | 'word' | 're', HTMLButtonElement>;
  private readonly expand: HTMLButtonElement | null;
  private query: SearchQuery;
  private list: MatchList | null = null;
  private quiet: ReturnType<typeof setTimeout> | undefined;
  private run = 0;

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state);
    const readOnly = view.state.readOnly;
    this.search = element('input', {
      name: 'search',
      class: 'fw-input',
      placeholder: 'Find',
      'aria-label': 'Find',
      'main-field': 'true',
      autocomplete: 'off',
      spellcheck: 'false',
      autocapitalize: 'off',
      form: '',
    });
    this.replace = element('input', {
      name: 'replace',
      class: 'fw-input',
      placeholder: 'Replace',
      'aria-label': 'Replace',
      autocomplete: 'off',
      spellcheck: 'false',
      autocapitalize: 'off',
      form: '',
    });
    this.flags = {
      case: toggle('case', 'Match case', 'Match case (Alt+C)', 'Aa'),
      word: toggle('word', 'Match whole word', 'Match whole word (Alt+W)', 'ab'),
      re: toggle('re', 'Use regular expression', 'Use regular expression (Alt+R)', '.*'),
    };
    this.count = element('span', {
      class: 'fw-count',
      role: 'status',
      'aria-live': 'polite',
    });
    this.expand = readOnly
      ? null
      : element(
          'button',
          {
            type: 'button',
            name: 'toggleReplace',
            class: 'fw-expand',
            'aria-label': 'Toggle replace',
            title: 'Toggle replace (Ctrl+H)',
            'aria-expanded': 'false',
          },
          [element('span', { class: 'fw-chevron', 'aria-hidden': 'true' }, ['›'])],
        );
    const find = element('div', { class: 'fw-find' }, [
      element('div', { class: 'fw-field' }, [
        this.search,
        this.flags.case,
        this.flags.word,
        this.flags.re,
      ]),
      this.count,
      action('prev', 'Previous match', 'Previous match (Shift+Enter)', '↑'),
      action('next', 'Next match', 'Next match (Enter)', '↓'),
      action('closeFind', 'Close', 'Close (Escape)', '×'),
    ]);
    const rows: Node[] = [find];
    if (!readOnly) {
      rows.push(
        element('div', { class: 'fw-replace' }, [
          element('div', { class: 'fw-field' }, [this.replace]),
          element(
            'button',
            {
              type: 'button',
              name: 'replace',
              class: 'fw-button fw-text',
              'aria-label': 'Replace',
              title: 'Replace (Enter)',
            },
            ['Replace'],
          ),
          element(
            'button',
            {
              type: 'button',
              name: 'replaceAll',
              class: 'fw-button fw-text',
              'aria-label': 'Replace all',
              title: 'Replace all (Ctrl+Alt+Enter)',
            },
            ['All'],
          ),
        ]),
      );
    }
    this.dom = element(
      'div',
      { class: 'cm-search', role: 'search', 'aria-label': 'Find and replace' },
      [...(this.expand ? [this.expand] : []), element('div', { class: 'fw-rows' }, rows)],
    );
    widgets.set(this.dom, this);
    this.dom.addEventListener('keydown', (event) => this.keydown(event));
    this.dom.addEventListener('input', () => this.commit());
    this.dom.addEventListener('change', () => this.commit());
    this.dom.addEventListener('click', (event) => this.click(event));
    this.sync(this.query);
    // Building a panel happens inside an update: only the DOM is set here, the state follows.
    this.setReplaceShown(replaceRowOpen(view.state) || (!readOnly && this.query.replace !== ''));
    this.rescan(0);
  }

  mount() {
    // Opening takes focus into the find field (select() alone does not do that everywhere).
    this.search.focus();
    this.search.select();
  }

  destroy() {
    this.run++;
    clearTimeout(this.quiet);
  }

  private setReplaceShown(open: boolean) {
    if (!this.expand) return;
    this.dom.dataset.replace = open ? 'open' : 'closed';
    this.expand.setAttribute('aria-expanded', String(open));
  }

  /** The replace row, shown or hidden; the state field (and so the remembered state) follows. */
  showReplace(open: boolean) {
    this.setReplaceShown(open);
    if (replaceRowOpen(this.view.state) !== open)
      this.view.dispatch({ effects: setReplaceOpen.of(open) });
  }

  focusReplace() {
    this.showReplace(true);
    this.replace.focus();
    this.replace.select();
  }

  private sync(query: SearchQuery) {
    this.query = query;
    if (this.search.value !== query.search) this.search.value = query.search;
    if (this.replace.value !== query.replace) this.replace.value = query.replace;
    this.flags.case.setAttribute('aria-pressed', String(query.caseSensitive));
    this.flags.re.setAttribute('aria-pressed', String(query.regexp));
    this.flags.word.setAttribute('aria-pressed', String(query.wholeWord));
    this.search.toggleAttribute('data-invalid', Boolean(query.search) && !query.valid);
  }

  private commit() {
    const query = new SearchQuery({
      search: this.search.value,
      replace: this.replace.value,
      caseSensitive: this.flags.case.getAttribute('aria-pressed') === 'true',
      regexp: this.flags.re.getAttribute('aria-pressed') === 'true',
      wholeWord: this.flags.word.getAttribute('aria-pressed') === 'true',
    });
    if (query.eq(this.query)) return;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
  }

  private flip(name: 'case' | 'word' | 're') {
    const button = this.flags[name];
    button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
    this.commit();
  }

  private click(event: MouseEvent) {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[name]');
    if (!button) return;
    const view = this.view;
    switch (button.name) {
      case 'case':
      case 'word':
      case 're':
        this.flip(button.name);
        this.search.focus();
        break;
      case 'next':
        findNext(view);
        break;
      case 'prev':
        findPrevious(view);
        break;
      case 'closeFind':
        closeSearchPanel(view);
        break;
      case 'replace':
        replaceNext(view);
        break;
      case 'replaceAll':
        replaceAll(view);
        break;
      case 'toggleReplace':
        if (this.dom.dataset.replace === 'open') {
          this.showReplace(false);
          this.search.focus();
        } else this.focusReplace();
        break;
    }
  }

  private keydown(event: KeyboardEvent) {
    const key = event.key;
    const mod = event.ctrlKey || event.metaKey;
    const view = this.view;
    if (runScopeHandlers(view, event, 'search-panel')) {
      event.preventDefault();
      return;
    }
    if (key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      if (mod && event.altKey) replaceAll(view);
      else if (event.altKey) selectMatches(view);
      else if (event.target === this.replace) replaceNext(view);
      else (event.shiftKey ? findPrevious : findNext)(view);
      return;
    }
    if (event.altKey && !mod) {
      const flag = ({ c: 'case', w: 'word', r: 're' } as const)[key.toLowerCase() as 'c'];
      if (flag) {
        event.preventDefault();
        this.flip(flag);
      }
    }
  }

  update(update: ViewUpdate) {
    let queryChanged = false;
    for (const tr of update.transactions)
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery)) {
          if (!effect.value.eq(this.query)) this.sync(effect.value);
          queryChanged = true;
        } else if (effect.is(setReplaceOpen)) this.setReplaceShown(effect.value);
      }
    if (queryChanged || update.docChanged) {
      this.list = null;
      this.rescan(quietMs);
    } else if (update.selectionSet) this.paint();
  }

  /** Recount after a quiet period; any newer change cancels a count still running. */
  private rescan(delay: number) {
    const token = ++this.run;
    clearTimeout(this.quiet);
    this.dom.setAttribute('aria-busy', 'true');
    const start = () => {
      if (token !== this.run) return;
      const state = this.view.state;
      const query = getSearchQuery(state);
      const list: MatchList = { from: [], to: [], capped: false };
      if (!query.search || !query.valid) {
        this.finish(list);
        return;
      }
      const cursor = query.getCursor(state);
      const slice = () => {
        if (token !== this.run) return;
        const began = performance.now();
        for (let counted = 1; ; counted++) {
          const next = cursor.next();
          if (next.done) break;
          list.from.push(next.value.from);
          list.to.push(next.value.to);
          if (list.from.length >= maxCounted) {
            list.capped = true;
            break;
          }
          if (counted % 32 === 0 && performance.now() - began > sliceMs) {
            this.quiet = setTimeout(slice, 0);
            return;
          }
        }
        this.finish(list);
      };
      slice();
    };
    if (delay) this.quiet = setTimeout(start, delay);
    else start();
  }

  private finish(list: MatchList) {
    this.list = list;
    this.dom.removeAttribute('aria-busy');
    this.paint();
  }

  private paint() {
    const query = getSearchQuery(this.view.state);
    const text = countLabel(this.list, this.view.state.selection.main, query.search, query.valid);
    if (this.count.textContent !== text) this.count.textContent = text;
    this.count.toggleAttribute('data-empty', text === 'No results' || text === 'Invalid');
  }
}

/** Ctrl+H: open the find widget with the replace row showing and the replace field focused. */
export function openReplace(view: EditorView): boolean {
  if (view.state.readOnly) return openSearchPanel(view);
  openSearchPanel(view);
  const dom = view.dom.querySelector<HTMLElement>('.cm-search');
  const widget = dom && widgets.get(dom);
  if (!widget) return false;
  widget.focusReplace();
  return true;
}

/** Replaces the default panel with the compact widget; spread into the search() configuration. */
export function findWidgetPanel(view: EditorView): Panel {
  return new FindWidget(view);
}

export const findWidgetExtension: Extension = replaceOpenField;
