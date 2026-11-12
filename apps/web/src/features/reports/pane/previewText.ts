import { resolveReportAnchor } from '@clarity/core';
import type { PaneNote, PaneReport } from './api';

/**
 * The display text of a rendered tooltip body, read from the DOM the preview already painted:
 * one entry per line element (tables row by row, cells joined by a tab), lines joined by `\n`,
 * title popover bodies excluded. That is exactly `displayText()` from core, so selectors made
 * over the core text resolve here; when the two ever disagree the caller compares and draws
 * nothing rather than drawing in the wrong place.
 */
export interface TextMap {
  text: string;
  nodes: { node: Text; start: number }[];
}

interface Builder {
  parts: string[];
  length: number;
}
const push = (builder: Builder, part: string) => {
  builder.parts.push(part);
  builder.length += part.length;
};

function collect(element: Element, map: TextMap, builder: Builder) {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_ALL, {
    acceptNode(node) {
      if (node instanceof Element && node.getAttribute('role') === 'tooltip')
        return NodeFilter.FILTER_REJECT;
      return node.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.data) continue;
    map.nodes.push({ node: text, start: builder.length });
    push(builder, text.data);
  }
}

export function mapRenderedText(root: Element): TextMap {
  const map: TextMap = { text: '', nodes: [] };
  const builder: Builder = { parts: [], length: 0 };
  let first = true;
  for (const line of root.children) {
    if (line.tagName === 'TABLE') {
      for (const row of line.querySelectorAll(':scope > tbody > tr, :scope > tr')) {
        if (!first) push(builder, '\n');
        first = false;
        let firstCell = true;
        for (const cell of row.children) {
          if (!firstCell) push(builder, '\t');
          firstCell = false;
          collect(cell, map, builder);
        }
      }
      continue;
    }
    if (!first) push(builder, '\n');
    first = false;
    collect(line, map, builder);
  }
  map.text = builder.parts.join('');
  return map;
}

/** A DOM range over display offsets [start, end), or null when the map cannot place it. */
export function rangeFor(map: TextMap, start: number, end: number): Range | null {
  if (!map.nodes.length || end <= start) return null;
  const startNode = map.nodes.find(
    ({ node, start: at }) => start >= at && start < at + node.data.length,
  );
  let endNode: TextMap['nodes'][number] | undefined;
  for (const entry of map.nodes)
    if (end > entry.start && end <= entry.start + entry.node.data.length) {
      endNode = entry;
      break;
    }
  if (!startNode || !endNode) return null;
  const range = startNode.node.ownerDocument.createRange();
  range.setStart(startNode.node, start - startNode.start);
  range.setEnd(endNode.node, end - endNode.start);
  return range;
}

export type NoteAnchor =
  { kind: 'whole' } | { kind: 'exact' | 'moved'; start: number; end: number } | { kind: 'stale' };

/** Where a note's quote is in this display text (core resolution: offsets, then quote search). */
export function resolveNote(
  display: string,
  displayRev: string,
  report: PaneReport,
  note: PaneNote,
): NoteAnchor {
  if (note.whole || !note.exact || note.start == null || note.end == null) return { kind: 'whole' };
  const result = resolveReportAnchor(display, displayRev, {
    rev: note.rev ?? report.rev,
    exact: note.exact,
    prefix: note.prefix ?? '',
    suffix: note.suffix ?? '',
    start: note.start,
    end: note.end,
    line: note.line ?? 0,
  });
  return result.status === 'stale'
    ? { kind: 'stale' }
    : { kind: result.status, start: result.start, end: result.end };
}
