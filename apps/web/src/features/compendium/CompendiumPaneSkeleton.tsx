import type { ReactNode } from 'react';
import type { CompendiumCell, Tooltip } from '@clarity/core';
import {
  SkeletonLine,
  SkeletonRegion,
  skeletonLineWidths,
  skeletonTextShape,
  type SkeletonTextShape,
} from '../../ui/Skeleton';
import { When } from '../../ui/When';
import { CellScale, type CompendiumDiffMode } from './CompendiumDiff';
import styles from './Compendium.module.scss';

const shapes = new WeakMap<CompendiumCell, SkeletonTextShape>();
const entries = new Map<
  number,
  { revision?: string; before?: SkeletonTextShape; after: SkeletonTextShape }
>();
function shapeFor(cell: CompendiumCell) {
  let shape = shapes.get(cell);
  if (!shape) {
    let characters = 0,
      bold = 0;
    for (const run of cell.runs) {
      characters += run.text.length;
      if (run.bold) bold += run.text.length;
    }
    shape = skeletonTextShape(cell.plain, characters ? bold / characters : 0);
    shapes.set(cell, shape);
  }
  return shape;
}

/** Retain counts, not rendered text or geometry, for entries already painted. */
export function rememberPaneSkeleton(
  hash: number,
  revision: string | undefined,
  before: CompendiumCell | undefined,
  after: CompendiumCell | undefined,
) {
  if (!after) return;
  if (entries.size >= 64) entries.delete(entries.keys().next().value!);
  entries.set(hash, { revision, before: before && shapeFor(before), after: shapeFor(after) });
}

function Cell({
  shape,
  textWidth,
  scale,
}: {
  shape?: SkeletonTextShape;
  textWidth: number;
  scale: number;
}) {
  const lines = shape ? skeletonLineWidths(shape, textWidth) : [92, 78, 85, 60, 0, 92, 78, 55];
  return (
    <CellScale scale={scale}>
      <SkeletonRegion className={styles.skeletonCell}>
        {lines.map((width, index) => (
          <SkeletonLine key={index} width={width} />
        ))}
      </SkeletonRegion>
    </CellScale>
  );
}

export function CompendiumPaneSkeleton({
  base,
  link,
  draft,
  after,
  sourceFetchedAt,
  width,
  scale,
  remPx,
  mode,
  phone,
  canEdit,
  canReview,
  roomy,
  diffControl,
}: {
  base: Tooltip;
  link: Tooltip['compendium'];
  draft: boolean;
  after?: CompendiumCell;
  sourceFetchedAt?: string;
  width?: number;
  scale: number;
  remPx: number;
  mode: CompendiumDiffMode;
  phone: boolean;
  canEdit: boolean;
  canReview: boolean;
  roomy: boolean;
  diffControl: ReactNode;
}) {
  const cached = entries.get(base.hash);
  const previous = cached?.revision === sourceFetchedAt ? cached : undefined;
  const snapshot = link && shapeFor(link.snapshot);
  const current = after ? shapeFor(after) : (previous?.after ?? snapshot);
  const before = snapshot ?? previous?.before;
  const comparison = !!before;
  const twoColumns = comparison && mode === 'before-after';
  const bodyWidth = (width && width > 0 ? width : 384) / Math.min(scale / 100, 1);
  const columnWidth = twoColumns && !phone ? (bodyWidth - 0.75 * remPx) / 2 : bodyWidth;
  const textWidth = Math.max(32, columnWidth - 2 * 0.8 * remPx);
  return (
    <div className={styles.zoom} data-scale={scale} data-pane-skeleton="true">
      <p className={styles.meta}>
        {link && (
          <>
            <span>
              {draft && !base.compendium ? 'Draft snapshot' : 'Snapshot'}{' '}
              <When value={link.snapshotAt} />
            </span>{' '}
          </>
        )}
        {sourceFetchedAt && (
          <span>
            Source fetched <When value={sourceFetchedAt} />
          </span>
        )}
      </p>
      {!link && (
        <SkeletonRegion key="match" className={styles.skeletonStatus}>
          <SkeletonLine width={40} />
        </SkeletonRegion>
      )}
      <SkeletonRegion key="status" className={styles.skeletonStatus}>
        <SkeletonLine width={58} />
        {/* The sheet source link sits on its own line under the notice. */}
        {(link || after) && <SkeletonLine width={46} />}
      </SkeletonRegion>
      {comparison && !roomy && <div className={styles.diffModes}>{diffControl}</div>}
      {comparison && mode === 'changes' && (
        <SkeletonRegion key="legend" className={styles.key}>
          <SkeletonLine width={85} />
        </SkeletonRegion>
      )}
      {twoColumns ? (
        <div key="comparison" className={styles.comparison}>
          <section>
            <h4>Snapshot</h4>
            <Cell scale={scale} shape={before} textWidth={textWidth} />
          </section>
          <section>
            <h4>Current</h4>
            <Cell scale={scale} shape={current} textWidth={textWidth} />
          </section>
        </div>
      ) : (
        <Cell scale={scale} key="cell" shape={current} textWidth={textWidth} />
      )}
      {link && canReview && (
        <div className={styles.actions}>
          <button type="button" disabled>
            Mark as reviewed
          </button>
        </div>
      )}
      {!link && after && canEdit && (
        <div className={styles.actions}>
          <button type="button" disabled>
            Accept match (local draft)
          </button>
        </div>
      )}
      {link && canEdit && (
        <div className={styles.actions}>
          {draft && (
            <button type="button" disabled>
              Review &amp; save draft
            </button>
          )}
          <button type="button" disabled>
            Unlink (local draft)
          </button>
        </div>
      )}
    </div>
  );
}
