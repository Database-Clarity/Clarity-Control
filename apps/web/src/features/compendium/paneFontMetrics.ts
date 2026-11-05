import { useEffect, type RefObject } from 'react';
import type { CompendiumCell, CompendiumData } from '@clarity/core';

const prepared = new WeakMap<CompendiumData, Set<string>>();
const latin = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).join('');
// Complete row/grid font census, ordered by overall source usage. Prepare while
// the source loads; runtime discovery extends this list for new source styles.
// No entry, category, or navigation path selects or changes this preparation.
const initialStyles = [
  [9, 1],
  [9, 2],
  [9, 3],
  [8, 1],
  [7, 1],
  [10, 1],
  [7, 2],
  [6, 1],
  [8, 2],
  [9, 0],
  [7, 3],
  [10, 3],
  [8, 3],
  [10, 2],
  [10, 0],
  [14, 1],
  [6, 2],
  [8, 0],
  [6, 3],
  [7, 0],
  [11, 1],
  [12, 1],
  [5, 2],
  [4, 1],
  [12, 2],
  [6, 0],
  [21, 3],
  [12, 3],
  [18, 1],
  [5, 3],
  [5, 1],
  [14, 3],
  [18, 3],
  [11, 2],
  [20, 1],
  [24, 3],
  [4, 2],
  [13, 3],
  [28, 1],
  [15, 1],
  [15, 3],
] as const;
const faces = new Map<string, { variants: Map<number, number>; count: number }>();

/** Prepare native sheet faces without borrowing time from input or pane commits. */
export function warmPaneFontMetrics(source: CompendiumData | null, family: string, zoom: number) {
  const key = `${family}|${zoom}`;
  if (typeof CanvasRenderingContext2D === 'undefined') return () => {};
  let state = faces.get(key);
  if (!state) {
    if (faces.size >= 8) faces.delete(faces.keys().next().value!);
    faces.set(key, (state = { variants: new Map(), count: 0 }));
  }
  const cached = state;
  const hasFace = (size: number, variant: number) =>
    !!((cached.variants.get(size) ?? 0) & (1 << variant));
  if (
    initialStyles.every(([size, variant]) => hasFace(size, variant)) &&
    (!source || prepared.get(source)?.has(key))
  )
    return () => {};
  function* cells(): Generator<CompendiumCell> {
    if (!source) return;
    for (const tab of source.tabs) for (const row of tab.rows) yield row.cell;
    for (const tab of source.tabs) for (const entry of tab.grid ?? []) yield entry.cell;
  }
  function* face(size: number, variant: number) {
    if (hasFace(size, variant)) return;
    const font = `${variant & 2 ? 'italic ' : ''}${variant & 1 ? 700 : 400} ${(size * 4 * zoom) / 3}px ${family}`;
    for (let index = 0; index < latin.length; index += 8)
      yield { font, text: latin.slice(index, index + 8) };
    cached.variants.set(size, (cached.variants.get(size) ?? 0) | (1 << variant));
    cached.count++;
  }
  function* units() {
    for (const [size, variant] of initialStyles) yield* face(size, variant);
    let scanned = 0;
    for (const cell of cells())
      for (const run of cell.runs) {
        const size = run.sizePt ?? 10;
        const variant = +!!run.bold + 2 * +!!run.italic;
        yield* face(size, variant);
        if (++scanned % 64 === 0) yield;
      }
  }
  const work = units();
  const controller = new AbortController();
  let idle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let context: CanvasRenderingContext2D | null | undefined;
  let currentFont: string | undefined;
  let maxUnitMs = 0;
  let maxSliceMs = 0;
  const tasks = (
    globalThis as typeof globalThis & {
      scheduler?: {
        postTask(
          callback: () => void,
          options: { priority: 'background'; signal: AbortSignal },
        ): Promise<unknown>;
      };
    }
  ).scheduler;
  const inputPending = () =>
    (
      navigator as Navigator & {
        scheduling?: { isInputPending(options: { includeContinuous: boolean }): boolean };
      }
    ).scheduling?.isInputPending({ includeContinuous: true }) ?? false;
  function fallback() {
    if (controller.signal.aborted) return;
    if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(run);
    else timer = setTimeout(() => run(), 16);
  }
  function schedule() {
    if (controller.signal.aborted) return;
    if (tasks && !inputPending())
      void tasks
        .postTask(() => run(), { priority: 'background', signal: controller.signal })
        .catch(fallback);
    else fallback();
  }
  function run(deadline?: IdleDeadline) {
    if (controller.signal.aborted) return;
    const start = performance.now();
    while (
      !inputPending() &&
      performance.now() - start < 1 &&
      (!deadline || deadline.timeRemaining() > 2)
    ) {
      const next = work.next();
      if (next.done) {
        maxSliceMs = Math.max(maxSliceMs, performance.now() - start);
        if (source) {
          let keys = prepared.get(source);
          if (!keys) prepared.set(source, (keys = new Set()));
          keys.add(key);
        }
        performance.mark('compendium:pane-fonts-prepared', {
          detail: { zoom, fontCount: cached.count, source: !!source, maxUnitMs, maxSliceMs },
        });
        return;
      }
      if (!next.value) continue;
      const began = performance.now();
      if (context === undefined) context = document.createElement('canvas').getContext('2d');
      if (!context) return;
      if (currentFont !== next.value.font) {
        context.font = next.value.font;
        currentFont = next.value.font;
      }
      context.measureText(next.value.text);
      maxUnitMs = Math.max(maxUnitMs, performance.now() - began);
    }
    maxSliceMs = Math.max(maxSliceMs, performance.now() - start);
    schedule();
  }
  // Latin uses the installed primary face; unrelated web fonts need not delay it.
  queueMicrotask(schedule);
  return () => {
    controller.abort();
    if (idle !== undefined) cancelIdleCallback(idle);
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** Only the mounted pane prepares its source revision and current zoom. */
export function usePaneFontMetrics(
  body: RefObject<HTMLElement>,
  source: CompendiumData | null,
  scale: number,
) {
  useEffect(() => {
    const zoom = body.current?.querySelector<HTMLElement>('[data-scale]');
    if (!zoom) return;
    return warmPaneFontMetrics(source, getComputedStyle(zoom).fontFamily, scale / 100);
  }, [body, source, scale]);
}
