import { EditorSelection, Facet, Transaction } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import type { ReferenceHost } from '../referenceActions';
import type { FindResult } from './index';
import { toggleRaw } from '../symbols';
import { FindClient } from './client';
import { phoneQuery } from '../../../ui/useMedia';
import { visibleBand } from '../../../ui/useKeyboardInset';
import { stickyChromeBottom } from '../markupRow/dock';

export const globalFindHost = Facet.define<ReferenceHost, ReferenceHost | undefined>({
  combine: (values) => values.at(-1),
});
let pending: FindResult | undefined;
const revealFrames = new WeakMap<EditorView, number>();

/** A route's initial scroll finishes first; then reveal the selected word in the phone's visible strip. */
function revealPhoneMatch(view: EditorView, result: FindResult) {
  if (!window.matchMedia?.(phoneQuery).matches) return;
  const previous = revealFrames.get(view);
  if (previous) cancelAnimationFrame(previous);
  revealFrames.set(
    view,
    requestAnimationFrame(() => {
      revealFrames.delete(view);
      view.requestMeasure({
        read() {
          const selection = view.state.selection.main;
          if (!view.hasFocus || selection.from !== result.from || selection.to !== result.to)
            return 0;
          const from = view.coordsAtPos(result.from, 1),
            to = view.coordsAtPos(result.to, -1);
          if (!from || !to) return 0;
          const band = visibleBand();
          const widget = view.dom.querySelector('.cm-search')?.getBoundingClientRect();
          const top = Math.max(band.top, stickyChromeBottom(), widget?.bottom ?? 0) + 8;
          const bottom = band.bottom - 8;
          if (bottom <= top) return 0;
          const first = Math.min(from.top, to.top),
            last = Math.max(from.bottom, to.bottom);
          return first < top ? first - top : last > bottom ? last - bottom : 0;
        },
        write(delta) {
          if (delta) window.scrollBy(0, delta);
        },
      });
    }),
  );
}
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
    effects: [
      toggleRaw.of(result.raw),
      EditorView.scrollIntoView(EditorSelection.range(result.from, result.to)),
    ],
    annotations: Transaction.addToHistory.of(false),
    userEvent: 'select.search',
  });
  view.focus();
  revealPhoneMatch(view, result);
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
          const reveal = revealFrames.get(view);
          if (reveal) cancelAnimationFrame(reveal);
          revealFrames.delete(view);
        },
      };
    }),
  ];
}
