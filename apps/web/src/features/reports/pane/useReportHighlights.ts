import { displayRevision } from '@clarity/core';
import { useEffect, useRef } from 'react';
import { clearReportMarks, markAtPoint, setReportMarks, type ReportMark } from '../highlights';
import type { PaneReport } from './api';
import { mapRenderedText, rangeFor, resolveNote } from './previewText';

/** Marks to draw: the open reports' notes with their badge numbers, in list order. */
export interface NoteTarget {
  report: PaneReport;
  note: PaneReport['notes'][number];
  number: number;
}

const visible = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

/**
 * Publishes highlight ranges over already-rendered tooltip bodies (`targets()` returns them; each
 * is a preview `.description` element or the pane's own copy). The bodies are only read: no
 * render, no class, no node is added to them. Ranges are rebuilt after the body's text changes
 * (debounced, off the keystroke) and when the body is shown or hidden.
 */
export function useReportHighlights({
  key,
  targets,
  notes,
  selected,
  enabled,
  onSelect,
}: {
  key: string;
  targets(): Element[];
  notes: NoteTarget[];
  selected: string | null;
  enabled: boolean;
  onSelect(report: string): void;
}) {
  const latest = useRef({ targets, notes, selected, onSelect });
  latest.current = { targets, notes, selected, onSelect };
  const rebuild = useRef<() => void>(() => undefined);
  const marks = useRef<ReportMark[]>([]);

  useEffect(() => {
    if (!enabled) {
      clearReportMarks(key);
      return;
    }
    let disposed = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observed: Element[] = [];
    // Typing changes the preview on every key: drop the marks at the first change (live ranges
    // over changing text cost every frame and point at moving words), then mark again once quiet.
    const mutations = new MutationObserver((records) => {
      // A title popover opening or closing is not a text change.
      const popover = (node: Node) =>
        (node instanceof Element ? node : node.parentElement)?.closest('[role="tooltip"]') ||
        (node instanceof Element && node.matches('[role="tooltip"]'));
      if (
        records.every(
          (record) =>
            popover(record.target) ||
            (record.type === 'childList' &&
              [...record.addedNodes, ...record.removedNodes].every(popover)),
        )
      )
        return;
      if (marks.current.length) {
        marks.current = [];
        setReportMarks(key, []);
      }
      schedule();
    });
    const sizes = new ResizeObserver(() => schedule());
    const click = (event: Event) => {
      const { clientX, clientY } = event as MouseEvent;
      const mark = markAtPoint(clientX, clientY);
      if (mark && marks.current.includes(mark)) latest.current.onSelect(mark.report);
    };
    const observe = (elements: Element[]) => {
      if (elements.length === observed.length && elements.every((e, i) => e === observed[i]))
        return;
      for (const element of observed) element.removeEventListener('click', click);
      mutations.disconnect();
      sizes.disconnect();
      observed = elements;
      for (const element of elements) {
        mutations.observe(element, { characterData: true, childList: true, subtree: true });
        sizes.observe(element);
        element.addEventListener('click', click);
      }
    };
    const build = async () => {
      const run = ++generation;
      const elements = latest.current.targets();
      observe(elements);
      const next: ReportMark[] = [];
      for (const element of elements) {
        if (!visible(element)) continue;
        const map = mapRenderedText(element);
        const rev = await displayRevision(map.text);
        if (disposed || run !== generation) return;
        for (const { report, note, number } of latest.current.notes) {
          const anchor = resolveNote(map.text, rev, report, note);
          if (anchor.kind !== 'exact' && anchor.kind !== 'moved') continue;
          const range = rangeFor(map, anchor.start, anchor.end);
          if (range)
            next.push({
              range,
              n: number,
              report: report.id,
              selected: report.id === latest.current.selected,
            });
        }
      }
      marks.current = next;
      setReportMarks(key, next);
    };
    function schedule() {
      clearTimeout(timer);
      // Typing re-renders the preview: rebuild once it is quiet, never inside the keystroke.
      timer = setTimeout(() => void build(), 150);
    }
    rebuild.current = () => {
      clearTimeout(timer);
      void build();
    };
    void build();
    return () => {
      disposed = true;
      clearTimeout(timer);
      for (const element of observed) element.removeEventListener('click', click);
      mutations.disconnect();
      sizes.disconnect();
      rebuild.current = () => undefined;
      marks.current = [];
      clearReportMarks(key);
    };
  }, [key, enabled]);

  // New reports or another target set: rebuild now. Selection only restyles the same ranges.
  const notesKey = notes
    .map(({ report, note, number }) => `${report.id}:${report.version}:${note.n}:${number}`)
    .join('|');
  useEffect(() => {
    rebuild.current();
  }, [notesKey]);
  useEffect(() => {
    if (!marks.current.length) return;
    marks.current = marks.current.map((mark) => ({ ...mark, selected: mark.report === selected }));
    setReportMarks(key, marks.current);
  }, [key, selected]);
  return rebuild;
}
