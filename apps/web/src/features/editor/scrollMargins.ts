import { EditorView } from '@codemirror/view';

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

/** Keeps the caret clear of the editor's own overlays and of the shell's notice strip. */
export function editorScrollMargins() {
  return EditorView.scrollMargins.of((view) => {
    const overlays = [...document.querySelectorAll<HTMLElement>(coverSelector)].filter(
      (element) => !element.hasAttribute('data-editor-overlay') || isOver(element, view),
    );
    if (!overlays.length) return null;
    const scroller = view.scrollDOM.getBoundingClientRect();
    const covers = overlays
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const margins = coverMargins(scroller, covers);
    return margins.top || margins.bottom ? margins : null;
  });
}

function isOver(overlay: HTMLElement, view: EditorView): boolean {
  return overlay.closest('[data-editor-root]')?.contains(view.dom) ?? false;
}
