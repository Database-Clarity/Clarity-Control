import {
  compendiumIdentifiers,
  compendiumNameVariants,
  normaliseCompendiumName,
  type CompendiumRow,
  type CompendiumSheet,
} from '@clarity/core';
type RowDetail = { name: string; identifiers: string[]; search: string };
type RowIndex = { rows: CompendiumRow[]; details: Map<CompendiumRow, RowDetail> };
const indexes = new WeakMap<CompendiumSheet, RowIndex>();
const compareRows = (a: CompendiumRow, b: CompendiumRow) =>
  a.name.localeCompare(b.name) || a.rowIndex - b.rowIndex;
const detailValues = new WeakMap<CompendiumRow, Partial<RowDetail>>();
const detailViews = new WeakMap<CompendiumRow, RowDetail>();

/** Foreground callers request only the fields they actually inspect. */
export function pickerRowDetail(row: CompendiumRow): RowDetail {
  let detail = detailViews.get(row);
  if (!detail) {
    const field = <K extends keyof RowDetail>(key: K, compute: () => RowDetail[K]) => {
      const values = detailValues.get(row) ?? {};
      detailValues.set(row, values);
      return (values[key] ??= compute());
    };
    detail = {
      get name() {
        return field('name', () => normaliseCompendiumName(row.name));
      },
      get identifiers() {
        return field('identifiers', () =>
          compendiumIdentifiers(row.name).map(normaliseCompendiumName),
        );
      },
      get search() {
        return field('search', () => normaliseCompendiumName(`${row.name} ${row.section ?? ''}`));
      },
    };
    detailViews.set(row, detail);
  }
  return detail;
}

export function pickerRowIndex(tab: CompendiumSheet) {
  let index = indexes.get(tab);
  if (!index) {
    index = {
      rows: [...tab.rows].sort(compareRows),
      details: new Map(tab.rows.map((row) => [row, pickerRowDetail(row)])),
    };
    indexes.set(tab, index);
  }
  return index;
}

/** A real idle task, suspended throughout editing and until input has gone quiet. */
export function pickerIdleScheduler(run: (deadline?: IdleDeadline) => void) {
  let cancelled = false;
  let queued = false;
  let inputSeen = false;
  let quietUntil = 0;
  let idle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const channel = new MessageChannel();
  const pause = () => {
    // Input handlers only mark intent; even clock reads stay off that path.
    inputSeen = true;
  };
  const events = ['keydown', 'beforeinput', 'input', 'pointerdown', 'wheel', 'focusin'] as const;
  for (const event of events)
    window.addEventListener(event, pause, { capture: true, passive: true });
  const navigation = ['hashchange', 'popstate'] as const;
  for (const event of navigation) window.addEventListener(event, pause, true);
  const rendering = () =>
    !!document.querySelector('article[aria-busy="true"], aside[aria-busy="true"]');
  const editing = () =>
    !!document.activeElement?.closest('input, textarea, [contenteditable="true"]');
  const pending = () =>
    (
      navigator as Navigator & {
        scheduling?: { isInputPending(options: { includeContinuous: boolean }): boolean };
      }
    ).scheduling?.isInputPending({ includeContinuous: true });
  const schedule = () => {
    if (cancelled || queued) return;
    queued = true;
    channel.port2.postMessage(null);
  };
  const enterIdle = () => {
    if (cancelled) return;
    const now = performance.now();
    if (inputSeen) {
      inputSeen = false;
      quietUntil = now + 250;
    }
    if (editing() || rendering() || pending() || now < quietUntil) {
      timer = setTimeout(enterIdle, Math.max(250, quietUntil - now));
      return;
    }
    const invoke = (deadline?: IdleDeadline) => {
      idle = undefined;
      queued = false;
      if (cancelled) return;
      if (
        inputSeen ||
        editing() ||
        rendering() ||
        pending() ||
        (deadline && deadline.timeRemaining() < 2)
      ) {
        schedule();
        return;
      }
      run(deadline);
    };
    if ('requestIdleCallback' in window) idle = window.requestIdleCallback(invoke);
    else timer = setTimeout(() => invoke(), 16);
  };
  channel.port1.onmessage = enterIdle;
  return {
    schedule,
    pending,
    cancel() {
      cancelled = true;
      for (const event of events) window.removeEventListener(event, pause, true);
      for (const event of navigation) window.removeEventListener(event, pause, true);
      if (idle !== undefined) window.cancelIdleCallback(idle);
      if (timer !== undefined) clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
    },
  };
}

