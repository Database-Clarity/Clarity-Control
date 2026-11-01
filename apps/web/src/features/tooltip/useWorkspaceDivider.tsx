import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import styles from './TooltipPage.module.scss';

const STORAGE_KEY = 'description-editor-split';
const DEFAULT_SPLIT = 50;
const MIN_PANE = 240;
const HANDLE_WIDTH = 16;

function readSplit() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null && saved.trim() !== '') {
      const value = Number(saved);
      if (Number.isFinite(value)) return value;
    }
  } catch { /* The preference is optional. */ }
  return DEFAULT_SPLIT;
}

export function useWorkspaceDivider() {
  const container = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const [width, setWidth] = useState(0);
  const [split, setSplit] = useState(readSplit);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => setWidth(element.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const available = Math.max(0, width - HANDLE_WIDTH);
  const min = available >= MIN_PANE * 2 ? MIN_PANE / available * 100 : 50;
  const max = 100 - min;
  const value = Math.max(min, Math.min(max, split));
  function change(next: number) {
    const clamped = Math.max(min, Math.min(max, next));
    setSplit(clamped);
    try { localStorage.setItem(STORAGE_KEY, String(clamped)); } catch { /* Optional preference. */ }
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (dragging.current !== event.pointerId || !container.current || !available) return;
    change((event.clientX - container.current.getBoundingClientRect().left - HANDLE_WIDTH / 2) / available * 100);
  }
  function finish(event: PointerEvent<HTMLDivElement>) {
    if (dragging.current !== event.pointerId) return;
    dragging.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    const next = event.key === 'ArrowLeft' ? value - 2 : event.key === 'ArrowRight' ? value + 2 : event.key === 'Home' ? min : event.key === 'End' ? max : null;
    if (next === null) return;
    event.preventDefault();
    change(next);
  }
  const separator = (
    <div className={styles.divider} role="separator" aria-label="Resize editor and preview"
      aria-orientation="vertical" aria-valuemin={Math.round(min)} aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)} tabIndex={0} onKeyDown={keyboard}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        dragging.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}
      onLostPointerCapture={() => { dragging.current = null; }}
      onDoubleClick={() => {
        setSplit(DEFAULT_SPLIT);
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* Optional preference. */ }
      }}
    />
  );
  return { container, separator, style: { '--editor-width': `calc(${value}% - ${HANDLE_WIDTH * value / 100}px)` } as CSSProperties };
}
