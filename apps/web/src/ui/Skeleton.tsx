import { useLayoutEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import styles from './Skeleton.module.scss';

export function SkeletonStatus({ children }: { children: ReactNode }) {
  return (
    <span className={styles.status} role="status">
      {children}
    </span>
  );
}

/** One surface and one shared shimmer. Keep real content outside this region. */
export function SkeletonRegion({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      aria-hidden="true"
      className={[styles.region, className].filter(Boolean).join(' ')}
      style={style}
    >
      {children}
    </div>
  );
}

/** A transparent bar with surface-coloured masks around it. Width is a percentage. */
export function SkeletonLine({ width = 100 }: { width?: number }) {
  return (
    <span
      aria-hidden="true"
      className={styles.line}
      style={{ '--w': `${Math.max(0, Math.min(100, width))}%` } as CSSProperties}
    />
  );
}

export function SkeletonBlock({
  height = '1.5rem',
  width = '100%',
}: {
  height?: string;
  width?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={styles.block}
      style={{ '--h': height, '--w': width } as CSSProperties}
    />
  );
}

/** Put rows inside one SkeletonRegion; maxRows comes from a cached viewport size + 2. */
export function SkeletonRows({
  count = 3,
  maxRows = 8,
  columns = [60, 25, 15],
  headers,
  rowHeight = '2.25rem',
}: {
  count?: number;
  maxRows?: number;
  columns?: readonly number[];
  headers?: readonly string[];
  rowHeight?: string;
}) {
  return Array.from({ length: Math.max(0, Math.min(count, maxRows)) }, (_, index) => (
    <div
      key={index}
      className={styles.row}
      aria-hidden="true"
      style={{ '--row-h': rowHeight } as CSSProperties}
    >
      {columns.map((width, column) => (
        <span
          key={column}
          className={styles.rowColumn}
          style={
            {
              width: `${width}%`,
              '--w': headers?.[column]
                ? `min(calc(100% - 0.75rem), ${headers[column].length * 0.4565}em)`
                : 'calc(100% - 0.75rem)',
            } as CSSProperties
          }
        />
      ))}
    </div>
  ));
}

export type SkeletonTextShape = { lengths: readonly number[]; boldShare: number };

export function skeletonTextShape(plain: string, boldShare = 0): SkeletonTextShape {
  return {
    lengths: plain.split('\n').map((line) => (line.trim() ? line.trimEnd().length : 0)),
    boldShare,
  };
}

/** Arial census: 0.4565 em per character, +8% for bold, and a 0.1-line wrap bias. */
export function skeletonLineWidths(
  shape: SkeletonTextShape,
  textWidthPx: number,
  fontPx = (10 * 4) / 3,
): number[] {
  const em = fontPx * 0.4565 * (1 + 0.08 * shape.boldShare);
  const width = Math.max(1, textWidthPx);
  return shape.lengths.flatMap((length) => {
    if (!length) return [0];
    const lines = Math.max(1, Math.ceil((length * em) / width - 0.1));
    return [
      ...Array.from({ length: lines - 1 }, () => 100),
      Math.min(100, Math.max(12, Math.round((length * em * 100) / width - (lines - 1) * 100))),
    ];
  });
}

/** Preserve content for one frame; first loads show immediately. A shown region stays mounted. */
export function useSkeletonVisible(pending: boolean, identity: unknown, hasContent: boolean) {
  const [visible, setVisible] = useState(pending && !hasContent);
  useLayoutEffect(() => {
    if (!pending) {
      setVisible(false);
      return;
    }
    if (!hasContent) {
      setVisible(true);
      return;
    }
    if (visible) return;
    let second: number | undefined;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => flushSync(() => setVisible(true)));
    });
    return () => {
      cancelAnimationFrame(first);
      if (second !== undefined) cancelAnimationFrame(second);
    };
  }, [pending, identity, hasContent, visible]);
  return pending && (!hasContent || visible);
}
