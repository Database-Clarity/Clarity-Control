import { Facet, Transaction } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import type { ReferenceHost } from '../referenceActions';
import type { FindResult } from './index';
import { toggleRaw } from '../symbols';
import { FindClient } from './client';

export const globalFindHost = Facet.define<ReferenceHost, ReferenceHost | undefined>({
  combine: (values) => values.at(-1),
});
let pending: FindResult | undefined;
export const globalFindIndex = ViewPlugin.define((view) => {
  const host = view.state.facet(globalFindHost);
  const client = host?.navigate() ? new FindClient(host.lang) : undefined;
  return {
    client,
    lang: host?.lang,
    update(update) {
      const next = update.state.facet(globalFindHost);
      if (next?.lang === this.lang) return;
      this.client?.destroy();
      this.lang = next?.lang;
      this.client = next?.navigate() ? new FindClient(next.lang) : undefined;
    },
    destroy() {
      this.client?.destroy();
    },
  };
});

export function openResult(view: EditorView, result: FindResult) {
  const host = view.state.facet(globalFindHost);
  if (!host?.navigate()) return;
  pending = result;
  if (host.selfHash() === result.hash && host.lang === result.lang) selectPending(view);
  else
    host.navigate()!({
      type: 'tooltip',
      hash: result.hash,
      lang: result.lang as ReferenceHost['lang'],
      line: result.line,
    });
}

function selectPending(view: EditorView) {
  const result = pending;
  const host = view.state.facet(globalFindHost);
  if (!result || host?.selfHash() !== result.hash || host.lang !== result.lang) return;
  pending = undefined;
  // Discard a result invalidated by a concurrent edit rather than selecting unrelated text.
  if (
    result.to > view.state.doc.length ||
    view.state.sliceDoc(result.from, result.to) !== result.matched
  )
    return;
  view.dispatch({
    selection: { anchor: result.from, head: result.to },
    effects: [toggleRaw.of(result.raw), EditorView.scrollIntoView(result.from, { y: 'center' })],
    annotations: Transaction.addToHistory.of(false),
    userEvent: 'select.search',
  });
  view.focus();
}

export function globalFindExtension(host: ReferenceHost) {
  return [
    globalFindHost.of(host),
    globalFindIndex,
    ViewPlugin.define((view) => {
      let frame = requestAnimationFrame(() => selectPending(view));
      return {
        update() {
          if (!pending) return;
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => selectPending(view));
        },
        destroy() {
          cancelAnimationFrame(frame);
        },
      };
    }),
  ];
}
