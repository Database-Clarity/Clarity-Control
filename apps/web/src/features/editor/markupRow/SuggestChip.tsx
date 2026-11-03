import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { EditorView } from '@codemirror/view';
import { acceptChip, dismissChip, markChipShown, type Chip, type ChipKey } from './chips';
import { EntryGlyph } from './EntryGlyph';
import styles from './SuggestChip.module.scss';

interface Placement {
  left: number;
  top: number;
}

const gap = 3;
const edge = 8;

/**
 * Under the last line of the text the chip is about (or over its first line when there is no room
 * below), so it can never sit on any character it concerns. Nothing is ever pushed aside: the
 * chip is fixed to the window and takes no space in the text.
 */
export function placeChip(
  view: EditorView,
  chip: Chip,
  size: { width: number; height: number },
): Placement | null {
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop ?? 0;
  const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
  const scroller = view.scrollDOM.getBoundingClientRect();
  const last = view.coordsAtPos(chip.covers.to, -1) ?? view.coordsAtPos(chip.covers.to);
  const first = view.coordsAtPos(chip.covers.from, 1) ?? view.coordsAtPos(chip.covers.from);
  if (!last || !first) return null;
  // Both ends of the text are out of the editor's window: the chip goes with them.
  if (last.bottom <= scroller.top || first.top >= scroller.bottom) return null;
  // The page itself can scroll (a phone): text outside the visible window takes the chip with it.
  if (last.bottom <= top || first.top >= bottom) return null;
  const limit = Math.min(bottom, scroller.bottom);
  const left = Math.min(
    Math.max(edge, scroller.left + 4, last.left),
    Math.max(edge, window.innerWidth - size.width - edge),
  );
  const below = last.bottom + gap;
  if (below + size.height <= limit) return { left, top: below };
  const above = first.top - gap - size.height;
  if (above >= Math.max(top, scroller.top)) return { left, top: above };
  return null;
}

export function SuggestChip({
  chip,
  view,
  acceptKey,
}: {
  chip: Chip;
  view: EditorView;
  acceptKey: ChipKey;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const box = surface.current?.getBoundingClientRect();
      setPlacement(placeChip(view, chip, { width: box?.width ?? 280, height: box?.height ?? 26 }));
    };
    measure();
    const scroller = view.scrollDOM;
    scroller.addEventListener('scroll', measure, { passive: true });
    // Capture: a scrolling page or pane does not bubble its scroll event to the window.
    window.addEventListener('scroll', measure, { capture: true, passive: true });
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      scroller.removeEventListener('scroll', measure);
      window.removeEventListener('scroll', measure, { capture: true });
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [view, chip]);

  // Enter and Tab take the offer only while it can be seen.
  useEffect(() => {
    markChipShown(view, placement !== null);
    return () => markChipShown(view, false);
  }, [view, placement]);

  const style = {
    '--chip-left': `${placement?.left ?? 0}px`,
    '--chip-top': `${placement?.top ?? 0}px`,
    visibility: placement ? 'visible' : 'hidden',
  } as CSSProperties;
  return createPortal(
    <div
      ref={surface}
      className={styles.chip}
      style={style}
      role="status"
      data-suggest-chip
      // Pressing it never takes focus from the text: the caret and selection it concerns stay put.
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className={styles.accept}
        onClick={() => {
          acceptChip(view);
        }}
        aria-label={`Insert ${chip.markup}`}
      >
        {chip.glyph && <EntryGlyph glyph={chip.glyph} />}
        <code className={styles.markup}>{chip.markup}</code>
        <span className={styles.text}>{chip.text}</span>
        <kbd>{acceptKey === 'tab' ? 'Tab' : 'Enter'}</kbd>
      </button>
      <button
        type="button"
        className={styles.dismiss}
        onClick={() => dismissChip(view)}
        aria-label="Dismiss suggestion"
      >
        <span className={styles.esc}>Esc</span>
        <span className={styles.cross} aria-hidden="true">
          ×
        </span>
      </button>
    </div>,
    document.body,
  );
}
