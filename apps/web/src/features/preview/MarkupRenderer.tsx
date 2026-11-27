import {
  Fragment,
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { MarkupLine, MarkupSpan } from '@clarity/core';
import {
  symbolWrapEdges,
  symbolWrapRuns,
  type WrapPart,
} from '../../../../../packages/core/src/markup/renderWrapping';
import { HOVER_REST } from '../../ui/anchorPlacement';
import { closeTitlePopover, isTitlePopoverOpen, openTitlePopover } from './titlePopover';
import styles from './TooltipPreview.module.scss';

export function classNames(names?: (string | undefined)[]) {
  return names?.flatMap((name) => (name && styles[name] ? [styles[name]] : [])).join(' ');
}

export function linkUrl(url: string): string | undefined {
  return /^(https?:\/\/|mailto:)/i.test(url.trim()) ? url.trim() : undefined;
}

/**
 * A term with a tooltip: hover or focus opens its body as a top-layer popover (titlePopover.ts), Esc
 * closes it. The body stays rendered, so opening costs one placement and no React work.
 */
export function TitleAnchor({
  part,
  id: suppliedId,
  children,
}: {
  part: MarkupSpan;
  id?: string;
  children?: ReactNode;
}) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const box = useRef<HTMLSpanElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const leaving = useRef<ReturnType<typeof setTimeout>>();
  // The mouse over the anchor: its latest point, and the rest timer that opens the box there.
  const hovered = useRef<{ x: number; y: number }>();
  const resting = useRef<ReturnType<typeof setTimeout>>();
  // Escape keeps it closed until the pointer leaves, as a native title does.
  const dismissed = useRef(false);
  // One stable function: it is also the scroll listener, since scrolling anything while the popover
  // is open would leave a fixed box behind its anchor.
  const hide = useMemo(() => {
    const close = () => {
      clearTimeout(leaving.current);
      clearTimeout(resting.current);
      window.removeEventListener('scroll', close, true);
      if (box.current) closeTitlePopover(box.current);
    };
    return close;
  }, []);
  const open = (pointer?: { x: number; y: number }) => {
    clearTimeout(resting.current);
    if (!anchor.current || !box.current) return;
    // Open already (hovered, then pressed or focused): it stays where it is.
    if (isTitlePopoverOpen(box.current)) return;
    openTitlePopover(anchor.current, box.current, pointer);
    window.addEventListener('scroll', hide, { capture: true, passive: true });
  };
  // The box opens once the mouse has rested HOVER_REST ms, where it is then (like a native title).
  const rest = (event: ReactPointerEvent) => {
    if (event.pointerType === 'touch' || dismissed.current) return;
    if (box.current && isTitlePopoverOpen(box.current)) return;
    hovered.current = { x: event.clientX, y: event.clientY };
    clearTimeout(resting.current);
    resting.current = setTimeout(() => open(hovered.current), HOVER_REST);
  };
  useEffect(() => hide, [hide]);
  return (
    <span
      ref={anchor}
      className={styles.titleAnchor}
      tabIndex={0}
      aria-describedby={id}
      onPointerEnter={(event) => {
        clearTimeout(leaving.current);
        // A new entry may open again (Escape on a keyboard-opened box set this with no leave).
        dismissed.current = false;
        // Back from the gap into the open box (a child) keeps it where it is.
        rest(event);
      }}
      onPointerMove={rest}
      // A short grace lets the pointer cross the gap below the anchor into the box.
      onPointerLeave={() => {
        hovered.current = undefined;
        dismissed.current = false;
        clearTimeout(resting.current);
        clearTimeout(leaving.current);
        leaving.current = setTimeout(hide, 150);
      }}
      // Pressed before the rest ends: at the pointer; keyboard focus and taps: at the anchor.
      onFocus={() => open(hovered.current)}
      onClick={() => open(hovered.current)}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !box.current || !isTitlePopoverOpen(box.current)) return;
        // The term closes first; a host dialog would otherwise cancel on Escape's default action.
        event.preventDefault();
        event.stopPropagation();
        dismissed.current = true;
        hide();
      }}
    >
      {children ?? part.text}
      <span
        ref={box}
        {...{ popover: 'manual' }}
        className={styles.titleContainer}
        role="tooltip"
        id={id}
      >
        <Lines lines={part.title ?? []} />
      </span>
    </span>
  );
}

/** One span of rendered markup: text, icon, link or title anchor. */
function numberText(part: MarkupSpan): ReactNode {
  if ((!part.slots?.length && !part.variables?.length) || !part.text) return part.text;
  const out: ReactNode[] = [];
  let at = 0;
  const ranges = [...(part.slots ?? []), ...(part.variables ?? [])].sort((a, b) => a.from - b.from);
  for (const slot of ranges) {
    if (slot.from > at) out.push(part.text.slice(at, slot.from));
    out.push(
      <span
        key={`${'id' in slot ? slot.id : slot.name}:${slot.from}`}
        data-slot={'id' in slot ? slot.id : undefined}
        title={'name' in slot ? `Variable ${slot.name}: type #{${slot.name}}` : undefined}
      >
        {part.text.slice(slot.from, slot.to)}
      </span>,
    );
    at = slot.to;
  }
  if (at < part.text.length) out.push(part.text.slice(at));
  return out;
}
export function PreviewSpan({ part }: { part: MarkupSpan }) {
  const id = useId();
  const link = part.link ? linkUrl(part.link) : undefined;
  if (part.classNames?.includes('arrow'))
    return <span className={classNames(part.classNames)} aria-label="leads to" />;
  return (
    <span className={classNames(part.classNames)}>
      {part.title ? (
        <TitleAnchor part={part} id={id}>
          {numberText(part)}
        </TitleAnchor>
      ) : link ? (
        <a href={link} target="_blank" rel="noreferrer">
          {numberText(part)}
        </a>
      ) : part.link ? (
        <TitleAnchor
          part={{ text: part.text, title: [{ linesContent: [{ text: 'Unsafe link omitted' }] }] }}
          id={id}
        />
      ) : (
        <span>{numberText(part)}</span>
      )}
    </span>
  );
}

