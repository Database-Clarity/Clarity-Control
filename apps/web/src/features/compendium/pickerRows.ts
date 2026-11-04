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
const rowDetail = (row: CompendiumRow): RowDetail => ({
  name: normaliseCompendiumName(row.name),
  identifiers: compendiumIdentifiers(row.name).map(normaliseCompendiumName),
  search: normaliseCompendiumName(`${row.name} ${row.section ?? ''}`),
});
export function pickerRowIndex(tab: CompendiumSheet) {
  let index = indexes.get(tab);
  if (!index) {
    index = {
      rows: [...tab.rows].sort(compareRows),
      details: new Map(tab.rows.map((row) => [row, rowDetail(row)])),
    };
    indexes.set(tab, index);
  }
  return index;
}

/** Build privately: foreground queries must never observe a partially normalised index. */
function* prepareRowIndex(tab: CompendiumSheet) {
  let rows: CompendiumRow[] = [];
  const details = new Map<CompendiumRow, RowDetail>();
  for (const row of tab.rows) {
    rows.push(row);
    details.set(row, rowDetail(row));
    yield;
  }
  // A resumable stable merge sort also bounds the sorting part of a large tab.
  // Equal names and physical rows keep the source order, just like Array.sort.
  for (let width = 1; width < rows.length; width *= 2) {
    const sorted: CompendiumRow[] = [];
    for (let start = 0; start < rows.length; start += width * 2) {
      const middle = Math.min(start + width, rows.length);
      const end = Math.min(start + width * 2, rows.length);
      let left = start;
      let right = middle;
      while (left < middle || right < end) {
        sorted.push(
          right >= end || (left < middle && compareRows(rows[left], rows[right]) <= 0)
            ? rows[left++]
            : rows[right++],
        );
        yield;
      }
    }
    rows = sorted;
  }
  // A foreground query may have completed this tab while the warm-up was paused.
  if (!indexes.has(tab)) indexes.set(tab, { rows, details });
}

/** Fair background warm-up, with small slices and a quiet period after real input. */
export function warmPickerRowIndexes(tabs: readonly CompendiumSheet[]) {
  let cancelled = false;
  let idle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let quietUntil = 0;
  let position = 0;
  let work: ReturnType<typeof prepareRowIndex> | undefined;
  const events = ['keydown', 'beforeinput', 'input', 'pointerdown', 'wheel'] as const;
  const pause = () => {
    quietUntil = performance.now() + 75;
  };
  for (const event of events)
    window.addEventListener(event, pause, { capture: true, passive: true });
  const cleanup = () => {
    for (const event of events) window.removeEventListener(event, pause, true);
  };
  const schedule = () => {
    if (cancelled) return;
    if (performance.now() < quietUntil) {
      timer = setTimeout(schedule, quietUntil - performance.now());
    } else if ('requestIdleCallback' in window) {
      idle = window.requestIdleCallback(run);
    } else {
      timer = setTimeout(() => run(), 16);
    }
  };
  const run = (deadline?: IdleDeadline) => {
    if (cancelled) return;
    const started = performance.now();
    const pending = (
      navigator as Navigator & {
        scheduling?: { isInputPending(options: { includeContinuous: boolean }): boolean };
      }
    ).scheduling;
    while (
      performance.now() >= quietUntil &&
      performance.now() - started < 2 &&
      (!deadline || deadline.timeRemaining() >= 2) &&
      !pending?.isInputPending({ includeContinuous: true })
    ) {
      const tab = tabs[position];
      if (!tab) {
        cleanup();
        return;
      }
      if (indexes.has(tab)) {
        position++;
        work = undefined;
      } else {
        work ??= prepareRowIndex(tab);
        if (work.next().done) {
          position++;
          work = undefined;
        }
      }
    }
    schedule();
  };
  schedule();
  return () => {
    cancelled = true;
    if (idle !== undefined) window.cancelIdleCallback(idle);
    if (timer !== undefined) clearTimeout(timer);
    cleanup();
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
    const detail = index.details.get(row)!;
    if (query.trim() && !searches.some((search) => detail.search.includes(search))) continue;
    if (query.trim() && detail.identifiers.some((identifier) => searches.includes(identifier))) {
      exact.add(row);
      hits.push(row);
    } else rest.push(row);
  }
  return { rows: [...hits, ...rest], exact };
}
