import type { GlobalImpactRow, MarkupLine, MarkupSpan } from '@clarity/core';
import { z } from 'zod';
import { MarkupLines } from '../preview/MarkupRenderer';
import { WordDiff } from '../../ui/diff/WordDiff';
import preview from '../preview/TooltipPreview.module.scss';
import styles from './GlobalEntryWorkspace.module.scss';

// JSON serializes optional class-array slots as null; the renderer treats them as absent.
const classes = z.array(z.string().or(z.null().transform(() => undefined))).optional();
const spanSchema: z.ZodType<MarkupSpan> = z.lazy(() =>
  z
    .object({
      text: z.string().optional(),
      classNames: classes,
      link: z.string().optional(),
      title: z.array(lineSchema).optional(),
    })
    .passthrough(),
);
const lineSchema: z.ZodType<MarkupLine> = z.lazy(() =>
  z
    .object({
      classNames: classes,
      linesContent: z.array(spanSchema).optional(),
      table: z
        .array(
          z
            .object({
              classNames: classes,
              rowContent: z
                .array(
                  z
                    .object({
                      cellContent: z.array(spanSchema),
                      classNames: classes,
                      colSpan: z.number().int().nonnegative().optional(),
                      rowSpan: z.number().int().nonnegative().optional(),
                    })
                    .passthrough(),
                )
                .optional(),
            })
            .passthrough(),
        )
        .optional(),
      isFormula: z.boolean().optional(),
    })
    .passthrough(),
);
const linesSchema = z.array(lineSchema);

/** S1 pins serialized production render trees, never reparsed against today's globals. */
export function globalImpactLines(side: GlobalImpactRow['before']): MarkupLine[] {
  if (!side) return [];
  const result = linesSchema.safeParse(JSON.parse(side.rendered));
  if (!result.success)
    throw new Error('Invalid pinned render tree. Reload the impact before reviewing.');
  return result.data;
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
