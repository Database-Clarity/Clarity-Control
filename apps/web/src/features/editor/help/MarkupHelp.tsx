import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { EditorView } from '@codemirror/view';
import { parseMarkup, type MarkupGlobals, type ParsedMarkup } from '@clarity/core';
import { Lines } from '../../preview/TooltipPreview';
import previewStyles from '../../preview/TooltipPreview.module.scss';
import { phoneQuery, useMedia } from '../../../ui/useMedia';
import { EntryGlyph } from '../markupRow/EntryGlyph';
import { entryMessage } from '../markupRow/entries';
import {
  groupHints,
  helpBlocks,
  helpColumns,
  helpEnhancedGlobals,
  helpGlobals,
  helpIdAt,
  helpRows,
  phoneGroups,
  retiredAnswer,
  type HelpRow,
} from './reference';
import styles from './MarkupHelp.module.scss';

// The examples are static text: each is parsed once per page, on the first open.
const parsed = new Map<string, ParsedMarkup['lines']>();
function linesOf(text: string, enhanced: boolean) {
  const key = `${enhanced ? 'E' : 'B'}${text}`;
  let lines = parsed.get(key);
  if (!lines) {
    lines = parseMarkup(text, enhanced ? helpEnhancedGlobals : helpGlobals).lines;
    parsed.set(key, lines);
  }
  return lines;
}

/**
 * Builds the rows and parses every example ahead of the first open, in idle time, a few at a time
 * while the idle period lasts. Returns true once everything is parsed.
 */
export function warmHelp(deadline?: { timeRemaining(): number }): boolean {
  const texts: [string, boolean][] = [];
  for (const row of helpRows())
    if (row.example && !row.plain && !row.note && !isKey(row)) texts.push([row.example, false]);
  for (const block of Object.values(helpBlocks)) {
    const text = block.lines.map((line) => line.text).join('\n');
    texts.push([text, false]);
    if (block.enhanced) texts.push([text, true]);
  }
  for (const [text, enhanced] of texts) {
    if (parsed.has(`${enhanced ? 'E' : 'B'}${text}`)) continue;
    if (deadline && deadline.timeRemaining() < 2) return false;
    linesOf(text, enhanced);
  }
  return true;
}

function Render({ text, enhanced = false }: { text: string; enhanced?: boolean }) {
  const lines = linesOf(text, enhanced);
  if (lines.every((line) => !line.linesContent?.length)) return null;
  return (
    <div className={`${previewStyles.snippet} ${styles.snippet}`} lang="en">
      <Lines lines={lines} />
    </div>
  );
}

function Keys({ keys }: { keys: string }) {
  return (
    <span className={styles.keys}>
      {keys.split(/( \/ |, then )/).map((part, index) =>
        part === ' / ' ? (
          <span key={index}> </span>
        ) : part === ', then ' ? (
          <span key={index}> then </span>
        ) : (
          <kbd key={index}>{part}</kbd>
        ),
      )}
    </span>
  );
}

const frameOf = (editor: EditorView | null) =>
  editor?.dom.closest<HTMLElement>('[data-view]') ?? null;
const isKey = (row: HelpRow) => row.keys !== undefined;
const isCell = (row: HelpRow) => row.id.startsWith('icon:');
const optionId = (id: string) => `markup-help-${id.replace(/[^a-zA-Z0-9-]/g, '-')}`;

/**
 * The markup help: a reference sheet of what you write beside what it draws, with the keys. On a
 * desktop it opens upward from the status bar over the lower text and the pane beside it; on a
 * phone it is a bottom sheet. The editor builds it hidden ahead of the first open, in idle time,
 * and keeps it: closed, it is skipped by layout and paint (content-visibility), inert, and
 * hidden from assistive technology, and listens to nothing.
 */
