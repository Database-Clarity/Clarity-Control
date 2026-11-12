import { Fragment, memo, useEffect, useId, useMemo, useRef, type ReactNode } from 'react';
import type { MarkupLine, MarkupSpan } from '@clarity/core';
import { closeTitlePopover, openTitlePopover } from './titlePopover';
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
function TitleAnchor({ part, id }: { part: MarkupSpan; id: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  // One stable function: it is also the scroll listener, since scrolling anything while the popover
  // is open would leave a fixed box behind its anchor.
  const hide = useMemo(() => {
    const close = () => {
      window.removeEventListener('scroll', close, true);
      if (box.current) closeTitlePopover(box.current);
    };
    return close;
  }, []);
  const open = (pointer?: { x: number; y: number }) => {
    if (!anchor.current || !box.current) return;
    openTitlePopover(anchor.current, box.current, pointer);
    window.addEventListener('scroll', hide, { capture: true, passive: true });
  };
  useEffect(() => hide, [hide]);
  return (
    <span
      ref={anchor}
      className={styles.titleAnchor}
      tabIndex={0}
      aria-describedby={id}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') open({ x: event.clientX, y: event.clientY });
      }}
      onPointerLeave={hide}
      onFocus={() => open()}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !box.current?.matches(':popover-open, [data-open]')) return;
        event.stopPropagation();
        hide();
      }}
    >
      {part.text}
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
export function PreviewSpan({ part }: { part: MarkupSpan }) {
  const id = useId();
  const link = part.link ? linkUrl(part.link) : undefined;
  return (
    <span className={classNames(part.classNames)}>
      {part.title ? (
        <TitleAnchor part={part} id={id} />
      ) : link ? (
        <a href={link} target="_blank" rel="noreferrer">
          {part.text}
        </a>
      ) : (
        <span title={part.link ? 'Unsafe link omitted' : undefined}>{part.text}</span>
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
const normalParts: RenderParts = (parts) =>
  parts.map((part, index) => <PreviewSpan key={index} part={part} />);
const PreviewLine = memo(
  function PreviewLine({
    line,
    renderParts = normalParts,
  }: {
    line: MarkupLine;
    renderParts?: RenderParts;
  }) {
    return line.table ? (
      <table className={classNames(line.classNames)}>
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
                  {renderParts(cell.cellContent)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <div className={classNames(line.classNames)}>{renderParts(line.linesContent ?? [])}</div>
    );
  },
  (previous, next) =>
    previous.renderParts === next.renderParts &&
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
}: {
  lines: MarkupLine[];
  renderParts?: RenderParts;
  beforeLine?: (index: number) => ReactNode;
  afterLines?: ReactNode;
}) {
  return (
    <>
      {lines.map((line, index) => (
        <Fragment key={index}>
          {beforeLine?.(index)}
          <PreviewLine line={line} renderParts={renderParts} />
        </Fragment>
      ))}
      {afterLines}
    </>
  );
}
