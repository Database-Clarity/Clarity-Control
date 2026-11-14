import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Lang } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { applyPlacement, placeAnchored, visibleArea } from '../../ui/anchorPlacement';
import { When } from '../../ui/When';
import { requestTermMatches } from '../editor/diagnosticWorker';
import { useShowEditor } from '../tooltip/VariantWorkspace';
import type { Term } from './termList';
import { useTermList } from './useTermList';
import { insertAtCaret, translationView } from './insert';
import styles from './TermLayer.module.scss';
import { canEditGlossary, useGlossaryStore } from '../../stores/glossary';
import { useAuthStore } from '../../stores/auth';
import { TermForm } from './TermForm';
import { missingFor, useTermUsage } from './usage';

/** The open term's background: a CSS highlight, registered only while a popover is open. */
const openName = 'clarity-term-open';
const openDelay = 150;
const closeGrace = 200;

const highlightsSupported = () =>
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

/**
 * Draws each mark as a transparent box over its text with a dotted bottom edge, in an overlay
 * beside the content: no character moves, and nothing repaints while the translation is typed (a
 * registered CSS highlight makes Chrome repaint the marked text and the page on every DOM change
 * anywhere, measured at about 1.8 ms per key). Returns how many marks it drew.
 */
function drawMarks(
  host: HTMLElement,
  overlay: HTMLElement,
  marks: Mark[],
  missing: readonly string[],
) {
  const origin = host.getBoundingClientRect();
  const boxes = document.createDocumentFragment();
  for (const mark of marks)
    for (const rect of mark.range.getClientRects()) {
      if (rect.width < 1 || rect.height < 1) continue;
      const box = document.createElement('span');
      box.className = styles.mark!;
      box.dataset.termEn = mark.term.en;
      if (missing.includes(mark.term.en)) box.dataset.missing = '';
      box.style.left = `${rect.left - origin.left}px`;
      box.style.top = `${rect.top - origin.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      boxes.append(box);
    }
  overlay.replaceChildren(boxes);
  host.dataset.termMarks = String(marks.length);
}

/** One insertable span in the English: what it offers and where it is (a DOM Range). */
export interface Mark {
  term: Term;
  range: Range;
}

/**
 * A second source of marks that knows its spans from the rendering itself (number tokens: the
 * spans parseMarkup tags with data-slot): it returns a Range per span (Range.selectNodeContents
 * on the element) with what Insert puts in. Its marks share the drawing, hit-testing, popover,
 * click-to-insert (Term.insertOnClick), and the clearing on every rendering change.
 */
export type SpanSource = (root: HTMLElement) => Mark[];

/** The rendered text under `root` as one string, and where each text node starts in it. */
function readText(root: HTMLElement) {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  let block: Element | null = null;
  let parent: Element | null = null;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    // A title's body (role="tooltip") is not on screen until its own popover opens.
    acceptNode: (node) =>
      node.parentElement?.closest('[role="tooltip"]')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const owner = node.parentElement?.closest('div, p, li, td, th') ?? null;
    // Separate lines and cells never join into one word.
    if (block !== null && (owner !== block || node.parentElement !== parent)) text += '\n';
    block = owner;
    parent = node.parentElement;
    nodes.push(node as Text);
    starts.push(text.length);
    text += (node as Text).data;
  }
  return { nodes, starts, text };
}

/** The node and offset holding position `at` of readText's string. */
function locate(nodes: Text[], starts: number[], at: number, end: boolean) {
  let low = 0;
  let high = nodes.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! < at || (!end && starts[mid] === at)) low = mid;
    else high = mid - 1;
  }
  return { node: nodes[low]!, offset: at - starts[low]! };
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };
  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

const within = (range: Range, x: number, y: number) =>
  [...range.getClientRects()].some(
    (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
  );

/**
 * Term marks over rendered English (TR2 official names; the glossary adds a source to the same
 * list): a dotted underline drawn in an overlay over the existing text (drawMarks), so the
 * rendering is untouched and no character moves. Hover (or tap) shows the term's in-game names in the
 * translator's language, each with Insert where the translation can be edited.
 * Nothing runs while stepping through tooltips; marks arrive once the step settles.
 */
export function TermLayer({
  lang,
  hash,
  enabled,
  canInsert,
  stepping = false,
  spanSource,
  children,
}: {
  lang: Lang;
  /** The tooltip whose translation Insert writes into. */
  hash: number;
  /** Load and show official names (an assigned language); off, nothing is fetched or drawn. */
  enabled: boolean;
  canInsert: boolean;
  stepping?: boolean;
  /** Marks found from the rendered spans (number tokens, later); text terms are matched. */
  spanSource?: SpanSource;
  children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const hashRef = useRef(hash);
  hashRef.current = hash;
  const canInsertRef = useRef(canInsert);
  canInsertRef.current = canInsert;
  const list = useTermList(lang, enabled);
  const missing = useTermUsage((state) => missingFor(state.documents, hash, lang));
  const missingRef = useRef(missing);
  missingRef.current = missing;
  useLayoutEffect(() => {
    for (const box of overlay.current?.children ?? []) {
      const element = box as HTMLElement;
      if (missing.includes(element.dataset.termEn ?? '')) element.dataset.missing = '';
      else delete element.dataset.missing;
    }
  }, [missing]);
  useAuthStore((state) => state.user);
  const spanSourceRef = useRef(spanSource);
  spanSourceRef.current = spanSource;
  const hasSpans = spanSource !== undefined;
  const marks = useRef<Mark[]>([]);
  const [open, setOpen] = useState<{ mark: Mark; pinned: boolean } | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const clearMarks = useCallback(() => {
    marks.current = [];
    overlay.current?.replaceChildren();
    if (host.current) delete host.current.dataset.termMarks;
  }, []);

  // Marks: requested once the text has settled, rebuilt when the rendering changes.
  useLayoutEffect(() => {
    const frameHost = host.current;
    const root = content.current;
    const layer = overlay.current;
    if (!frameHost || !root || !layer || (!list && !hasSpans) || stepping) return;
    // Each build (and each rendering change, and the cleanup) starts a new generation; a match
    // reply from an older one is dropped: React may have rewritten the same Text nodes in place,
    // so its offsets could point past the text or at another word (code review 2026-11-14).
    let generation = 0;
    let frame = 0;
    let redraw = 0;
    const draw = () => drawMarks(frameHost, layer, marks.current, missingRef.current);
    const build = () => {
      const mine = ++generation;
      frame = 0;
      clearMarks();
      if (openRef.current) setOpen(null);
      marks.current = spanSourceRef.current?.(root) ?? [];
      if (marks.current.length) draw();
      const { nodes, starts, text } = readText(root);
      if (!list || !nodes.length) return;
      void requestTermMatches(list, text).then((matches) => {
        if (mine !== generation || !nodes.every((node) => node.isConnected)) return;
        const found = matches.map((match) => {
          const start = locate(nodes, starts, match.from, false);
          const end = locate(nodes, starts, match.to, true);
          const range = document.createRange();
          range.setStart(start.node, start.offset);
          range.setEnd(end.node, end.offset);
          return { term: list.terms[match.entry]!, range };
        });
        marks.current = [...marks.current, ...found];
        draw();
      });
    };
    build();
    // Rewrapped text (a narrower pane, a font that loaded late) moves the marks with it.
    const resize =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            if (!redraw && marks.current.length)
              redraw = requestAnimationFrame(() => {
                redraw = 0;
                draw();
              });
          });
    resize?.observe(frameHost);
    const observer = new MutationObserver(() => {
      // Stale ranges go before the next paint; new ones follow once the rendering settles.
      generation++;
      clearMarks();
      if (!frame) frame = requestAnimationFrame(build);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      generation++;
      observer.disconnect();
      resize?.disconnect();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(redraw);
      clearMarks();
    };
  }, [list, hasSpans, stepping, clearMarks]);

  // The open term's background, registered only while open (see drawMarks on why).
  useLayoutEffect(() => {
    if (!open || !highlightsSupported()) return;
    CSS.highlights.set(openName, new Highlight(open.mark.range));
    return () => void CSS.highlights.delete(openName);
  }, [open]);

  // Hover: one hit test per frame while the pointer moves over the English.
  const timers = useRef<{
    open?: ReturnType<typeof setTimeout>;
    close?: ReturnType<typeof setTimeout>;
  }>({});
  const hovered = useRef<Mark | null>(null);
  const markAt = useCallback((x: number, y: number): Mark | null => {
    const root = host.current;
    if (!root || !marks.current.length) return null;
    const caret = caretAt(x, y);
    if (!caret || !root.contains(caret.node)) return null;
    for (const mark of marks.current)
      if (mark.range.isPointInRange(caret.node, caret.offset) && within(mark.range, x, y))
        return mark;
    return null;
  }, []);
  const cancelClose = () => clearTimeout(timers.current.close);
  const scheduleClose = useCallback(() => {
    clearTimeout(timers.current.close);
    if (openRef.current?.pinned) return;
    timers.current.close = setTimeout(() => setOpen(null), closeGrace);
  }, []);
  useEffect(() => {
    const root = host.current;
    if (!root || (!list && !hasSpans)) return;
    let frame = 0;
    let point = { x: 0, y: 0 };
    const test = () => {
      frame = 0;
      const mark = markAt(point.x, point.y);
      if (mark === hovered.current) return;
      hovered.current = mark;
      clearTimeout(timers.current.open);
      if (mark) {
        cancelClose();
        if (openRef.current?.pinned && openRef.current.mark !== mark) return;
        timers.current.open = setTimeout(() => setOpen({ mark, pinned: false }), openDelay);
      } else scheduleClose();
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      point = { x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(test);
    };
    const leave = (event: PointerEvent) => {
      hovered.current = null;
      clearTimeout(timers.current.open);
      // Into the popover (portaled outside the pane): it stays open; leaving it closes it.
      const into = event.relatedTarget;
      if (into instanceof Element && into.closest('[data-term-popover]')) return;
      scheduleClose();
    };
    // A click (or a tap) on a term pins it open.
    const click = (event: MouseEvent) => {
      const mark = markAt(event.clientX, event.clientY);
      if (!mark) return;
      clearTimeout(timers.current.open);
      cancelClose();
      // A source with one exact insert (number tokens, later) inserts on the click itself.
      const [only] = mark.term.official;
      if (mark.term.insertOnClick && canInsertRef.current && mark.term.official.length === 1)
        insertRef.current(only!);
      else setOpen({ mark, pinned: true });
    };
    root.addEventListener('pointermove', move, { passive: true });
    root.addEventListener('pointerleave', leave);
    root.addEventListener('click', click);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerleave', leave);
      root.removeEventListener('click', click);
    };
  }, [list, hasSpans, markAt, scheduleClose]);
  useEffect(
    () => () => {
      clearTimeout(timers.current.open);
      clearTimeout(timers.current.close);
    },
    [],
  );

  const showEditor = useShowEditor();
  const insertRef = useRef((text: string) => {
    setOpen(null);
    const view = translationView(hashRef.current);
    if (view && insertAtCaret(view, text)) showEditor();
  });
  const insert = (text: string) => insertRef.current(text);

  return (
    <div
      ref={host}
      className={styles.layer}
      onPointerUp={() => {
        if (!enabled || !canEditGlossary(lang)) return;
        const selection = window.getSelection();
        if (!selection?.rangeCount || selection.isCollapsed) return;
        const range = selection.getRangeAt(0);
        const en = selection.toString().trim();
        if (!content.current?.contains(range.commonAncestorContainer) || !en || en.length > 60)
          return;
        setOpen({
          mark: { range: range.cloneRange(), term: { en, kind: 'name', official: [] } },
          pinned: true,
        });
      }}
    >
      <div ref={content} className={styles.content}>
        {children}
      </div>
      <div ref={overlay} className={styles.marks} aria-hidden="true" />
      {open && (
        <TermPopover
          term={open.mark.term}
          missing={missing.includes(open.mark.term.en)}
          anchor={open.mark.range}
          lang={lang}
          canInsert={canInsert}
          onInsert={insert}
          onClose={() => setOpen(null)}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
        />
      )}
    </div>
  );
}

export function TermPopover({
  term,
  missing = false,
  anchor,
  lang,
  canInsert,
  onInsert,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: {
  term: Term;
  missing?: boolean;
  anchor: Range;
  lang: Lang;
  canInsert: boolean;
  onInsert(name: string): void;
  onClose(): void;
  onPointerEnter?(): void;
  onPointerLeave?(): void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  useAuthStore((state) => state.user);
  const ready = useGlossaryStore(
    (state) => !!state.byLang[lang]?.remote && !state.byLang[lang]?.loading,
  );
  const canEdit = ready && canEditGlossary(lang);
  const kind = term.glossary
    ? 'Agreed term'
    : !term.official.length
      ? 'New term'
      : term.kind === 'keyword'
        ? 'Keyword'
        : 'In game';
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    const place = () => {
      const rects = [...anchor.getClientRects()];
      const rect = rects[0] ?? anchor.getBoundingClientRect();
      if (!anchor.startContainer.isConnected) return close.current();
      const area = visibleArea();
      const placement = placeAnchored({
        trigger: rect,
        area,
        width: element.offsetWidth,
        height: element.scrollHeight,
        align: 'start',
      });
      // Above the term when it fits there, so the popover never hides the next line of English
      // while it is read (visual review 2026-11-14); below otherwise, as placeAnchored chose.
      const aboveBottom = rect.top - 4;
      const fitsAbove = aboveBottom - area.top >= element.scrollHeight;
      applyPlacement(
        element,
        fitsAbove
          ? {
              ...placement,
              side: 'above',
              top: 'auto',
              bottom: area.layoutHeight - aboveBottom,
              maxHeight: aboveBottom - area.top,
            }
          : placement,
      );
    };
    place();
    let frame = 0;
    const schedule = (event: Event) => {
      if (event.target instanceof Node && element.contains(event.target)) return;
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), place()));
    };
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [anchor, editing]);
  // Esc, or a press anywhere else, closes it.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close.current();
    };
    const press = (event: PointerEvent) => {
      if (event.target instanceof Node && surface.current?.contains(event.target)) return;
      // A press on a term reopens it (the click handler); anywhere else closes.
      const rects = [...anchor.getClientRects()];
      if (
        rects.some(
          (r) =>
            event.clientX >= r.left &&
            event.clientX <= r.right &&
            event.clientY >= r.top &&
            event.clientY <= r.bottom,
        )
      )
        return;
      close.current();
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', press, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', press, true);
    };
  }, [anchor]);
  return createPortal(
    <div
      ref={surface}
      className={styles.popover}
      role="dialog"
      aria-label={`${term.en}: ${kind.toLowerCase()}`}
      data-term-popover
      onPointerEnter={onPointerEnter}
      onPointerLeave={editing ? undefined : onPointerLeave}
    >
      <div className={styles.head}>
        <span className={styles.kind}>{kind}</span>
        <span className={styles.english} lang="en">
          {term.en}
        </span>
        <span className={styles.language}>{languageLabel(lang)}</span>
      </div>
      {editing && canEdit ? (
        <TermForm lang={lang} entry={term.glossary} english={term.en} onClose={onClose} />
      ) : (
        <>
          {term.official.map((name) => (
            <div key={name} className={styles.row}>
              <strong className={styles.name}>{name}</strong>
              {canInsert && (
                <button
                  type="button"
                  className={styles.insert}
                  title="Insert at the caret in the translation"
                  // The editor's selection is what Insert replaces: pressing must not move focus first.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onInsert(name)}
                >
                  Insert
                </button>
              )}
            </div>
          ))}
          {term.inGame
            ?.filter((name) => name !== term.glossary?.term)
            .map((name) => (
              <div className={styles.row} key={name}>
                <span className={styles.name}>In game: {name}</span>
                {canInsert && (
                  <button
                    type="button"
                    className={styles.insert}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onInsert(name)}
                  >
                    Insert
                  </button>
                )}
              </div>
            ))}
          {term.glossary?.note && <p>{term.glossary.note}</p>}
          {missing && <p className={styles.warning}>Not in this translation yet.</p>}
          {(term.glossary || canEdit) && (
            <div className={styles.footer}>
              {term.glossary && (
                <small>
                  {term.glossary.updatedBy} ·{' '}
                  <When value={term.glossary.updatedAt} />
                </small>
              )}
              {canEdit && (
                <button type="button" className={styles.edit} onClick={() => setEditing(true)}>
                  {term.glossary ? 'Edit' : term.official.length ? 'Add entry' : 'Add term'}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}
