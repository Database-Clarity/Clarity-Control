import { EditorView } from '@codemirror/view';

const dockSelector = 'section[aria-label="Save drafts"]';

/**
 * Bottom scroll margin needed so a fixed bottom dock never covers the caret. The save dock is
 * only `position: fixed` at the mobile breakpoint, and `display: none` (height 0) while idle.
 */
export function dockScrollMargin(height: number, position: string, gap = 8): number {
  return position === 'fixed' && height > 0 ? height + gap : 0;
}

/** Keeps the caret above the docked save bar when CodeMirror scrolls it into view. */
export function saveDockScrollMargins() {
  return EditorView.scrollMargins.of(() => {
    const dock = document.querySelector<HTMLElement>(dockSelector);
    const bottom = dock ? dockScrollMargin(dock.offsetHeight, getComputedStyle(dock).position) : 0;
    return bottom ? { bottom } : null;
  });
}