/** Text transforms happen off-thread; the main thread only transfers small idle batches. */
export function warmPickerRowIndexes(tabs: readonly CompendiumSheet[]) {
  // Browsers without workers keep the same on-demand results, without a heavy idle fallback.
  if (typeof Worker === 'undefined') return () => {};
  let worker: Worker | undefined;
  let tabIndex = 0;
  let rowIndex = 0;
  let waiting = false;
  let rows: CompendiumRow[] = [];
  let response: RowDetail[] | undefined;
  let installed = 0;
  let cancelled = false;
  const idle = pickerIdleScheduler((deadline) => {
    const started = performance.now();
    let steps = 0;
    while (
      performance.now() - started < 1 &&
      steps++ < 16 &&
      (!deadline || deadline.timeRemaining() >= 2) &&
      !idle.pending()
    ) {
      if (response) {
        detailValues.set(rows[installed], response[installed]);
        if (++installed === response.length) {
          response = undefined;
          rows = [];
          installed = 0;
        }
      } else if (waiting) return;
      else {
        while (tabs[tabIndex] && rowIndex >= tabs[tabIndex].rows.length) {
          tabIndex++;
          rowIndex = 0;
        }
        const row = tabs[tabIndex]?.rows[rowIndex++];
        if (row) {
          const values = detailValues.get(row);
          if (
            values?.name === undefined ||
            values.identifiers === undefined ||
            values.search === undefined
          )
            rows.push(row);
          if (rows.length < 16) continue;
        }
        if (!row && !rows.length) {
          idle.cancel();
          worker?.terminate();
          return;
        }
        worker ??= new Worker(new URL('./pickerRows.worker.ts', import.meta.url), {
          type: 'module',
        });
        worker.onmessage = (event: MessageEvent<RowDetail[]>) => {
          if (cancelled) return;
          response = event.data;
          waiting = false;
          idle.schedule();
        };
        worker.onerror = () => {
          // Index warming is optional; foreground lookup remains complete and authoritative.
          cancelled = true;
          idle.cancel();
          worker?.terminate();
        };
        waiting = true;
        worker.postMessage(
          rows.map((entry) => ({
            name: entry.name,
            section: entry.section,
            cached: detailValues.get(entry),
          })),
        );
        return;
      }
    }
    idle.schedule();
  });
  idle.schedule();
  return () => {
    cancelled = true;
    idle.cancel();
    worker?.terminate();
  };
}
export function pickerRows(
  tab: CompendiumSheet | undefined,
  category: string,
  query: string,
  section: string,
) {
  const exact = new Set<CompendiumRow>();
  if (!tab) return { rows: [], exact };
  const index = pickerRowIndex(tab);
  const searches = compendiumNameVariants(category, query).map(normaliseCompendiumName);
  const hits: CompendiumRow[] = [];
  const rest: CompendiumRow[] = [];
  for (const row of index.rows) {
    if (section && row.section !== section) continue;
    if (!query.trim()) {
      rest.push(row);
      continue;
    }
    const detail = index.details.get(row)!;
    if (!searches.some((search) => detail.search.includes(search))) continue;
    if (query.trim() && detail.identifiers.some((identifier) => searches.includes(identifier))) {
      exact.add(row);
      hits.push(row);
    } else rest.push(row);
  }
  return { rows: [...hits, ...rest], exact };
}
