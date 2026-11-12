import { useElementWidth } from './useElementWidth';
import {
  Suspense,
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
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
type SkeletonClock = { current: number | undefined; identity: unknown };
const SkeletonClockContext = createContext<SkeletonClock | undefined>(undefined);

/**
 * The one timing rule for every skeleton. Hosts remove obsolete content immediately. After a
 * step, if new content has not committed by the second frame the skeleton shows (first loads,
 * with nothing to keep, show it at once). Once shown it stays at least `skeletonMinimumMs` before
 * the content swaps in. A new root boundary identity starts a navigation clock; nested consumers
 * share that clock, including consumers mounted after a lazy import. A superseded entry is
 * discarded immediately, and a warm entry ready by its second frame shows directly. While this returns true
 * the host shows the skeleton instead of content, even if `pending` already turned false.
 */
export function useSkeletonVisible(
  pending: boolean,
  identity: unknown,
  hasContent: boolean,
  clock?: SkeletonClock,
) {
  const inherited = useContext(SkeletonClockContext);
  const activeClock = clock ?? inherited;
  const [visible, setVisible] = useState(pending && !hasContent);
  const shownAt = useRef<number | undefined>(
    visible ? (activeClock?.current ?? Date.now()) : undefined,
  );
  const shownFor = useRef(identity);
  const shownClock = useRef(activeClock);
  useLayoutEffect(() => {
    const show = () => {
      shownAt.current = activeClock?.current ?? Date.now();
      if (activeClock) activeClock.current = shownAt.current;
      shownFor.current = identity;
      shownClock.current = activeClock;
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
      if (shownFor.current !== identity || shownClock.current !== activeClock) {
        // A new entry during the minimum: start over for it.
        shownFor.current = identity;
        shownClock.current = activeClock;
        shownAt.current = undefined;
      }
      if (shownAt.current === undefined) {
        if (!pending) hide();
        else
          afterTwoFrames(() => {
            shownAt.current = activeClock?.current ?? Date.now();
            if (activeClock) activeClock.current = shownAt.current;
          });
      } else {
        if (activeClock && activeClock.current === undefined) activeClock.current = shownAt.current;
        if (!pending) {
          const left = shownAt.current + skeletonMinimumMs - Date.now();
          if (left <= 0) hide();
          else timer = setTimeout(hide, left);
        }
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
  }, [pending, identity, hasContent, visible, activeClock]);
  return visible || (pending && !hasContent);
}

export type LoadingShape = 'page' | 'rows' | 'text' | 'permissions' | 'none';

/** Content-shaped placeholder; status copy remains available to assistive technology. */
export function LoadingSkeleton({
  label,
  shape = 'text',
  count = 3,
  text,
  visible = true,
  rowHeights,
}: {
  label: string;
  shape?: LoadingShape;
  count?: number;
  text?: string;
  visible?: boolean;
  rowHeights?: readonly string[];
}) {
  const element = useRef<HTMLDivElement>(null);
  const width = useElementWidth(element);
  const widths = text
    ? skeletonLineWidths(skeletonTextShape(text), width ?? 360, 16)
    : Array.from({ length: count === 3 ? 4 : count }, (_, i) => [92, 78, 85, 60][i % 4]);
  return (
    <div ref={element} aria-busy="true">
      <SkeletonStatus>{label}</SkeletonStatus>
      {visible && shape !== 'none' && (
        <SkeletonRegion
          className={shape === 'permissions' ? styles.permissions : undefined}
          style={shape === 'page' ? ({ '--gap-y': '0.375rem' } as CSSProperties) : undefined}
        >
          {shape === 'permissions' && (
            <>
              <SkeletonLine width={20} />
              <SkeletonRows
                count={1}
                columns={[24, 20, 42, 14]}
                headers={['GitHub account', 'Role', 'Languages', 'Actions']}
                rowHeight="3.5rem"
              />
              {Array.from({ length: Math.max(1, Math.min(8, count)) }, (_, index) => (
                <SkeletonRows
                  key={index}
                  count={1}
                  columns={[24, 20, 42, 14]}
                  rowHeight={rowHeights?.[index] ?? '9rem'}
                />
              ))}
              <SkeletonRows count={1} columns={[30, 20, 50]} rowHeight="4.5rem" />
            </>
          )}
          {shape === 'page' && (
            <>
              <SkeletonLine width={30} />
              <SkeletonBlock height="8rem" />
              <SkeletonBlock height="8rem" />
              <SkeletonLine width={42} />
            </>
          )}
          {shape === 'text' ? (
            widths.map((width, index) => <SkeletonLine key={index} width={width} />)
          ) : shape === 'rows' ? (
            <SkeletonRows count={Math.max(1, count)} columns={[60, 25, 15]} />
          ) : null}
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
  rowHeights,
}: {
  pending: boolean;
  rowHeights?: readonly string[];
  identity?: unknown;
  error?: boolean;
  label: string;
  shape?: LoadingShape;
  count?: number;
  text?: string;
  children?: ReactNode | ((pending: boolean) => ReactNode);
}) {
  const inherited = useContext(SkeletonClockContext);
  const ownClock = useMemo<SkeletonClock>(() => ({ current: undefined, identity }), [identity]);
  const clock = inherited ?? ownClock;
  const visible = useSkeletonVisible(pending && !error, identity, true, clock);
  // Keep the navigation's shown-at time for descendants that mount after a lazy
  // import. Their own minimum must not restart after this boundary has finished.
  const holding = !error && (pending || visible);
  const content =
    typeof children === 'function' ? (
      children(holding)
    ) : holding ? (
      <LoadingSkeleton
        label={label}
        shape={shape}
        count={count}
        text={text}
        visible={visible}
        rowHeights={rowHeights}
      />
    ) : (
      children
    );
  return <SkeletonClockContext.Provider value={clock}>{content}</SkeletonClockContext.Provider>;
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
export function SkeletonSuspense({
  label,
  children,
  shape = 'page',
}: {
  label: string;
  children: ReactNode;
  shape?: LoadingShape;
}) {
  const inherited = useContext(SkeletonClockContext);
  const ownClock = useMemo<SkeletonClock>(() => ({ current: undefined, identity: label }), [label]);
  const clock = inherited ?? ownClock;
  const [pending, setPending] = useState(false);
  const visible = useSkeletonVisible(pending, label, true, clock);
  return (
    <SkeletonClockContext.Provider value={clock}>
      {(pending || visible) && <LoadingSkeleton label={label} shape={shape} visible={visible} />}
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
    </SkeletonClockContext.Provider>
  );
}
