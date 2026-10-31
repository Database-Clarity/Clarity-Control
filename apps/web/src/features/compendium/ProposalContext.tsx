import { useMemo } from 'react';
import type { CompendiumMatch, CompendiumData } from '@clarity/core';
import { RichCell } from './RichCell';
import styles from './MatchReview.module.scss';

export function ProposalContext({
  match,
  source,
}: {
  match?: CompendiumMatch;
  source: CompendiumData;
}) {
  const cells = useMemo(
    () =>
      match?.tab.grid?.filter(
        (cell) =>
          Math.abs(cell.row - (match.row.anchor?.row ?? match.row.rowIndex)) <= 2 &&
          cell.cell.plain.trim(),
      ),
    [match],
  );
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
      <details open className={styles.context}>
        <summary>Nearby sheet cells · {source.fetchedAt.slice(0, 10)}</summary>
        {cells?.map((cell) => (
          <div key={`${cell.row}:${cell.col}`}>
            <small>
              R{cell.row} C{cell.col + 1}
            </small>
            <RichCell cell={cell.cell} />
          </div>
        ))}
        {!cells?.length && <p>No grid context available.</p>}
      </details>
    </>
  );
}
