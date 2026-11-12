import { useElementWidth } from './useElementWidth';
import {
  Suspense,
  createContext,
  useContext,
  type MutableRefObject,
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
type SkeletonClock = MutableRefObject<number | undefined>;
const SkeletonClockContext = createContext<SkeletonClock | undefined>(undefined);

function useClockHandoff(clock: SkeletonClock, pending: boolean, visible: boolean) {
  useLayoutEffect(() => {
    if (pending || visible || clock.current === undefined) return;
    // Newly mounted descendants get the completed parent's clock before it expires.
    let second: number | undefined;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        clock.current = undefined;
      });
    });
    return () => {
      cancelAnimationFrame(first);
      if (second !== undefined) cancelAnimationFrame(second);
    };
  }, [clock, pending, visible]);
}

/**
 * The one timing rule for every skeleton. Hosts remove obsolete content immediately. After a
 * step, if new content has not committed by the second frame the skeleton shows (first loads,
 * with nothing to keep, show it at once). Once shown it stays at least `skeletonMinimumMs` before
 * the content swaps in. A step to another entry (`identity`) during that time starts over for the
 * new entry: ready by its second frame, it shows directly; otherwise the skeleton (already on
 * screen, so nothing flashes) starts a fresh minimum. Waits never stack. While this returns true
 * the host shows the skeleton instead of content, even if `pending` already turned false.
 */
export function useSkeletonVisible(
  pending: boolean,
  identity: unknown,
  hasContent: boolean,
  clock?: SkeletonClock,
) {
  const inherited = useContext(SkeletonClockContext);
  const [visible, setVisible] = useState(pending && !hasContent);
  const shownAt = useRef<number | undefined>(visible ? Date.now() : undefined);
  const shownFor = useRef(identity);
  useLayoutEffect(() => {
    const show = () => {
      shownAt.current = inherited?.current ?? Date.now();
      if (clock) clock.current = shownAt.current;
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
        else
          afterTwoFrames(() => {
            shownAt.current = inherited?.current ?? Date.now();
            if (clock) clock.current = shownAt.current;
          });
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
  }, [pending, identity, hasContent, visible, inherited, clock]);
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
  const clock = useRef(inherited?.current);
  const clockIdentity = useRef(identity);
  if (clockIdentity.current !== identity) {
    clock.current = undefined;
    clockIdentity.current = identity;
  }
  const visible = useSkeletonVisible(pending && !error, identity, true, clock);
  useClockHandoff(clock, pending && !error, visible);
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
  const clock = useRef(inherited?.current);
  const [pending, setPending] = useState(false);
  const visible = useSkeletonVisible(pending, label, true, clock);
  useClockHandoff(clock, pending, visible);
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
