/**
 * Report highlights on rendered tooltip text, drawn without touching the renderer: ranges go to
 * the CSS Custom Highlight API (`CSS.highlights`, styled by `::highlight()`), which paints over
 * the text and never changes a line box. Browsers without the API get a transparent overlay
 * placed from `Range.getClientRects()` (HighlightLayer). Number badges are always absolutely
 * placed elements in that layer, so neither path moves text.
 *
 * Each owner (a pane, a copy) publishes its marks under its own key; clearing the key removes
 * exactly its marks.
 */

export interface ReportMark {
  range: Range;
  /** The badge number shown at the start of the range and beside the note in the pane. */
  n: number;
  /** The report this mark belongs to (click selects it). */
  report: string;
  selected: boolean;
}

export const highlightName = 'clarity-report';
export const selectedHighlightName = 'clarity-report-selected';

const marks = new Map<string, ReportMark[]>();
const listeners = new Set<() => void>();
let version = 0;

interface HighlightRegistry {
  set(name: string, value: unknown): void;
  delete(name: string): boolean;
}
type HighlightConstructor = new (...ranges: Range[]) => unknown;

function registry(): { highlights: HighlightRegistry; Highlight: HighlightConstructor } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Highlight = (globalThis as { Highlight?: HighlightConstructor }).Highlight;
  return css?.highlights && Highlight ? { highlights: css.highlights, Highlight } : null;
}

/** True where the CSS Custom Highlight API draws the marks (no overlay needed). */
export function nativeHighlights(): boolean {
  return registry() !== null;
}

function apply() {
  version++;
  const api = registry();
  if (api) {
    const all = [...marks.values()].flat();
    const plain = all.filter((mark) => !mark.selected).map((mark) => mark.range);
    const selected = all.filter((mark) => mark.selected).map((mark) => mark.range);
    if (plain.length) api.highlights.set(highlightName, new api.Highlight(...plain));
    else api.highlights.delete(highlightName);
    if (selected.length) api.highlights.set(selectedHighlightName, new api.Highlight(...selected));
    else api.highlights.delete(selectedHighlightName);
  }
  for (const listener of listeners) listener();
}

export function setReportMarks(key: string, next: ReportMark[]) {
  const previous = marks.get(key);
  if (!next.length && !previous) return;
  if (next.length) marks.set(key, next);
  else marks.delete(key);
  apply();
}

export function clearReportMarks(key: string) {
  if (marks.delete(key)) apply();
}

export function allReportMarks(): ReportMark[] {
  return [...marks.values()].flat();
}

export function subscribeReportMarks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reportMarksVersion(): number {
  return version;
}

/** The mark under a viewport point, if any (highlights have no element to click). */
export function markAtPoint(x: number, y: number): ReportMark | undefined {
  const all = allReportMarks();
  if (!all.length) return undefined;
  const doc = document as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };
  let node: Node | undefined;
  let offset = 0;
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) {
    node = position.offsetNode;
    offset = position.offset;
  } else {
    const range = doc.caretRangeFromPoint?.(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node) return undefined;
  // Prefer the rect test: a caret at a range's end edge is "in" the range but beside the text.
  return all.find((mark) => {
    try {
      if (!mark.range.isPointInRange(node, offset)) return false;
    } catch {
      return false;
    }
    return [...mark.range.getClientRects()].some(
      (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
    );
  });
}