// A keystroke usually changes one line. Parsed lines are plain render data, so retain
// the unchanged React subtrees even when a fresh parse creates new line objects.
// Memoized props keep their immutable line objects; do not serialize those same
// objects again on every key. Weak keys also release obsolete parse results.
const lineKeys = new WeakMap<MarkupLine, string>();
function lineKey(line: MarkupLine) {
  let key = lineKeys.get(line);
  if (key === undefined) {
    key = JSON.stringify(line);
    lineKeys.set(line, key);
  }
  return key;
}
type RenderParts = (parts: MarkupSpan[]) => ReactNode;
function previewSymbol(part: MarkupSpan): WrapPart['symbol'] {
  if (part.classNames?.includes('arrow')) return 'arrow';
  if (
    (!part.text && !part.title && part.classNames?.length) ||
    part.classNames?.includes('enhancedArrow')
  )
    return 'icon';
}
function textPart(part: MarkupSpan, from: number, to = part.text!.length): MarkupSpan {
  return {
    ...part,
    text: part.text!.slice(from, to),
    ...(part.slots && {
      slots: part.slots
        .filter((slot) => slot.to > from && slot.from < to)
        .map((slot) => ({
          id: slot.id,
          from: Math.max(slot.from, from) - from,
          to: Math.min(slot.to, to) - from,
        })),
    }),
    ...(part.variables && {
      variables: part.variables
        .filter((variable) => variable.to > from && variable.from < to)
        .map((variable) => ({
          name: variable.name,
          from: Math.max(variable.from, from) - from,
          to: Math.min(variable.to, to) - from,
        })),
    }),
  };
}
const normalParts: RenderParts = (parts) =>
  parts.map((part, index) => <PreviewSpan key={index} part={part} />);

export function renderWrappedParts(parts: MarkupSpan[], draw: RenderParts = normalParts) {
  if (!parts.some(previewSymbol)) return draw(parts);
  const layout = parts.map((part) => ({
    text: part.text,
    symbol: previewSymbol(part),
    atomic: Boolean(part.title || part.link),
    ranges:
      part.slots?.length || part.variables?.length
        ? [...(part.slots ?? []), ...(part.variables ?? [])]
        : undefined,
  }));
  const runs = symbolWrapRuns(layout);
  if (!runs.some((run) => run.glued)) return draw(parts);
  const content = (slices: (typeof runs)[number]['slices']) =>
    draw(
      slices.map(({ index, from, to }) => {
        const part = parts[index];
        return from === 0 && to === (part.text?.length ?? 0) ? part : textPart(part, from, to);
      }),
    );
  return runs.map(({ glued, slices }, index) =>
    glued ? (
      <span key={index} className={styles.iconGlue}>
        {symbolWrapEdges(layout, slices).map((edge, key) =>
          edge.glued ? (
            <span key={key} className={styles.iconJoin}>
              {content(edge.slices)}
            </span>
          ) : (
            <Fragment key={key}>{content(edge.slices)}</Fragment>
          ),
        )}
      </span>
    ) : (
      <Fragment key={index}>{content(slices)}</Fragment>
    ),
  );
}
const PreviewLine = memo(
  function PreviewLine({
    line,
    renderParts = normalParts,
    extraClass,
  }: {
    line: MarkupLine;
    renderParts?: RenderParts;
    extraClass?: string;
  }) {
    // Without a decoration the preview's DOM stays exactly as before.
    const className = extraClass
      ? [classNames(line.classNames), extraClass].filter(Boolean).join(' ')
      : classNames(line.classNames);
    return line.table ? (
      <table className={className}>
        <tbody>
          {line.table.map((row, rowIndex) => (
            <tr key={rowIndex} className={classNames(row.classNames)}>
              {row.rowContent?.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  colSpan={cell.colSpan}
                  rowSpan={cell.rowSpan}
                  className={classNames(cell.classNames)}
                >
                  {renderWrappedParts(cell.cellContent, renderParts)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <div className={className}>{renderWrappedParts(line.linesContent ?? [], renderParts)}</div>
    );
  },
  (previous, next) =>
    previous.renderParts === next.renderParts &&
    previous.extraClass === next.extraClass &&
    (previous.line === next.line || lineKey(previous.line) === lineKey(next.line)),
);

export function Lines({ lines }: { lines: MarkupLine[] }) {
  return <MarkupLines lines={lines} />;
}

/** One markup tree renderer; comparison views may decorate spans and positions. */
export function MarkupLines({
  lines,
  renderParts,
  beforeLine,
  afterLines,
  lineClass,
}: {
  lines: MarkupLine[];
  renderParts?: RenderParts;
  beforeLine?: (index: number) => ReactNode;
  afterLines?: ReactNode;
  lineClass?: (line: MarkupLine) => string | undefined;
}) {
  return (
    <>
      {lines.map((line, index) => (
        <Fragment key={index}>
          {beforeLine?.(index)}
          <PreviewLine line={line} renderParts={renderParts} extraClass={lineClass?.(line)} />
        </Fragment>
      ))}
      {afterLines}
    </>
  );
}
