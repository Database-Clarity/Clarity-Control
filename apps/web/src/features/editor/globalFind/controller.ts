import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getSearchQuery } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import { useDataStore } from '../../../stores/data';
import { useDraftStore } from '../../../stores/drafts';
import { rawMode } from '../symbols';
import { FindClient, entryFor, type FindResponse } from './client';
import { globalFindHost, globalFindIndex, openResult } from './host';
import { Results } from './Results';
import styles from './Scope.module.scss';

type Scope = 'entry' | 'category' | 'all';
let nextId = 0;

/** The CodeMirror panel owns its input; React owns only the existing portal surface. */
export class GlobalFindController {
  private readonly id = `global-find-${++nextId}`;
  scope: Scope = 'entry';
  private root: Root;
  private mount: HTMLElement;
  private client: FindClient | undefined;
  private language: string | undefined;
  private response: FindResponse = { results: [], capped: false };
  private active = 0;
  private open = false;
  private pending = false;
  private failed = false;
  private buttons: HTMLButtonElement[] = [];
  private options = '';
  private disposed = false;

  constructor(
    private view: EditorView,
    private anchor: HTMLElement,
    rows: HTMLElement,
    private input: HTMLInputElement,
    private changed: () => void,
  ) {
    this.mount = document.createElement('div');
    this.root = createRoot(this.mount);
    const scopes = document.createElement('div');
    scopes.className = styles.scopes;
    scopes.setAttribute('role', 'group');
    scopes.setAttribute('aria-label', 'Search scope');
    for (const [scope, label] of [
      ['entry', 'This entry'],
      ['category', 'Category'],
      ['all', 'All'],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fw-button fw-text';
      button.textContent = label;
      button.setAttribute('aria-pressed', String(scope === this.scope));
      button.addEventListener('click', () => this.setScope(scope));
      scopes.append(button);
      this.buttons.push(button);
    }
    rows.prepend(scopes);
    rows.append(this.mount);
    // The search input remains the sole focus owner for keyboard result navigation.
  }

  setScope(scope: Scope) {
    this.scope = scope;
    this.options = '';
    this.open = scope !== 'entry';
    this.anchor.dataset.scope = scope;
    this.buttons.forEach((button, index) =>
      button.setAttribute(
        'aria-pressed',
        String(index === ['entry', 'category', 'all'].indexOf(scope)),
      ),
    );
    this.changed();
    this.input.focus();
    this.update(true);
  }

  update(force = false) {
    if (this.scope === 'entry') {
      this.paint();
      return;
    }
    const host = this.view.state.facet(globalFindHost);
    if (!host) return;
    if (!this.client || this.language !== host.lang) {
      this.client = this.view.plugin(globalFindIndex)?.client ?? new FindClient(host.lang);
      this.language = host.lang;
      this.client.onPending = () => {
        this.pending = true;
        this.paint();
      };
      this.client.onError = () => {
        this.failed = true;
        this.pending = false;
        this.paint();
      };
      force = true;
    }
    const query = getSearchQuery(this.view.state);
    const data = useDataStore.getState().data;
    const hash = host.selfHash();
    const tooltip =
      hash === undefined
        ? undefined
        : (useDraftStore.getState().drafts[hash]?.next ?? data?.bundle.tooltips[hash]);
    const categoryId = data && tooltip ? entryFor(tooltip, data, host.lang)?.categoryId : undefined;
    const options = {
      search: query.search,
      caseSensitive: query.caseSensitive,
      wholeWord: query.wholeWord,
      raw: this.view.state.field(rawMode, false) ?? false,
      ...(this.scope === 'category' ? { categoryId: categoryId ?? '\0' } : {}),
    };
    const key = JSON.stringify(options);
    if (!force && key === this.options) return;
    this.options = key;
    this.pending = true;
    this.failed = false;
    this.active = 0;
    this.open = Boolean(query.search);
    this.client.query(options, (response) => {
      this.response = response;
      this.pending = false;
      this.active = Math.min(this.active, Math.max(0, response.results.length - 1));
      this.paint();
    });
    this.paint();
  }

  step(direction: number) {
    if (!this.response.results.length || this.pending) return;
    this.open = true;
    this.active =
      (this.active + direction + this.response.results.length) % this.response.results.length;
    this.paint();
  }

  activate() {
    if (this.pending) return;
    const result = this.response.results[this.active];
    if (!result) return;
    this.open = false;
    this.paint();
    openResult(this.view, result);
  }

  keydown(event: KeyboardEvent): boolean {
    if (this.scope === 'entry') return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      this.step(event.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    if (event.key === 'Enter' && event.target === this.input && !event.isComposing) {
      if (!event.altKey && !event.ctrlKey && !event.metaKey) this.activate();
      return true;
    }
    // Replace shortcuts must never modify a document in a global scope.
    return event.key === 'Enter' && (event.altKey || event.ctrlKey || event.metaKey);
  }

  private paint() {
    if (this.disposed) return;
    const shown =
      this.scope !== 'entry' && this.open && Boolean(getSearchQuery(this.view.state).search);
    this.input.setAttribute('aria-expanded', String(shown));
    if (this.scope !== 'entry') {
      this.input.setAttribute('role', 'combobox');
      this.input.setAttribute('aria-autocomplete', 'list');
    } else {
      this.input.removeAttribute('role');
      this.input.removeAttribute('aria-autocomplete');
      this.input.removeAttribute('aria-expanded');
    }
    if (shown) {
      this.input.setAttribute('aria-controls', `${this.id}-results`);
      if (!this.pending && this.response.results.length)
        this.input.setAttribute('aria-activedescendant', `${this.id}-result-${this.active}`);
      else this.input.removeAttribute('aria-activedescendant');
    } else {
      this.input.removeAttribute('aria-controls');
      this.input.removeAttribute('aria-activedescendant');
    }
    this.root.render(
      createElement(Results, {
        anchor: this.anchor,
        id: this.id,
        open: shown,
        response: this.response,
        pending: this.pending,
        failed: this.failed,
        active: this.active,
        onClose: () => {
          this.open = false;
          this.paint();
        },
        onOpen: (result) => {
          this.open = false;
          this.paint();
          openResult(this.view, result);
        },
      }),
    );
  }

  destroy() {
    this.disposed = true;
    if (this.client !== this.view.plugin(globalFindIndex)?.client) this.client?.destroy();
    // CodeMirror can destroy a panel in a React commit; defer the nested-root unmount.
    const root = this.root;
    queueMicrotask(() => root.unmount());
  }
}
