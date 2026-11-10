import { EditorSelection, type EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  dockedBarHeight,
  dockedStatusClear,
  dockedTopChrome,
  stickyChromeBottom,
} from './markupRow/dock';

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * How far each edge of the editor's scroller is covered by something drawn over it (an open
 * status-bar panel, a notice hanging from the header). A cover in the lower half hides the bottom
 * of the text, one in the upper half the top. Scrolling the caret into view keeps these clear, so
 * the caret stays visible by scrolling and nothing is ever resized or reflowed to make room.
 */
export function coverMargins(
  scroller: Box,
  covers: readonly Box[],
  gap = 8,
): { top: number; bottom: number } {
  const middle = (scroller.top + scroller.bottom) / 2;
  let top = 0;
  let bottom = 0;
  for (const cover of covers) {
    const overlaps =
      cover.right > scroller.left &&
      cover.left < scroller.right &&
      cover.bottom > scroller.top &&
      cover.top < scroller.bottom;
    if (!overlaps) continue;
    if ((cover.top + cover.bottom) / 2 >= middle)
      bottom = Math.max(bottom, scroller.bottom - cover.top + gap);
    else top = Math.max(top, cover.bottom - scroller.top + gap);
  }
  return { top, bottom };
}

const coverSelector = '[data-editor-overlay], [data-notice-strip]';

/**
 * The docked markup bar (a phone) covers the bottom of the visible page, not of the scroller (the
 * page scrolls there), and the sticky header and pane tabs cover its top. Both come from heights
 * cached off the typing path (markupRow/dock.ts), never from the layout.
 */
function dockMargins(view?: EditorView): { top: number; bottom: number } | null {
  const bar = dockedBarHeight();
  if (!bar) return null;
  return { top: dockedTopChrome() + 8, bottom: bar + Math.max(8, statusBelowEnd(view)) };
}

/**
 * On the last line the editor's status bar sits right under the caret: the margin clears all of it
 * rather than leaving its top edge peeking over the docked bar. Its reach is cached off the input
 * path (markupRow/dock.ts); here only the document is asked which line the caret is on.
 */
function statusBelowEnd(view?: EditorView): number {
  if (!view) return 0;
  const { doc, selection } = view.state;
  return doc.lineAt(selection.main.head).number === doc.lines ? dockedStatusClear() : 0;
}

/** Keeps the caret clear of the editor's own overlays, the shell's notice strip, and the docked bar. */
export function editorScrollMargins() {
  return EditorView.scrollMargins.of((view) => {
    const dock = dockMargins(view);
    // Read once per entry change (measure phase), never while typing.
    const top = entryTopMargin(view);
    if (top !== null) return { top, bottom: dock?.bottom ?? 0 };
    const overlays = [...document.querySelectorAll<HTMLElement>(coverSelector)].filter(
      (element) => !element.hasAttribute('data-editor-overlay') || isOver(element, view),
    );
    if (!overlays.length) return dock;
    const scroller = view.scrollDOM.getBoundingClientRect();
    const covers = overlays
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const margins = coverMargins(scroller, covers);
    if (dock) {
      margins.top = Math.max(margins.top, dock.top);
      margins.bottom = Math.max(margins.bottom, dock.bottom);
    }
    return margins.top || margins.bottom ? margins : null;
  });
}

/** The caret's paragraph: the lines around it up to the nearest blank line on either side. */
export function paragraphAt(state: EditorState, pos: number): { from: number; to: number } {
  const doc = state.doc;
  const line = doc.lineAt(pos);
  if (!line.text.trim()) return { from: line.from, to: line.to };
  let first = line.number;
  let last = line.number;
  while (first > 1 && doc.line(first - 1).text.trim()) first--;
  while (last < doc.lines && doc.line(last + 1).text.trim()) last++;
  return { from: doc.line(first).from, to: doc.line(last).to };
}

/** Lines of context kept around the caret when its paragraph is taller than the visible band. */
const contextLines = 3;

/**
 * The keyboard opened (the visible band shrank) while the text has focus: keep the whole paragraph
 * at the caret in view when it fits between the sticky chrome and the docked bar, else the caret's
 * line with a few lines of context. Scrolls only what is out of view (CodeMirror's "nearest"), so
 * a paragraph already in view stays put. Heights come from the height map, not the DOM.
 */
export function keepParagraphInView(view: EditorView, band: { top: number; bottom: number }) {
  const head = view.state.selection.main.head;
  const paragraph = paragraphAt(view.state, head);
  const height = view.lineBlockAt(paragraph.to).bottom - view.lineBlockAt(paragraph.from).top;
  const margins = dockMargins(view) ?? { top: 8, bottom: 8 };
  // `band` already leaves out the docked bar; what stays is its margin's own gap, or the status bar
  // under the last line (a paragraph that fits only by hiding it is taller than the room).
  const room = band.bottom - band.top - margins.top - (margins.bottom - dockedBarHeight());
  if (height <= room) {
    view.dispatch({
      effects: EditorView.scrollIntoView(EditorSelection.range(paragraph.to, paragraph.from), {
        y: 'nearest',
      }),
    });
    return;
  }
  view.dispatch({
    effects: EditorView.scrollIntoView(head, {
      y: 'nearest',
      yMargin: contextLines * view.defaultLineHeight,
    }),
  });
}

/**
 * An overlay drawn inside this editor, or portalled beside it (the markup help sits in the
 * workspace so it can span the editor and the pane beside it: `data-editor-portal`, in the
 * element that holds the editor).
 */
function isOver(overlay: HTMLElement, view: EditorView): boolean {
  const owner = overlay.hasAttribute('data-editor-portal')
    ? overlay.parentElement
    : overlay.closest('[data-editor-root]');
  return owner?.contains(view.dom) ?? false;
}

/** Editors whose next caret scroll shows a newly opened entry from its top (a phone). */
const entryTop = new WeakSet<EditorView>();

/**
 * Another entry was opened or stepped to on a phone, where the page scrolls rather than the
 * editor: show it from its top. A page scrolled past the editor's top (the previous entry's
 * scroll) comes back just far enough that the editor, with its tools, starts under the sticky
 * header and tabs; a page showing the top already stays put ("nearest"). It is CodeMirror's own
 * scroll, so its scroll anchoring (it keeps the text under a focused caret still) agrees with it.
 */
export function entryTopScroll(view: EditorView) {
  entryTop.add(view);
  return EditorView.scrollIntoView(0, { y: 'nearest' });
}

/** The entry-top margin: the sticky chrome plus the editor's own tools above its first line. */
function entryTopMargin(view: EditorView): number | null {
  if (!entryTop.delete(view)) return null;
  const root = view.dom.closest('[data-editor-root]') ?? view.dom;
  return (
    stickyChromeBottom(view.dom.ownerDocument) +
    Math.max(0, view.documentTop - root.getBoundingClientRect().top)
  );
}
