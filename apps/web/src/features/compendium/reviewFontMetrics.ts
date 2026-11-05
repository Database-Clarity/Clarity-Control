import { useEffect, type RefObject } from 'react';
import type { CompendiumData } from '@clarity/core';

const prepared = new WeakMap<CompendiumData, Set<string>>();
const latin = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).join('');
const reviewFamily =
  'Arial, Helvetica, DestinySymbols, "Segoe UI Symbol", "Segoe UI Emoji", "Yu Gothic", sans-serif';

/** The review module is prefetched during idle time, before its first navigation. */
export function preloadReviewFontMetrics(source: CompendiumData) {
  let cancelled = false;
  let idle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  function prepare() {
    if (cancelled) return;
    if (
      (
        navigator as Navigator & {
          scheduling?: { isInputPending(options: { includeContinuous: boolean }): boolean };
        }
      ).scheduling?.isInputPending({ includeContinuous: true })
    ) {
      schedule();
      return;
    }
    cancel = warmReviewFontMetrics(
      source,
      reviewFamily,
      parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
  }
  function schedule() {
    if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(prepare);
    else timer = setTimeout(prepare, 16);
  }
  schedule();
  return () => {
    cancelled = true;
    if (idle !== undefined) cancelIdleCallback(idle);
    if (timer !== undefined) clearTimeout(timer);
    cancel();
  };
}

/** Populate text-face metrics only; uncommon glyphs can block in the OS font service. */
export function warmReviewFontMetrics(source: CompendiumData, family: string, rem: number) {
  const key = `${family}|${rem}`;
  if (prepared.get(source)?.has(key)) return () => {};
  let context: CanvasRenderingContext2D | null | undefined;
  function* units() {
    const fonts = new Set<string>();
    const sourceStyles = new Set<string>();
    let scanned = 0;
    for (const size of [0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.45, 1.65])
      for (const weight of [400, 700]) fonts.add(`${weight} ${size * rem}px ${family}`);
    // Enumerate every source style, independently of the selected category,
    // entry, or navigation sequence. Enumeration itself must yield as well.
    for (const tab of source.tabs)
      // Nearby context uses the physical grid, including heading/caption styles
      // that never appear in the extracted matching rows.
      for (const cells of [tab.rows, tab.grid ?? []])
        for (const row of cells)
          for (const run of row.cell.runs) {
            const style = `${+!!run.bold}${+!!run.italic}:${run.sizePt ?? 'default'}`;
            if (!sourceStyles.has(style)) {
              sourceStyles.add(style);
              fonts.add(
                `${run.italic ? 'italic ' : ''}${run.bold ? 700 : 400} ${run.sizePt === undefined ? `${0.95 * rem}px` : `${run.sizePt}pt`} ${family}`,
              );
            }
            if (++scanned % 64 === 0) yield;
          }
    for (let pass = 0; pass < 2; pass++)
      for (let start = 0; start < latin.length; start += 8)
        for (const font of fonts) yield { font, text: latin.slice(start, start + 8) };
  }
  const work = units();
  const started = performance.now();
  let cancelled = false;
  let idle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
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
  const controller = new AbortController();
  const inputPending = () =>
    (
      navigator as Navigator & {
        scheduling?: { isInputPending(options: { includeContinuous: boolean }): boolean };
      }
    ).scheduling?.isInputPending({ includeContinuous: true }) ?? false;
  function schedule() {
    if (cancelled) return;
    // No timeout: this optional preparation never takes priority over input.
    if (tasks && !inputPending()) {
      void tasks
        .postTask(() => run(), { priority: 'background', signal: controller.signal })
        .catch(() => {
          // An unsupported scheduler falls back to idle work. Cancellation does
          // not schedule another task, including after a workspace unmount.
          if (!cancelled && typeof requestIdleCallback === 'function')
            idle = requestIdleCallback(run);
          else if (!cancelled) timer = setTimeout(() => run(), 16);
        });
    } else if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(run);
    else timer = setTimeout(() => run(), 16);
  }
  function run(deadline?: IdleDeadline) {
    if (cancelled || prepared.get(source)?.has(key)) return;
    const began = performance.now();
    for (let count = 0; count < 4096; count++) {
      if (
        inputPending() ||
        performance.now() - began >= 1 ||
        (deadline && deadline.timeRemaining() <= 2)
      )
        break;
      const next = work.next();
      if (next.done) {
        maxSliceMs = Math.max(maxSliceMs, performance.now() - began);
        let keys = prepared.get(source);
        if (!keys) prepared.set(source, (keys = new Set()));
        keys.add(key);
        performance.mark('compendium:fonts-prepared', {
          detail: {
            family,
            rem,
            maxUnitMs,
            maxSliceMs,
            durationMs: performance.now() - started,
            latinOnly: true,
          },
        });
        return;
      }
      if (next.value) {
        const at = performance.now();
        if (context === undefined) context = document.createElement('canvas').getContext('2d');
        if (!context) return;
        context.font = next.value.font;
        context.measureText(next.value.text);
        maxUnitMs = Math.max(maxUnitMs, performance.now() - at);
      }
    }
    maxSliceMs = Math.max(maxSliceMs, performance.now() - began);
    schedule();
  }
  void (document.fonts?.ready ?? Promise.resolve()).then(schedule);
  return () => {
    cancelled = true;
    controller.abort();
    if (idle !== undefined) cancelIdleCallback(idle);
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** Preparation exists only while the review workspace is mounted. */
export function useReviewFontMetrics(
  article: RefObject<HTMLElement>,
  source: CompendiumData | null,
) {
  useEffect(() => {
    if (!source || !article.current) return;
    let cancel = () => {};
    let idle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    function clearScheduled() {
      if (idle !== undefined) cancelIdleCallback(idle);
      if (timer !== undefined) clearTimeout(timer);
      idle = undefined;
      timer = undefined;
    }
    function prepare() {
      if (disposed) return;
      if (
        (
          navigator as Navigator & {
            scheduling?: { isInputPending(options: { includeContinuous: boolean }): boolean };
          }
        ).scheduling?.isInputPending({ includeContinuous: true })
      ) {
        schedule();
        return;
      }
      cancel();
      if (!article.current) return;
      cancel = warmReviewFontMetrics(
        source!,
        getComputedStyle(article.current).fontFamily,
        parseFloat(getComputedStyle(document.documentElement).fontSize),
      );
    }
    function schedule() {
      clearScheduled();
      // React may flush this effect inside a navigation input task. Even the
      // computed-style reads must wait until optional preparation can run.
      if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(prepare);
      else timer = setTimeout(prepare, 16);
    }
    schedule();
    window.addEventListener('clarity-ui-scale', schedule);
    return () => {
      disposed = true;
      clearScheduled();
      cancel();
      window.removeEventListener('clarity-ui-scale', schedule);
    };
  }, [article, source]);
}
