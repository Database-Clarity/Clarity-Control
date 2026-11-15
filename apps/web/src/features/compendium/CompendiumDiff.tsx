import {
  memo,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from 'react';
import type { CompendiumCell } from '@clarity/core';
import { preparedLines } from './compendiumDiffCache';
import { lineAlign, type DiffLine, type StyleNote } from './compendiumDiffProjection';
import { Multiline, RichCell } from './RichCell';
import { SheetCell } from './sheetSurface';
import { useSettingsStore } from '../../stores/settings';
import { Segmented } from '../../ui/RightPane';
import styles from './Compendium.module.scss';

export type CompendiumDiffMode = 'changes' | 'before-after';
const diffModeOptions = [
  { value: 'changes', label: 'Changes' },
  { value: 'before-after', label: 'Before / After' },
] as const;
/** Old blocks longer than this start folded: the first lines, then a count to unfold. */
const OLD_FOLD_LINES = 6;
const OLD_FOLD_SHOWN = 2;

/** The diff view remembered on this device (Changes until the user picks Before / After). */
export function useCompendiumDiffMode(): [CompendiumDiffMode, (mode: CompendiumDiffMode) => void] {
  const mode = useSettingsStore((state) => state.device.remembered.compendiumDiff ?? 'changes');
  const remember = useSettingsStore((state) => state.remember);
  return [mode, (value) => remember({ compendiumDiff: value })];
}

/** Changes | Before / After. The Compendium pane puts it in its header; other callers get it inline. */
export function CompendiumDiffModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: CompendiumDiffMode;
  onChange(mode: CompendiumDiffMode): void;
  disabled?: boolean;
}) {
  return (
    <Segmented
      label="Compendium diff view"
      value={mode}
      options={diffModeOptions}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

/** Mount positioning state and listeners only for the popup the user opens. */
function StylePopover({ id, note }: { id: string; note: StyleNote }) {
  const [place, setPlace] = useState<{
    offset: number;
    width?: number;
    top?: number;
    maxHeight?: number;
  }>({ offset: 0 });
  const popover = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const position = () => {
      const element = popover.current;
      const anchor = element?.parentElement;
      if (!element || !anchor) return;
      const scrollport = anchor.closest('[data-cell-scale]')?.parentElement;
      // Native popovers escape the cell's overflow clip while retaining inherited sheet styles
      // and zoom. Other consumers keep their existing absolute popover layout.
      const floating = !!scrollport && typeof element.showPopover === 'function';
      if (floating && !element.hasAttribute('popover')) {
        element.setAttribute('popover', 'manual');
        Object.assign(element.style, { position: 'fixed', inset: 'auto', margin: '0' });
        element.showPopover();
      }
      // Stay inside the visible cell scrollport and the window. Rectangles are in
      // window pixels; the styles set here are in the pane's own, zoomed, pixels.
      const cell = anchor.closest('[data-surface]')?.getBoundingClientRect();
      const visible = scrollport?.getBoundingClientRect();
      const low = Math.max(8, cell?.left ?? 0, visible?.left ?? 0);
      const high = Math.min(
        document.documentElement.clientWidth - 8,
        cell?.right ?? Infinity,
        visible?.right ?? Infinity,
      );
      // Measure intrinsic width again on scroll/resize, rather than treating the previous
      // constrained width as intrinsic and accidentally removing its clamp.
      const previousWidth = element.style.width;
      if (floating) element.style.width = '';
      const intrinsic = element.getBoundingClientRect();
      const zoom = element.offsetWidth ? intrinsic.width / element.offsetWidth : 1;
      const width = Math.min(intrinsic.width, Math.max(1, high - low));
      const constrainedWidth = width < intrinsic.width ? Math.floor(width / zoom) : undefined;
      if (floating && constrainedWidth !== undefined) element.style.width = `${constrainedWidth}px`;
      const box = floating ? element.getBoundingClientRect() : intrinsic;
      if (floating) element.style.width = previousWidth;
      const anchorBox = anchor.getBoundingClientRect();
      const left = anchorBox.left;
      const next = {
        offset: Math.round(
          (Math.max(low, Math.min(left, high - width)) - (floating ? 0 : left)) / zoom,
        ),
        maxHeight: floating ? (window.innerHeight - 16) / zoom : undefined,
        top: floating
          ? Math.max(8, Math.min(anchorBox.bottom, window.innerHeight - box.height - 8)) / zoom
          : undefined,
        width: constrainedWidth,
      };
      setPlace((current) =>
        current.offset === next.offset &&
        current.width === next.width &&
        current.top === next.top &&
        current.maxHeight === next.maxHeight
          ? current
          : next,
      );
    };
    position();
    window.addEventListener('resize', position);
    const onScroll = (event: Event) => {
      // Scrolling the detail itself does not move its anchor. Avoid remeasuring its width,
      // which can otherwise disturb the detail's own scroll position.
      if (event.target instanceof Node && popover.current?.contains(event.target)) return;
      position();
    };
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [note]);
  return (
    <span
      ref={popover}
      id={id}
      className={styles.stylePopover}
      role="tooltip"
      style={{
        insetInlineStart: place.offset,
        width: place.width,
        ...(place.top === undefined
          ? {}
          : {
              position: 'fixed',
              inset: 'auto',
              left: place.offset,
              top: place.top,
              margin: 0,
              maxHeight: place.maxHeight,
              overflow: 'auto',
            }),
      }}
    >
      <span>{note.description}</span>
      <span className={styles.swatches}>
        {[note.before, note.after].map((cell, index) => (
          <span key={index}>
            {index ? 'Current' : 'Snapshot'}{' '}
            {[...new Set(cell.runs.map((run) => run.color).filter(Boolean))].map((color) => (
              <span
                key={color}
                className={styles.swatch}
                style={{ backgroundColor: color }}
                title={color}
              />
            ))}
          </span>
        ))}
      </span>
      <span>Snapshot:</span>
      <span className={styles.popoverSnapshot}>
        <RichCell cell={note.before} inline />
      </span>
    </span>
  );
}

/** State that starts over when `owner` changes: another entry's line reusing this row. */
function useOwnedState<T>(owner: unknown, initial: T) {
  const [state, setState] = useState({ owner, value: initial });
  if (state.owner !== owner) setState({ owner, value: initial });
  return [
    state.owner === owner ? state.value : initial,
    (value: T) => setState({ owner, value }),
  ] as const;
}

const markClosed = { open: false, hovered: false, focused: false };
/** One compact marker per line whose styling changed; the detail opens on hover, focus, or tap. */
const StyleMark = memo(function StyleMark({ note }: { note: StyleNote }) {
  const [mark, setMark] = useOwnedState(note, markClosed);
  const visible = mark.open || mark.hovered || mark.focused;
  const id = useId();
  return (
    <span
      className={styles.styleChange}
      data-open={visible}
      onMouseEnter={() => setMark({ ...mark, hovered: true })}
      onMouseLeave={() => setMark({ ...mark, hovered: false })}
      onFocus={() => setMark({ ...mark, focused: true })}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setMark(markClosed);
      }}
    >
      <button
        type="button"
        className={styles.styleMark}
        aria-label={`Style changed: ${note.description}`}
        aria-describedby={id}
        aria-expanded={visible}
        onClick={() => setMark({ ...markClosed, open: !mark.open })}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && visible) {
            // Only the marker closes: neither a host popover nor a native dialog (whose
            // cancel is Escape's default action) takes this first Escape.
            event.preventDefault();
            event.stopPropagation();
            setMark(markClosed);
          }
        }}
      >
        Aa
      </button>
      {visible ? (
        <StylePopover id={id} note={note} />
      ) : (
        <span id={id} className={styles.stylePopover} role="tooltip">
          {/* Retain the full accessible description while the popup is hidden. */}
          {`Snapshot: ${note.before.plain}`}
        </span>
      )}
    </span>
  );
});

