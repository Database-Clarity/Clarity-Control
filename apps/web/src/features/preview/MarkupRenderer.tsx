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
      onClick={() => open()}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !box.current?.matches(':popover-open, [data-open]')) return;
        // The term closes first; a host dialog would otherwise cancel on Escape's default action.
        event.preventDefault();
        event.stopPropagation();
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
    return (
      <>
        ⁠<span className={classNames(part.classNames)} aria-label="leads to" />⁠
      </>
    );
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
const isIcon = (part: MarkupSpan) => !part.text && !part.title && !!part.classNames?.length;
/** The first word of a plain text part (no title, no link), or nothing. */
const firstWord = (part: MarkupSpan | undefined) =>
  part && !part.title && !part.link && typeof part.text === 'string'
    ? /^\S+/.exec(part.text)?.[0]
    : undefined;
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
/**
 * An icon and the word right after it (`<solar/>Scorch`, `<solar Scorch />`) share one
 * unbreakable run (iconGlue), so an icon is never left alone at a line end; a space after the icon
 * still breaks. Lines without such an icon render exactly as before.
 */
const normalParts: RenderParts = (parts) => {
  const out: ReactNode[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const next = parts[index + 1];
    const word = isIcon(part) ? firstWord(next) : undefined;
    if (!word) {
      out.push(<PreviewSpan key={index} part={part} />);
      continue;
    }
    out.push(
      <span key={index} className={styles.iconGlue}>
        <PreviewSpan part={part} />
        <PreviewSpan part={textPart(next, 0, word.length)} />
      </span>,
    );
    if (word.length < next.text!.length)
      out.push(<PreviewSpan key={`${index}+`} part={textPart(next, word.length)} />);
    index++;
  }
  return out;
};
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
                  {renderParts(cell.cellContent)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <div className={className}>{renderParts(line.linesContent ?? [])}</div>
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
