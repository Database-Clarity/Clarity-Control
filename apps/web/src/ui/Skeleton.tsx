import { useElementWidth } from './useElementWidth';
import {
  Suspense,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import styles from './Skeleton.module.scss';

export function SkeletonStatus({ children }: { children: ReactNode }) {
  return (
    <span
      className={styles.status}
      role="status"
      aria-label={typeof children === 'string' ? children.replace(/[.…]+$/, '') : undefined}
    >
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

/** Once shown, a skeleton stays at least this long (ms), so it never only flashes. */
export const skeletonMinimumMs = 400;

/**
 * The one timing rule for every skeleton. Hosts remove obsolete content immediately. After a
 * step, if new content has not committed by the second frame the skeleton shows (first loads,
 * with nothing to keep, show it at once). Once shown it stays at least `skeletonMinimumMs` before
 * the content swaps in. A step to another entry (`identity`) during that time starts over for the
 * new entry: ready by its second frame, it shows directly; otherwise the skeleton (already on
 * screen, so nothing flashes) starts a fresh minimum. Waits never stack. While this returns true
 * the host shows the skeleton instead of content, even if `pending` already turned false.
 */
export function useSkeletonVisible(pending: boolean, identity: unknown, hasContent: boolean) {
  const [visible, setVisible] = useState(pending && !hasContent);
  const shownAt = useRef<number | undefined>(visible ? Date.now() : undefined);
  const shownFor = useRef(identity);
  useLayoutEffect(() => {
    const show = () => {
      shownAt.current = Date.now();
      shownFor.current = identity;
      setVisible(true);
    };
    const hide = () => {
      shownAt.current = undefined;
      setVisible(false);
    };
    let active = true;
    let first: number | undefined;
    let second: number | undefined;
    // Two frames for this entry, then the skeleton (and its minimum) belong to it.
    const afterTwoFrames = (then: () => void) => {
      first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => {
          if (active) flushSync(then);
        });
      });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (visible) {
      if (shownFor.current !== identity) {
        // A new entry during the minimum: start over for it.
        shownFor.current = identity;
        shownAt.current = undefined;
      }
      if (shownAt.current === undefined) {
        if (!pending) hide();
        else afterTwoFrames(() => (shownAt.current = Date.now()));
      } else if (!pending) {
        const left = shownAt.current + skeletonMinimumMs - Date.now();
        if (left <= 0) hide();
        else timer = setTimeout(hide, left);
      }
    } else if (pending) {
      if (!hasContent) show();
      else afterTwoFrames(show);
    }
    return () => {
      active = false;
      if (first !== undefined) cancelAnimationFrame(first);
      if (second !== undefined) cancelAnimationFrame(second);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [pending, identity, hasContent, visible]);
  return visible || (pending && !hasContent);
}

export type LoadingShape = 'page' | 'rows' | 'text';

/** Content-shaped placeholder; status copy remains available to assistive technology. */
export function LoadingSkeleton({
  label,
  shape = 'text',
  count = 3,
  text,
  visible = true,
}: {
  label: string;
  shape?: LoadingShape;
  count?: number;
  text?: string;
  visible?: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const width = useElementWidth(element);
  const widths = text
    ? skeletonLineWidths(skeletonTextShape(text), width ?? 360, 16)
    : [92, 78, 85, 60];
  return (
    <div ref={element} aria-busy="true">
      <SkeletonStatus>{label}</SkeletonStatus>
      {visible && (
        <SkeletonRegion>
          {shape === 'page' && (
            <>
              <SkeletonLine width={30} />
              <SkeletonBlock height="8rem" />
            </>
          )}
          {shape === 'text' ? (
            widths.map((width, index) => <SkeletonLine key={index} width={width} />)
          ) : (
            <SkeletonRows count={count} columns={shape === 'page' ? [30, 70] : [65, 35]} />
          )}
        </SkeletonRegion>
      )}
    </div>
  );
}

/** Always mount this boundary, including after the request resolves, to honour the minimum. */
export function SkeletonBoundary({
  pending,
  identity = 'content',
  error = false,
  label,
  shape,
  count,
  text,
  children,
}: {
  pending: boolean;
  identity?: unknown;
  error?: boolean;
  label: string;
  shape?: LoadingShape;
  count?: number;
  text?: string;
  children?: ReactNode;
}) {
  const visible = useSkeletonVisible(pending && !error, identity, true);
  if (error) return children;
  return pending || visible ? (
    <LoadingSkeleton label={label} shape={shape} count={count} text={text} visible={visible} />
  ) : (
    children
  );
}

function PendingCommit({
  pending,
  onChange,
  children,
}: {
  pending: boolean;
  onChange: (pending: boolean) => void;
  children?: ReactNode;
}) {
  useLayoutEffect(() => onChange(pending), [pending, onChange]);
  return children;
}

/** Keep the resolved subtree mounted while the shared minimum finishes. */
export function SkeletonSuspense({ label, children }: { label: string; children: ReactNode }) {
  const [pending, setPending] = useState(false);
  const visible = useSkeletonVisible(pending, label, true);
  return (
    <>
      {(pending || visible) && <LoadingSkeleton label={label} shape="page" visible={visible} />}
      <div
        hidden={pending || visible}
        style={pending || visible ? undefined : { display: 'contents' }}
      >
        <Suspense fallback={<PendingCommit pending onChange={setPending} />}>
          <PendingCommit pending={false} onChange={setPending}>
            {children}
          </PendingCommit>
        </Suspense>
      </div>
    </>
  );
}