/** One physical line. Every line but the cell's last keeps its newline, so the text stays exact. */
function Line({
  cell,
  last,
  children,
}: {
  cell: CompendiumCell;
  last?: boolean;
  children?: ReactNode;
}) {
  return (
    <span className={styles.diffLine} style={{ textAlign: lineAlign(cell) }}>
      {children ?? <RichCell cell={cell} inline />}
      {!last && '\n'}
    </span>
  );
}

/** Rewritten lines: the old lines muted above the new ones; long old runs start folded. */
function Block({
  before,
  after,
  last,
}: {
  before: CompendiumCell[];
  after: CompendiumCell[];
  last: boolean;
}) {
  const [unfolded, setUnfolded] = useOwnedState(before, false);
  const long = before.length > OLD_FOLD_LINES;
  const shown = long && !unfolded ? before.slice(0, OLD_FOLD_SHOWN) : before;
  return (
    <span className={styles.hunk}>
      {before.length > 0 && (
        <del className={styles.old}>
          {shown.map((cell, index) => (
            <Line
              key={index}
              cell={cell}
              last={last && !after.length && index === before.length - 1}
            />
          ))}
        </del>
      )}
      {long && (
        <button
          type="button"
          className={styles.unfold}
          aria-expanded={unfolded}
          onClick={() => setUnfolded(!unfolded)}
        >
          {unfolded
            ? 'Show fewer removed lines'
            : `\u2026 ${before.length - OLD_FOLD_SHOWN} more removed lines`}
        </button>
      )}
      {after.length > 0 && (
        <ins className={styles.new}>
          {after.map((cell, index) => (
            <Line key={index} cell={cell} last={last && index === after.length - 1} />
          ))}
        </ins>
      )}
    </span>
  );
}

