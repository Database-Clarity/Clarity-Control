import { useEffect, type RefObject } from 'react';
import type { CompendiumCell, CompendiumData } from '@clarity/core';

const prepared = new WeakMap<CompendiumData, Set<string>>();
const latin = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).join('');

/** Prepare native sheet faces without borrowing time from input or pane commits. */
export function warmPaneFontMetrics(source: CompendiumData, family: string, zoom: number) {
  const key = `${family}|${zoom}`;
  if (typeof CanvasRenderingContext2D === 'undefined' || prepared.get(source)?.has(key))
    return () => {};
  let fontCount = 0;
  function* cells(): Generator<CompendiumCell> {
    for (const tab of source.tabs) {
      for (const row of tab.rows) yield row.cell;
      for (const entry of tab.grid ?? []) yield entry.cell;
    }
  }
  function* units() {
    const fonts = new Map<string, number>();
    let scanned = 0;
    for (const cell of cells())
      for (const run of cell.runs) {
        const font = `${run.italic ? 'italic ' : ''}${run.bold ? 700 : 400} ${((run.sizePt ?? 10) * 4 * zoom) / 3}px ${family}`;
        fonts.set(font, (fonts.get(font) ?? 0) + 1);
        if (++scanned % 64 === 0) yield;
      }
    // Cover every row and grid face. Common source styles come first, without
    // consulting the current tooltip or its navigation path. Latin metrics
    // avoid an uninterruptible OS fallback search for unusual source glyphs.
    const ordered = [...fonts].sort((left, right) => right[1] - left[1]);
    fontCount = ordered.length;
    for (let pass = 0; pass < 2; pass++)
      for (const [font] of ordered)
        for (let index = 0; index < latin.length; index += 8)
          yield { font, text: latin.slice(index, index + 8) };
  }
  const work = units();
  const controller = new AbortController();
  let idle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let context: CanvasRenderingContext2D | null | undefined;
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
    if (controller.signal.aborted || prepared.get(source)?.has(key)) return;
    const start = performance.now();
    while (
      !inputPending() &&
      performance.now() - start < 1 &&
      (!deadline || deadline.timeRemaining() > 2)
    ) {
      const next = work.next();
      if (next.done) {
        maxSliceMs = Math.max(maxSliceMs, performance.now() - start);
        let keys = prepared.get(source);
        if (!keys) prepared.set(source, (keys = new Set()));
        keys.add(key);
        performance.mark('compendium:pane-fonts-prepared', {
          detail: { zoom, fontCount, maxUnitMs, maxSliceMs },
        });
        return;
      }
      if (!next.value) continue;
      const began = performance.now();
      if (context === undefined) context = document.createElement('canvas').getContext('2d');
      if (!context) return;
      context.font = next.value.font;
      context.measureText(next.value.text);
      maxUnitMs = Math.max(maxUnitMs, performance.now() - began);
    }
    maxSliceMs = Math.max(maxSliceMs, performance.now() - start);
    schedule();
  }
  void (document.fonts?.ready ?? Promise.resolve()).then(schedule);
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
    if (!source || !zoom) return;
    return warmPaneFontMetrics(source, getComputedStyle(zoom).fontFamily, scale / 100);
  }, [body, source, scale]);
}
