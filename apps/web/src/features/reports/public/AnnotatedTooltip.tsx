import { memo, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import preview from '../../preview/TooltipPreview.module.scss';
import type { PublicAnchor } from '../../../services/reports';
import {
  categoryLabels,
  isWholeLine,
  type DraftNote,
  type Mark,
  type ReportCategory,
} from './draft';
import type { RenderLine, RenderPart, ReportRender } from './tooltipRender';
import styles from './ReportPage.module.scss';

const cls = (names?: (string | undefined)[]) =>
  names?.flatMap((name) => (name && preview[name] ? [preview[name]] : [])).join(' ');

export type LineKey = 'mark' | 'next' | 'prev';

interface Props {
  render: ReportRender;
  notes: DraftNote[];
  /** Open reports from other players whose revision matches this text. */
  existing: PublicAnchor[];
  onTap(line: RenderLine, at: number): void;
  onSelect(range: Mark, extend: boolean): void;
  onLineKey(line: RenderLine, key: LineKey): void;
}

/** The age of an open report as a short phrase ("3 d", "5 h"). */
function age(seconds: number): string {
  const elapsed = Math.max(0, Date.now() / 1000 - seconds);
  if (elapsed < 3600) return `${Math.max(1, Math.round(elapsed / 60))} min`;
  if (elapsed < 86400) return `${Math.round(elapsed / 3600)} h`;
  return `${Math.round(elapsed / 86400)} d`;
}

/** The display offset a DOM point stands for, or undefined outside the text. */
function offsetOf(node: Node, offset: number): number | undefined {
  if (node.nodeType === Node.TEXT_NODE) {
    const piece = node.parentElement?.closest<HTMLElement>('[data-o]');
    return piece ? Number(piece.dataset.o) + offset : undefined;
  }
  const element = node as Element;
  const pieces = (from: Element) => [...from.querySelectorAll<HTMLElement>('[data-o]')];
  const child = element.childNodes[offset];
  if (child) {
    const first =
      child instanceof HTMLElement && child.dataset.o !== undefined
        ? child
        : child instanceof Element
          ? pieces(child)[0]
          : undefined;
    if (first) return Number(first.dataset.o);
  }
  const before = [...element.childNodes].slice(0, offset).reverse();
  for (const previous of before) {
    const last = previous instanceof Element ? pieces(previous).at(-1) : undefined;
    if (last) return Number(last.dataset.o) + (last.textContent?.length ?? 0);
  }
  const line = element.closest<HTMLElement>('[data-line]');
  return line ? Number(line.dataset.start) : undefined;
}

function caretAt(x: number, y: number): { node: Node; offset: number } | undefined {
  const doc = document as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : undefined;
}

/**
 * The tooltip as consumers see it (consumer width, the preview's own styles), with every display
 * line focusable. Marks are `<mark>` + `text-decoration`, numbers are absolutely placed badges, so
 * marking never changes a line box. Pointer: click or tap a line to mark it, tap a word in a
 * marked line to narrow, drag (or extend the native selection) to mark any text. Keyboard: Tab or
 * ↑↓ between lines, Enter marks, Shift+←/→ narrows to a word.
 */
export const AnnotatedTooltip = memo(function AnnotatedTooltip({
  render,
  notes,
  existing,
  onTap,
  onSelect,
  onLineKey,
}: Props) {
  const box = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onSelect, onTap });
  handlers.current = { onSelect, onTap };
  /** The last pointer kind; a mouse drag is applied on release, touch handles as they settle. */
  const pointer = useRef<string>('mouse');
  /** The click that ends a drag selection is not also a tap. */
  const dragged = useRef(false);

  const selected = (): Mark | undefined => {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount || !box.current) return;
    const range = selection.getRangeAt(0);
    if (!box.current.contains(range.commonAncestorContainer)) return;
    const start = offsetOf(range.startContainer, range.startOffset);
    const end = offsetOf(range.endContainer, range.endOffset);
    return start !== undefined && end !== undefined && end > start ? { start, end } : undefined;
  };

  // Touch selection handles: follow the native selection while it settles.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const follow = () => {
      clearTimeout(timer);
      if (pointer.current === 'mouse') return;
      timer = setTimeout(() => {
        const range = selected();
        if (range) handlers.current.onSelect(range, true);
      }, 350);
    };
    document.addEventListener('selectionchange', follow);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', follow);
    };
  }, []);

  const pointerUp = (event: React.PointerEvent) => {
    pointer.current = event.pointerType;
    if (event.pointerType !== 'mouse') return;
    const range = selected();
    if (!range) return;
    dragged.current = true;
    handlers.current.onSelect(range, false);
    getSelection()?.removeAllRanges();
  };

  const click = (event: React.MouseEvent) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    if (getSelection()?.isCollapsed === false) return;
    const line = (event.target as Element).closest<HTMLElement>('[data-line]');
    if (!line) return;
    const target = render.lines[Number(line.dataset.line)];
    const caret = caretAt(event.clientX, event.clientY);
    const at = caret ? offsetOf(caret.node, caret.offset) : undefined;
    handlers.current.onTap(
      target,
      at !== undefined && at >= target.start && at <= target.end ? at : target.start,
    );
  };

  const key = (event: KeyboardEvent<HTMLElement>, line: RenderLine) => {
    const all = [...(box.current?.querySelectorAll<HTMLElement>('[data-line]') ?? [])];
    const index = all.indexOf(event.currentTarget);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      all[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onLineKey(line, 'mark');
    } else if (event.shiftKey && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      event.preventDefault();
      onLineKey(line, event.key === 'ArrowRight' ? 'next' : 'prev');
    }
  };

  const numbered = notes.map((note, index) => ({ note, n: index + 1 }));
  const marks = numbered.filter((entry) => entry.note.mark);
  const current = existing.filter(
    (anchor) =>
      anchor.rev === render.rev &&
      anchor.start !== null &&
      anchor.end !== null &&
      anchor.end > anchor.start,
  );

  const piecesOf = (part: Extract<RenderPart, { kind: 'text' }>) => {
    const cuts = new Set([part.start, part.end]);
    for (const { note } of marks) cuts.add(note.mark!.start).add(note.mark!.end);
    for (const anchor of current) cuts.add(anchor.start!).add(anchor.end!);
    const points = [...cuts].filter((c) => c >= part.start && c <= part.end).sort((a, b) => a - b);
    const out: ReactNode[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const [from, to] = [points[i], points[i + 1]];
      const text = part.text.slice(from - part.start, to - part.start);
      const mark = marks.find(({ note }) => note.mark!.start <= from && note.mark!.end >= to);
      const open = current.filter((anchor) => anchor.start! <= from && anchor.end! >= to);
      const title = open.length
        ? open
            .map(
              (anchor) =>
                `Open report: ${categoryLabels[anchor.category as ReportCategory] ?? anchor.category}, ${age(anchor.age)} old`,
            )
            .join('\n')
        : undefined;
      let node: ReactNode = (
        <span data-o={from} className={open.length ? styles.existing : undefined} title={title}>
          {text}
        </span>
      );
      if (mark) {
        node = (
          <mark
            className={styles.mark}
            data-note={mark.note.id}
            aria-describedby={`note-${mark.note.id}`}
          >
            {mark.note.mark!.start === from && (
              <span className={styles.badgeAnchor} aria-hidden="true">
                <span className={styles.badge}>{mark.n}</span>
              </span>
            )}
            {node}
          </mark>
        );
      }
      out.push(<span key={from}>{node}</span>);
    }
    return out;
  };

  const parts = (cell: RenderPart[]) =>
    cell.map((part, index) =>
      part.kind === 'icon' ? (
        <span key={index} className={cls(part.classNames)}>
          <span />
        </span>
      ) : (
        <span key={index} className={cls(part.classNames)}>
          {piecesOf(part)}
        </span>
      ),
    );

  const lineMarked = (line: RenderLine) =>
    marks.some(({ note }) => isWholeLine(render.display, line, note.mark));

  const lineProps = (line: RenderLine) => ({
    'data-line': line.index,
    'data-start': line.start,
    'data-marked': lineMarked(line) || undefined,
    tabIndex: 0,
    role: 'button',
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => key(event, line),
  });

  const rows: ReactNode[] = [];
  for (let i = 0; i < render.lines.length; i++) {
    const line = render.lines[i];
    if (!line.table) {
      rows.push(
        <div
          key={i}
          className={[cls(line.classNames), styles.line].filter(Boolean).join(' ')}
          {...lineProps(line)}
        >
          {parts(line.cells[0])}
        </div>,
      );
      continue;
    }
    const table: RenderLine[] = [];
    while (i < render.lines.length && render.lines[i].table) table.push(render.lines[i++]);
    i--;
    rows.push(
      <table key={`t${i}`}>
        <tbody>
          {table.map((row) => (
            <tr
              key={row.index}
              className={[cls(row.classNames), styles.line].filter(Boolean).join(' ')}
              {...lineProps(row)}
            >
              {row.cells.map((cell, index) => (
                <td key={index}>{parts(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>,
    );
  }

  return (
    <div className={`${preview.preview} ${styles.tooltip}`} lang={render.lang}>
      <div
        ref={box}
        className={`${preview.description} ${styles.annotatable}`}
        onPointerDown={(event) => {
          pointer.current = event.pointerType;
          dragged.current = false;
        }}
        onPointerUp={pointerUp}
        onClick={click}
      >
        {rows}
      </div>
    </div>
  );
});
