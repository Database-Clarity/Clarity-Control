import type { GlobalImpactRow, MarkupLine } from '@clarity/core';
import { MarkupLines } from '../preview/MarkupRenderer';
import { WordDiff } from '../../ui/diff/WordDiff';
import preview from '../preview/TooltipPreview.module.scss';
import styles from './GlobalEntryWorkspace.module.scss';

/** S1 pins serialized production render trees, never reparsed against today's globals. */
export function globalImpactLines(side: GlobalImpactRow['before']): MarkupLine[] {
  if (!side) return [];
  const value: unknown = JSON.parse(side.rendered);
  if (!Array.isArray(value) || value.some((line) => !line || typeof line !== 'object'))
    throw new Error('Invalid pinned render tree. Reload the impact before reviewing.');
  return value as MarkupLine[];
}
export function validGlobalImpact(row: GlobalImpactRow): boolean {
  try {
    globalImpactLines(row.before);
    globalImpactLines(row.after);
    return true;
  } catch {
    return false;
  }
}
export function GlobalImpactComparison({
  row,
  raw,
}: {
  row: GlobalImpactRow & { beforeSource: string; afterSource: string };
  raw: boolean;
}) {
  if (!validGlobalImpact(row))
    return <p role="alert">Pinned render unavailable. Reload before reviewing.</p>;
  if (raw) return <WordDiff before={row.beforeSource} after={row.afterSource} />;
  const before = globalImpactLines(row.before),
    after = globalImpactLines(row.after);
  const oldLines = new Set(before.map((line) => JSON.stringify(line)));
  const newLines = new Set(after.map((line) => JSON.stringify(line)));
  return (
    <div className={styles.comparison}>
      <p>
        {row.before?.rendered === row.after?.rendered
          ? 'Rendered output unchanged'
          : 'Rendered output changed'}
      </p>
      <div>
        <strong>Before</strong>
        <div className={preview.snippet} data-rendered-body>
          {row.before ? (
            <MarkupLines
              lines={before}
              lineClass={(line) =>
                newLines.has(JSON.stringify(line)) ? undefined : styles.removed
              }
            />
          ) : (
            <p>Consumer absent.</p>
          )}
        </div>
      </div>
      <div>
        <strong>After</strong>
        <div className={preview.snippet} data-rendered-body>
          {row.after ? (
            <MarkupLines
              lines={after}
              lineClass={(line) => (oldLines.has(JSON.stringify(line)) ? undefined : styles.added)}
            />
          ) : (
            <p>Consumer absent.</p>
          )}
        </div>
      </div>
    </div>
  );
}
