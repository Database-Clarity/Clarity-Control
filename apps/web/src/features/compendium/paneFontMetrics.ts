import { useEffect, type RefObject } from 'react';
import type { CompendiumData } from '@clarity/core';

const prepared = new WeakMap<CompendiumData, Set<string>>();

/** Prepare native sheet faces without borrowing time from input or pane commits. */
export function warmPaneFontMetrics(source: CompendiumData, family: string, zoom: number) {
  const key = `${family}|${zoom}`;
  if (typeof CanvasRenderingContext2D === 'undefined' || prepared.get(source)?.has(key))
    return () => {};
  function* units() {
    const fonts = new Map<string, Set<string>>();
    let scanned = 0;
    for (const tab of source.tabs)
      for (const row of tab.rows)
        for (const run of row.cell.runs) {
          const font = `${run.italic ? 'italic ' : ''}${run.bold ? 700 : 400} ${((run.sizePt ?? 10) * 4 * zoom) / 3}px ${family}`;
          let glyphs = fonts.get(font);
          if (!glyphs) {
            fonts.set(font, (glyphs = new Set()));
            // Establish every face as it is discovered, before enumerating all
            // source glyphs. This ordering is independent of the current item.
            yield { font, text: 'Aa' };
          }
          for (const glyph of run.text) {
            if (glyph >= ' ') glyphs.add(glyph);
            if (++scanned % 128 === 0) yield;
          }
        }
    for (let pass = 0; pass < 2; pass++)
      for (const [font, glyphs] of fonts) {
        const text = [...glyphs];
        for (let index = 0; index < text.length; index += 8)
          yield { font, text: text.slice(index, index + 8).join('') };
      }
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
          detail: { zoom, maxUnitMs, maxSliceMs },
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
