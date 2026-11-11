import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  allReportMarks,
  nativeHighlights,
  subscribeReportMarks,
  type ReportMark,
} from '../highlights';
import styles from './ReportsPane.module.scss';

interface Placed {
  key: string;
  n: number;
  selected: boolean;
  badge: { left: number; top: number } | null;
  /** Fallback only: the tint rectangles where the browser has no CSS Custom Highlight API. */
  rects: { left: number; top: number; width: number; height: number }[];
}

/** The visible box of an element after every clipping ancestor (scrolling panes, the column). */
function clipBox(element: Element | null) {
  let box = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  for (let node = element; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const rect = node.getBoundingClientRect();
    box = {
      left: Math.max(box.left, rect.left),
      top: Math.max(box.top, rect.top),
      right: Math.min(box.right, rect.right),
      bottom: Math.min(box.bottom, rect.bottom),
    };
  }
  return box;
}

function place(marks: ReportMark[], native: boolean): Placed[] {
  const placed: Placed[] = [];
  const seen = new Set<string>();
  marks.forEach((mark, index) => {
    const rects = [...mark.range.getClientRects()].filter((rect) => rect.width > 0);
    if (!rects.length) return;
    const parent =
      mark.range.startContainer instanceof Element
        ? mark.range.startContainer
        : mark.range.startContainer.parentElement;
    const clip = clipBox(parent);
    const inside = (rect: DOMRect) =>
      rect.bottom > clip.top &&
      rect.top < clip.bottom &&
      rect.right > clip.left &&
      rect.left < clip.right;
    // A footnote after the marked words: the end of the last line box, raised to its top, so it
    // never covers the line above.
    const last = rects[rects.length - 1]!;
    // One badge per number and body: a note can resolve in two previews (Compare).
    const badgeKey = `${mark.n}:${Math.round(last.right)}:${Math.round(last.top)}`;
    const badge = inside(last) && !seen.has(badgeKey) ? { left: last.right, top: last.top } : null;
    seen.add(badgeKey);
    placed.push({
      key: `${index}:${mark.report}:${mark.n}`,
      n: mark.n,
      selected: mark.selected,
      badge,
      rects: native
        ? []
        : rects.filter(inside).map((rect) => ({
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          })),
    });
  });
  return placed;
}

/**
 * Number badges (and, without the highlight API, tint rectangles) for every published mark, in a
 * fixed layer outside the rendered text: they move nothing. Positions follow scrolling, resizes,
 * and mark changes, one placement per frame.
 */
export function HighlightLayer() {
  const [placed, setPlaced] = useState<Placed[]>([]);
  useEffect(() => {
    const native = nativeHighlights();
    let frame = 0;
    let last = '[]';
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Scrolling elsewhere (the editor, while typing) moves no badge: no render then.
        const next = place(allReportMarks(), native);
        const signature = JSON.stringify(next);
        if (signature === last) return;
        last = signature;
        setPlaced(next);
      });
    };
    const unsubscribe = subscribeReportMarks(update);
    window.addEventListener('scroll', update, { capture: true, passive: true });
    window.addEventListener('resize', update);
    // Layout can move a range without any scroll (the column resized, text reflowed).
    const sizes = new ResizeObserver(update);
    sizes.observe(document.documentElement);
    const shell = document.getElementById('shell-root');
    if (shell) sizes.observe(shell);
    update();
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      sizes.disconnect();
      window.removeEventListener('scroll', update, { capture: true });
      window.removeEventListener('resize', update);
    };
  }, []);
  if (!placed.length) return null;
  return createPortal(
    <div className={styles.layer} aria-hidden="true">
      {placed.map((mark) => (
        <span key={mark.key}>
          {mark.rects.map((rect, index) => (
            <span
              key={index}
              className={styles.fallbackMark}
              data-selected={mark.selected || undefined}
              style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
            />
          ))}
          {mark.badge && (
            <span
              className={styles.badge}
              data-selected={mark.selected || undefined}
              style={{ left: mark.badge.left, top: mark.badge.top }}
            >
              {mark.n}
            </span>
          )}
        </span>
      ))}
    </div>,
    document.body,
  );
}