function DiffLineView({ line, last }: { line: DiffLine; last: boolean }) {
  if (line.kind === 'block') return <Block before={line.before} after={line.after} last={last} />;
  if (line.kind === 'equal')
    return (
      <Line cell={line.cell} last={last}>
        <RichCell cell={line.cell} inline />
        {line.style && <StyleMark note={line.style} />}
      </Line>
    );
  return (
    <Line cell={line.after} last={last}>
      {line.parts.map((part, index) =>
        part.kind === 'removed' ? (
          <del key={index} className={styles.removed}>
            <RichCell cell={part.cell} inline />
          </del>
        ) : part.kind === 'added' ? (
          <ins key={index} className={styles.added}>
            <RichCell cell={part.cell} inline />
          </ins>
        ) : (
          <RichCell key={index} cell={part.cell} inline />
        ),
      )}
      {line.style && <StyleMark note={line.style} />}
    </Line>
  );
}

export function CompendiumDiff({
  before,
  after,
  mode: given,
  scale,
}: {
  before: CompendiumCell;
  after: CompendiumCell;
  /** The view, when the caller shows the toggle itself; without it the diff brings its own. */
  mode?: CompendiumDiffMode;
  /** Only the editor pane supplies its device cell scale. */
  scale?: number;
}) {
  const [remembered, setRemembered] = useCompendiumDiffMode();
  const mode = given ?? remembered;
  const sideBySide = mode === 'before-after';
  // Links store no background; both sides sit on the row's current one.
  const background = after.background ?? before.background;
  const prepared = useMemo(
    () => (sideBySide ? undefined : preparedLines(before, after)),
    [before, after, sideBySide],
  );
  const differs =
    !!prepared &&
    (!!prepared.cellStyle ||
      prepared.lines.some((line) => line.kind !== 'equal' || line.style !== undefined));
  return (
    <section aria-label="Styled Compendium diff">
      {given === undefined && (
        <div className={styles.diffModes}>
          <CompendiumDiffModeToggle mode={mode} onChange={setRemembered} />
        </div>
      )}
      {!prepared ? (
        <div className={styles.comparison}>
          <section>
            <h4>Snapshot</h4>
            <CellScale scale={scale}>
              <SheetCell background={background}>
                <RichCell cell={before} />
              </SheetCell>
            </CellScale>
          </section>
          <section>
            <h4>Current</h4>
            <CellScale scale={scale}>
              <SheetCell background={background}>
                <RichCell cell={after} />
              </SheetCell>
            </CellScale>
          </section>
        </div>
      ) : (
        <>
          {/* Nothing to explain when the cell matches: the key appears only with a difference. */}
          {differs && (
            <p className={styles.key}>
              <span className={styles.removed}>removed</span>
              <span className={styles.added}>added</span>
              <span>
                <span className={styles.styleMark} aria-hidden="true">
                  Aa
                </span>{' '}
                style changed, hover for detail
              </span>
              {prepared.cellStyle && (
                <span className={styles.cellStyle}>Whole cell: {prepared.cellStyle}</span>
              )}
            </p>
          )}
          <CellScale scale={scale}>
            <SheetCell background={background}>
              <Multiline>
                {prepared.lines.map((line, index) => (
                  <DiffLineView
                    key={index}
                    line={line}
                    last={index === prepared.lines.length - 1}
                  />
                ))}
              </Multiline>
            </SheetCell>
          </CellScale>
        </>
      )}
    </section>
  );
}

/** Scale editor cell contents while keeping its layout at pane width; other surfaces stay unchanged. */
export function CellScale({ children, scale }: { children: ReactNode; scale?: number }) {
  if (scale === undefined) return <>{children}</>;
  return (
    <div className={styles.cellScroll}>
      <div
        className={styles.cellScale}
        data-cell-scale={scale}
        style={{ '--cell-scale': scale / 100 } as CSSProperties}
      >
        {children}
      </div>
    </div>
  );
}