export const MarkupHelp = memo(function MarkupHelp({
  open,
  view,
  globals,
  readOnly,
  start,
  onClose,
}: {
  open: boolean;
  view: RefObject<EditorView | null>;
  /** Read by Insert only, so a change while typing never re-renders the hidden sheet. */
  globals: { readonly current: MarkupGlobals };
  readOnly: boolean;
  /** The row to open on (F1 over the Ctrl+Space menu); else the markup under the caret. */
  start: string | null;
  onClose(): void;
}) {
  const phone = useMedia(phoneQuery);
  const root = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const rows = helpRows();
  // The frame the desktop sheet spans: the editor and the pane beside it (never the preview).
  const [frame, setFrame] = useState<HTMLElement | null>(() => frameOf(view.current));
  const [active, setActive] = useState(rows[0]!.id);

  // A phone has no keys to press: its sheet lists markup only, in one column.
  const columns = useMemo(() => (phone ? [phoneGroups] : helpColumns), [phone]);
  const listed = useMemo(
    () => columns.flat().flatMap((name) => rows.filter((row) => row.group === name)),
    [columns, rows],
  );
  const retired = useMemo(() => retiredAnswer(query), [query]);
  const matching = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return listed.filter(
      (row) =>
        row.id === retired?.instead || terms.every((term) => row.words.includes(term)),
    );
  }, [query, listed, retired]);
  const match = useMemo(() => new Set(matching.map((row) => row.id)), [matching]);
  // On a desktop every row keeps its place and the others dim; a phone's one column drops them.
  const drawn = phone ? matching : listed;
  const current = matching.find((row) => row.id === active) ?? matching[0];
  const entry = readOnly ? undefined : current?.entry;
  const filtering = query.trim() !== '';
  const filterLabel = phone ? 'Filter markup' : 'Filter markup and keys';
  const status = message
    ? message
    : retired
      ? retired.message
      : !filtering
        ? ''
        : matching.length
          ? `${matching.length} of ${listed.length}`
          : `No markup or key matches “${query.trim()}”.`;

  const close = useRef(() => undefined as void);
  close.current = () => {
    onClose();
    if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
  };
  useEffect(() => {
    const element = root.current;
    if (!element || !open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'F1') return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
    };
    element.addEventListener('keydown', onKey);
    // A phone: a tap outside the sheet closes it (the status bar's Help toggles it itself).
    const outside = (event: PointerEvent) => {
      if (!phone || !(event.target instanceof Node) || element.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest('[data-status-help]')) return;
      event.preventDefault();
      close.current();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      element.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', outside, true);
    };
    // Again when the window crosses the phone width while open: tap-outside is a phone's alone.
  }, [open, phone]);

  // Keeps the active row inside the list by moving the list's own scroll (never the page's).
  const reveal = (id: string) => {
    const scroller = list.current;
    const row = scroller?.querySelector<HTMLElement>(`[data-help-row="${id}"]`);
    if (!scroller || !row || scroller.scrollHeight <= scroller.clientHeight) return;
    const head = phone
      ? (scroller.querySelector<HTMLElement>('[data-help-group]')?.offsetHeight ?? 0)
      : 0;
    const top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    if (top < head) scroller.scrollTop += top - head;
    else if (top + row.offsetHeight > scroller.clientHeight)
      scroller.scrollTop += top + row.offsetHeight - scroller.clientHeight;
  };

  // Where the sheet goes, read while the page's layout is still clean (in the render that opens
  // it, and in the idle render that builds it), so opening forces no layout. The desktop sheet
  // sits on the status bar's top edge, as wide as the editor and its pane, and leaves at least
  // four lines of text above it. A phone's sheet starts on the tool row's lower edge, so it
  // covers the text and nothing else.
  const measure = (frame: HTMLElement | null): Record<string, string> => {
    const editor = view.current;
    if (!editor) return {};
    if (phone) {
      const tools = (frame ?? document).querySelector<HTMLElement>('[aria-label="Editor tools"]');
      const below = tools?.getBoundingClientRect().bottom ?? 0;
      // The sticky bars above it (the app's header, then the tooltip's panel tabs): the sheet
      // never covers any of them.
      const header = Math.max(
        0,
        ...['header', '[aria-label="Tooltip panels"]'].map(
          (selector) => document.querySelector(selector)?.getBoundingClientRect().bottom ?? 0,
        ),
      );
      const height = window.innerHeight;
      // On the tool row's lower edge while it is on screen and leaves the sheet a useful height;
      // else the default height (85% of the screen, at most 44rem), but never above the header.
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const top =
        below > header && height - below >= height * 0.5
          ? below
          : Math.max(header, height - Math.min(height * 0.85, 44 * rem));
      return { '--help-top': `${Math.round(top)}px`, '--help-height': 'auto' };
    }
    if (!frame) return {};
    const scroller = editor.scrollDOM.getBoundingClientRect();
    const box = frame.getBoundingClientRect();
    return {
      '--help-bottom': `${Math.max(0, box.bottom - scroller.bottom)}px`,
      '--help-room': `${scroller.height}px`,
    };
  };
  const [place, setPlace] = useState(() => measure(frame));

  // Opening starts fresh: no filter, on the markup under the caret (or the menu's option), placed
  // where the editor is now.
  const [shown, setShown] = useState(false);
  if (open !== shown) {
    setShown(open);
    if (open) {
      const editor = view.current;
      const at = editor ? helpIdAt(editor.state, editor.state.selection.main.head) : null;
      const wanted = start ?? at;
      setActive(rows.find((row) => row.id === wanted)?.id ?? rows[0]!.id);
      setQuery('');
      setMessage('');
      const now = frameOf(editor);
      if (now !== frame) setFrame(now);
      const next = measure(now);
      if (Object.entries(next).some(([key, value]) => place[key] !== value)) setPlace(next);
    }
  }

  // After each layout of the sheet (a ResizeObserver runs after the browser's own layout, so its
  // reads cost nothing): the text gets room below its end as tall as the sheet (the Changes
  // view's rule), and on opening, a caret line the sheet would cover scrolls to just above it.
  useLayoutEffect(() => {
    const editor = view.current;
    const panel = root.current;
    if (!panel || !open) return;
    // Where focus was (the text, or the button that opened it): closing gives it back.
    const focused = panel.ownerDocument.activeElement;
    // On a phone always, and on a desktop opened with a pointer (Help takes no focus), Help gets
    // it back: a phone's text would raise the on-screen keyboard after a tap on ×.
    const help =
      (frame ?? panel.ownerDocument).querySelector<HTMLElement>('[data-status-help]') ??
      panel.ownerDocument.querySelector<HTMLElement>('[data-status-help]');
    // Run again while open (the window crossed the phone width), focus is already inside: the
    // opener stays.
    if (!(focused instanceof Node && panel.contains(focused)))
      opener.current =
        !phone && focused instanceof HTMLElement && focused !== panel.ownerDocument.body
          ? focused
          : help;
    if (!editor) return;
    const host = panel.parentElement!;
    const area = phone ? null : (editor.dom.parentElement?.parentElement ?? null);
    let opened = false;
    const fit = () => {
      const first = !opened;
      opened = true;
      if (first) {
        // Focus moves in once the sheet is laid out, so it forces no layout of its own. A phone
        // gets no on-screen keyboard from opening the help: the sheet takes it, not the field.
        (phone ? panel : field.current)?.focus({ preventScroll: true });
        reveal(active);
      }
      if (phone) {
        // The bars above it can move (a resize, the page scrolling under it): it stays under them.
        for (const [name, value] of Object.entries(measure(frame)))
          panel.style.setProperty(name, value);
        return;
      }
      const scroller = editor.scrollDOM.getBoundingClientRect();
      const box = host.getBoundingClientRect();
      const sheet = panel.getBoundingClientRect();
      const head = editor.state.selection.main.head;
      const caret = first ? editor.coordsAtPos(head) : null;
      panel.style.setProperty('--help-bottom', `${Math.max(0, box.bottom - scroller.bottom)}px`);
      panel.style.setProperty('--help-room', `${scroller.height}px`);
      area?.style.setProperty('--overlay-room', `${sheet.height}px`);
      editor.requestMeasure();
      if (caret && caret.bottom > sheet.top - 4)
        editor.dispatch({
          effects: EditorView.scrollIntoView(head, { y: 'end', yMargin: sheet.height + 8 }),
        });
    };
    if (typeof ResizeObserver === 'undefined') {
      fit();
      return;
    }
    const observer = new ResizeObserver(fit);
    observer.observe(panel);
    if (!phone) {
      observer.observe(host);
      observer.observe(editor.scrollDOM);
    }
    return () => {
      observer.disconnect();
      area?.style.removeProperty('--overlay-room');
      editor.requestMeasure();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, open]);

  // Hidden, it is laid out once (the first frame after it is built), then skipped until it opens.
  useLayoutEffect(() => {
    const panel = root.current;
    if (!panel || open || panel.hasAttribute('data-laid')) return;
    if (typeof ResizeObserver === 'undefined') {
      panel.setAttribute('data-laid', '');
      return;
    }
    const observer = new ResizeObserver(() => {
      observer.disconnect();
      panel.setAttribute('data-laid', '');
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open]);

  const insert = () => {
    const editor = view.current;
    if (!editor || !entry) return;
    const result = entry.run(editor, globals.current);
    if (result !== 'inserted') {
      setMessage(entryMessage(result));
      return;
    }
    onClose();
    editor.focus();
  };
  const move = (next: HelpRow | undefined) => {
    if (!next) return;
    setActive(next.id);
    setMessage('');
    requestAnimationFrame(() => reveal(next.id));
  };
  const onKeys = (event: ReactKeyboardEvent<HTMLElement>) => {
    const index = current ? matching.indexOf(current) : -1;
    if (event.key === 'ArrowDown') move(matching[Math.min(matching.length - 1, index + 1)]);
    else if (event.key === 'ArrowUp') move(matching[Math.max(0, index - 1)]);
    else if (event.key === 'PageDown')
      move(
        matching.find((row, at) => at > index && row.group !== current?.group) ?? matching.at(-1),
      );
    else if (event.key === 'PageUp') {
      const first = matching.findIndex((row) => row.group === current?.group);
      const before = first > 0 ? matching[first - 1]!.group : current?.group;
      move(matching.find((row) => row.group === (index > first ? current?.group : before)));
    } else if (event.key === 'Enter' && event.target === field.current) insert();
    else return;
    event.preventDefault();
  };

  const select = (item: HelpRow) => {
    if (!match.has(item.id) || item.id === current?.id) return;
    setActive(item.id);
    setMessage('');
  };
  const pick = (item: HelpRow) => ({
    // Selection follows the pointer only when it really moves (never on a scroll under it).
    onMouseMove: () => select(item),
    onClick: () => select(item),
  });
  const option = (item: HelpRow) => ({
    id: optionId(item.id),
    role: 'option' as const,
    'aria-selected': item.id === current?.id,
    'aria-label': item.label,
    'data-help-row': item.id,
    'data-dim': match.has(item.id) ? undefined : '',
    ...pick(item),
  });

  const row = (item: HelpRow) => {
    if (isCell(item))
      return (
        <div key={item.id} {...option(item)} className={styles.cell}>
          <EntryGlyph glyph={{ kind: 'icon', name: item.id.slice(5) }} />
          <span>{item.id.slice(5)}</span>
        </div>
      );
    if (isKey(item))
      return (
        <div key={item.id} {...option(item)} className={`${styles.row} ${styles.keyRow}`}>
          <Keys keys={item.keys!} />
          <span>{item.label}</span>
        </div>
      );
    return (
      <div key={item.id} {...option(item)} className={styles.row}>
        {item.plain ? (
          <span className={styles.plain}>{item.example}</span>
        ) : (
          <pre className={styles.syntax}>{item.example}</pre>
        )}
        <div className={styles.out}>
          {!item.plain && !item.note && item.example && <Render text={item.example} />}
          {item.note && <span className={styles.note}>{item.note}</span>}
        </div>
      </div>
    );
  };

  // A worked example: its lines belong to two or three rows, and it is drawn once as a whole.
  const block = (name: string, items: HelpRow[]) => {
    const example = helpBlocks[name]!;
    const text = example.lines.map((line) => line.text).join('\n');
    const seen = new Set<string>();
    return (
      <div key={name} className={`${styles.row} ${styles.block}`}>
        <div className={styles.source}>
          {example.lines.map((line, index) => {
            const item = items.find((candidate) => candidate.id === line.row);
            if (!item) return null;
            const first = !seen.has(line.row);
            seen.add(line.row);
            return (
              <pre
                key={index}
                className={styles.syntax}
                data-on={item.id === current?.id ? '' : undefined}
                {...(first
                  ? option(item)
                  : { 'data-dim': match.has(item.id) ? undefined : '', ...pick(item) })}
              >
                {line.text}
              </pre>
            );
          })}
        </div>
        <div
          className={styles.out}
          data-dim={items.some((item) => match.has(item.id)) ? undefined : ''}
        >
          {example.enhanced ? (
            <>
              <span className={styles.tag}>Base</span>
              <Render text={text} />
              <span className={styles.tag}>Enhanced</span>
              <Render text={text} enhanced />
            </>
          ) : (
            <Render text={text} />
          )}
          {example.note && <span className={styles.note}>{example.note}</span>}
        </div>
      </div>
    );
  };

  const group = (name: string) => {
    const items = drawn.filter((item) => item.group === name);
    if (!items.length) return null;
    const cells = items.filter(isCell);
    const parts: ReactNode[] = [];
    const done = new Set<string>();
    for (const item of items) {
      if (isCell(item)) continue;
      if (!item.block) parts.push(row(item));
      else if (!done.has(item.block)) {
        done.add(item.block);
        parts.push(
          block(
            item.block,
            items.filter((other) => other.block === item.block),
          ),
        );
      }
    }
    return (
      <div
        key={name}
        role="group"
        aria-label={name}
        className={items.some(isKey) ? styles.keyGroup : undefined}
        data-help-section
      >
        <div className={styles.groupTitle} data-help-group>
          <span>{name}</span>
          {groupHints[name] && <code>{groupHints[name]}</code>}
        </div>
        {parts}
        {cells.length > 0 && <div className={styles.cells}>{cells.map(row)}</div>}
      </div>
    );
  };

  const about = current && (
    <p className={styles.about} data-about>
      <b>{current.label}</b> <span>{current.about}</span>
    </p>
  );
  const insertButton = entry && (
    <button
      type="button"
      className={styles.insert}
      // The caret stays in the field or the editor: the press must not take focus.
      onMouseDown={(event) => event.preventDefault()}
      onClick={insert}
    >
      Insert<kbd>Enter</kbd>
    </button>
  );
  const sheet = (
    <section
      ref={root}
      id={open ? 'editor-panel-help' : undefined}
      aria-label="Markup help"
      tabIndex={-1}
      className={`${styles.panel} ${phone ? styles.sheet : frame ? styles.wide : ''} ${open ? '' : styles.parked}`}
      style={place as CSSProperties}
      // Closed: hidden and out of reach until F1 or Help reveals it.
      {...(open ? {} : { inert: '', 'aria-hidden': true })}
      data-editor-overlay={open ? '' : undefined}
      data-editor-portal={open && !phone && frame ? '' : undefined}
      data-markup-help={open ? '' : undefined}
      onKeyDown={(event) => {
        if (event.target === root.current) onKeys(event);
      }}
    >
      <div className={styles.head}>
        <input
          ref={field}
          className={styles.filter}
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls="markup-help-list"
          aria-activedescendant={current ? optionId(current.id) : undefined}
          aria-label={filterLabel}
          placeholder={filterLabel}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setMessage('');
            // A retired name makes what replaces it the active row.
            const instead = retiredAnswer(event.target.value)?.instead;
            if (instead) setActive(instead);
            if (phone && list.current) list.current.scrollTop = 0;
          }}
          onKeyDown={onKeys}
        />
        {!phone && (
          <span className={styles.info} data-info>
            <span role="status" data-status data-warn={message ? '' : undefined}>
              {status}
            </span>
            {!message && !retired && current && (
              <span className={styles.inline} data-about-inline>
                <b>{current.label}</b>
                {current.about}
              </span>
            )}
          </span>
        )}
        {!phone && insertButton}
        <button
          type="button"
          className={styles.close}
          aria-label="Close Markup help"
          onClick={() => close.current()}
        >
          ×
        </button>
      </div>
      <div ref={list} id="markup-help-list" role="listbox" className={styles.list} data-help-scroll>
        {phone && status && (
          <p className={styles.statusLine} role="status" data-warn={message ? '' : undefined}>
            {status}
          </p>
        )}
        <div className={styles.cols}>
          {columns.map((names, index) => (
            <div key={index} className={styles.col} data-col={index + 1}>
              {names.map(group)}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.foot}>
        {about}
        {phone && insertButton}
      </div>
    </section>
  );
  return phone ? createPortal(sheet, document.body) : frame ? createPortal(sheet, frame) : sheet;
});

export default MarkupHelp;
