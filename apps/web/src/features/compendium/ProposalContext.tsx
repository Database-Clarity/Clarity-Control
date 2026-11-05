import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CompendiumMatch, CompendiumData } from '@clarity/core';
import { RichCell } from './RichCell';
import { deferContextCells } from './deferredContext';
import { contextLines } from './contextLines';
import styles from './MatchReview.module.scss';

export function ProposalContext({
  match,
  source,
}: {
  match?: CompendiumMatch;
  source: CompendiumData;
}) {
  const [contextOpen, setContextOpen] = useState(false);
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
  const context = useMemo(
    () => cells?.map((cell) => ({ ...cell, lines: contextLines(cell.cell) })),
    [cells],
  );
  const blocks = useMemo(
    () => context?.flatMap((cell) => cell.lines.filter((line) => line.block)),
    [context],
  );
  useLayoutEffect(() => {
    if (details.current && blocks?.length) return deferContextCells(details.current, blocks);
  }, [blocks]);
  if (!match) return <p>No source location established. Use Pick other to search all tabs.</p>;
  return (
    <>
      <p className={styles.eyebrow}>
        {match.tab.name} / {match.row.section ?? 'Section unknown'} · row {match.row.rowIndex}
      </p>
      <h3>{match.row.name}</h3>
      <div className={styles.sourceText}>
        <RichCell cell={match.row.cell} />
      </div>
      <details
        ref={details}
        open={contextOpen}
        onToggle={(event) => setContextOpen(event.currentTarget.open)}
        className={styles.context}
      >
        <summary>Nearby sheet cells · {source.fetchedAt.slice(0, 10)}</summary>
        {context?.map((cell) => (
          <div key={`${match.tab.gid}:${cell.row}:${cell.col}`} data-context-cell>
            <small>
              R{cell.row} C{cell.col + 1}
            </small>
            {cell.lines[0]?.block && '\n'}
            {cell.lines.map((line, index) => (
              <Fragment key={index}>
                <span
                  data-context-line={line.block ? 'block' : 'inline'}
                  data-multiline="true"
                  className={styles.contextLine}
                  style={{
                    display: line.block ? 'inline-block' : 'inline',
                    width: line.block ? '100%' : undefined,
                    verticalAlign: line.block ? 'top' : undefined,
                    textAlign: line.align,
                  }}
                >
                  <RichCell cell={line.cell} inline />
                  {line.block &&
                    index === cell.lines.length - 1 &&
                    line.cell.runs.every((run) => !run.text) && <br />}
                </span>
                {index < cell.lines.length - 1 && '\n'}
              </Fragment>
            ))}
          </div>
        ))}
        {contextOpen && !cells?.length && <p>No grid context available.</p>}
      </details>
    </>
  );
}
