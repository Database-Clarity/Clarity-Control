import {
  memo,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import type { CompendiumCell, CompendiumMatch, CompendiumData } from '@clarity/core';
import { Multiline, prepareReviewCell, RichCell } from './RichCell';
import { deferContextCells } from './deferredContext';
import styles from './MatchReview.module.scss';

const searchable = new WeakMap<CompendiumCell, ReactNode>();
function retainCellSelection(node: HTMLElement) {
  const selection = document.getSelection();
  if (
    !selection?.anchorNode ||
    !selection.focusNode ||
    !node.contains(selection.anchorNode) ||
    !node.contains(selection.focusNode)
  )
    return;
  const offset = (end: Node, at: number) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    range.setEnd(end, at);
    return range.toString().length;
  };
  const anchor = offset(selection.anchorNode, selection.anchorOffset);
  const focus = offset(selection.focusNode, selection.focusOffset);
  return () => {
    const point = (at: number): [Node, number] => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let text: Node | null;
      while ((text = walker.nextNode())) {
        const length = text.textContent!.length;
        if (at <= length) return [text, at];
        at -= length;
      }
      return [node, node.childNodes.length];
    };
    selection.setBaseAndExtent(...point(anchor), ...point(focus));
  };
}
function searchableCell(cell: CompendiumCell) {
  if (searchable.has(cell)) return searchable.get(cell);
  // Offscreen text and native links remain searchable and in focus order.
  // Formatting is mounted before proximity, Tab, or beforematch exposes a cell.
  const parts: { text: string; href?: string }[] = [];
  for (const run of cell.runs) {
    if (!run.text) continue;
    const previous = parts.at(-1);
    if (previous && previous.href === run.href) previous.text += run.text;
    else parts.push({ text: run.text, href: run.href });
  }
  const content = parts.map(({ text, href }, index) =>
    href ? (
      <a key={index} href={href} target="_blank" rel="noreferrer">
        {text}
      </a>
    ) : (
      text
    ),
  );
  searchable.set(cell, content);
  return content;
}

const ContextCell = memo(function ContextCell({
  cell,
  rich,
}: {
  cell: { row: number; col: number; cell: CompendiumCell };
  rich: boolean;
}) {
  return (
    <div data-context-cell>
      <small>
        R{cell.row} C{cell.col + 1}
      </small>
      <Multiline>{rich ? prepareReviewCell(cell.cell) : searchableCell(cell.cell)}</Multiline>
    </div>
  );
});

export const ProposalContext = memo(function ProposalContext({
  match,
  source,
}: {
  match?: CompendiumMatch;
  source: CompendiumData;
}) {
  const [contextOpen, setContextOpen] = useState(false);
  const [, renderCells] = useReducer((version: number) => version + 1, 0);
  const details = useRef<HTMLDetailsElement>(null);
  const grid = source.tabs.find((tab) => tab.gid === match?.tab.gid)?.grid ?? match?.tab.grid;
  const cells = useMemo(
    () =>
      contextOpen && match
        ? grid?.filter(
            (cell) =>
              Math.abs(cell.row - (match.row.anchor?.row ?? match.row.rowIndex)) <= 2 &&
              cell.cell.plain.trim(),
          )
        : undefined,
    [match, contextOpen, grid],
  );
  const visibility = useMemo(
    () => ({
      cells,
      wanted: new Set<number>(),
      committed: new Set<number>(),
      selections: new Map<number, () => void>(),
      inLayout: false,
      controller: undefined as ReturnType<typeof deferContextCells> | undefined,
    }),
    [cells],
  );
  useLayoutEffect(() => {
    visibility.inLayout = true;
    visibility.committed = new Set(visibility.wanted);
    for (const restore of visibility.selections.values()) restore();
    visibility.selections.clear();
    visibility.controller?.refresh();
    visibility.inLayout = false;
  });
  useLayoutEffect(() => {
    if (!details.current || !visibility.cells?.length) return;
    visibility.inLayout = true;
    const controller = deferContextCells(details.current, visibility.cells, (node, index) => {
      if (visibility.committed.has(index)) return true;
      const restore = retainCellSelection(node);
      if (restore) visibility.selections.set(index, restore);
      visibility.wanted.add(index);
      // A layout-effect update commits before paint. Native scroll, Tab, and
      // beforematch need the same update before their default action resumes.
      if (visibility.inLayout) renderCells();
      else flushSync(renderCells);
      return visibility.committed.has(index);
    });
    visibility.controller = controller;
    visibility.inLayout = false;
    return () => {
      visibility.controller = undefined;
      controller();
    };
  }, [visibility]);
  if (!match) return <p>No source location established. Use Pick other to search all tabs.</p>;
  return (
    <>
      <p className={styles.eyebrow}>
        {match.tab.name} / {match.row.section ?? 'Section unknown'} · row {match.row.rowIndex}
      </p>
      <h3>{match.row.name}</h3>
      <div className={styles.sourceText}>
        <RichCell cell={match.row.cell} emojiFace />
      </div>
      <details
        ref={details}
        open={contextOpen}
        onToggle={(event) => setContextOpen(event.currentTarget.open)}
        className={styles.context}
      >
        <summary>Nearby sheet cells · {source.fetchedAt.slice(0, 10)}</summary>
        {cells?.map((cell, index) => (
          // Reuse each physical display slot across selections. React updates
          // its text, styles, and links without remounting the whole sheet window.
          <ContextCell key={index} cell={cell} rich={visibility.wanted.has(index)} />
        ))}
        {contextOpen && !cells?.length && <p>No grid context available.</p>}
      </details>
    </>
  );
});
