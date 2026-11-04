import type { CompendiumCell, CompendiumData } from '@clarity/core';

const prepared = new Set<string>();
const sources = new WeakSet<CompendiumData>();
const family = 'Arial, Helvetica, DestinySymbols, "Segoe UI Symbol", sans-serif';

function* sourceFonts(source: CompendiumData) {
  const cells = new WeakSet<CompendiumCell>();
  for (const tab of source.tabs) {
    for (const entry of [...tab.rows, ...(tab.grid ?? [])]) {
      if (cells.has(entry.cell)) continue;
      cells.add(entry.cell);
      for (const run of entry.cell.runs)
        yield `${run.italic ? 'italic' : 'normal'} ${run.bold ? 700 : 400} ${run.sizePt === undefined ? '1rem' : `${run.sizePt}pt`} ${family}`;
    }
  }
}

/** Prepare every source's font styles during free time, without laying out DOM. */
export function prepareCompendiumFonts(source: CompendiumData) {
  if (sources.has(source) || typeof document === 'undefined') return;
  sources.add(source);
  let context: CanvasRenderingContext2D | null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    context = canvas.getContext('2d');
  } catch {
    return;
  }
  if (!context) return;
  const fonts = sourceFonts(source);
  const inputPending = () =>
    (
      navigator as Navigator & {
        scheduling?: { isInputPending(options: { includeContinuous: boolean }): boolean };
      }
    ).scheduling?.isInputPending({ includeContinuous: true }) ?? false;
  function schedule() {
    const scheduler = (
      globalThis as typeof globalThis & {
        scheduler?: {
          postTask(callback: () => void, options: { priority: 'background' }): Promise<unknown>;
        };
      }
    ).scheduler;
    if (scheduler) void scheduler.postTask(step, { priority: 'background' }).catch(() => {});
    else if (typeof requestIdleCallback === 'function') requestIdleCallback(step);
    else setTimeout(step, 0);
  }
  function step() {
    const end = performance.now() + 2;
    try {
      while (performance.now() < end && !inputPending()) {
        const next = fonts.next();
        if (next.done) {
          performance.mark('compendium:fonts-prepared', { detail: { styles: prepared.size } });
          performance.clearMarks('compendium:fonts-prepared');
          return;
        }
        if (prepared.has(next.value)) continue;
        context!.font = next.value;
        // Typeface metrics are shared with text layout. A fixed Latin sample
        // initializes the face; no source text, route or selection is predicted.
        context!.measureText('Mg');
        prepared.add(next.value);
      }
      schedule();
    } catch {
      // Optional canvas/font support never gates source loading or matching.
    }
  }
  schedule();
}
