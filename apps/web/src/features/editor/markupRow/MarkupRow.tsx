import { offersBaseEnhanced } from '../markupScope';
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import type { EditorView } from '@codemirror/view';
import type { MarkupGlobals } from '@clarity/core';
import { EntryGlyph } from './EntryGlyph';
import { AllPopover } from './AllPopover';
import {
  entryMessage,
  leadEntries,
  markupEntries,
  rowEntries,
  rowSeparator,
  type MarkupEntry,
} from './entries';
import { observeDock } from './dock';
import {
  elementLabel,
  isElementName,
  tagRefusals,
  type TagSelection,
  type TagSelectionStore,
} from '../elementTags';
import { useKeyboardFollow, useKeyboardInset } from '../../../ui/useKeyboardInset';
import type { UsageCorpus } from '../suggest/usage';
import styles from './MarkupRow.module.scss';

const noSubscription = () => () => {};
const untagged: TagSelection = { kind: 'none' };
const noTagSelection = () => untagged;
const isElementIcon = (entry: MarkupEntry) =>
  entry.id.startsWith('icon:') && isElementName(entry.id.slice('icon:'.length));

/** Buttons with a number key: the first nine on the row. */
const numbered = 9;

/**
 * The markup row: a 30px strip at the top of the editor (44px on touch) with the options an
 * author reaches for most, and "All" pinned at its end for every other one. The buttons never take
 * focus from the text, so the selection they act on stays put; keyboard users move along the row
 * with the arrow keys, insert with Enter or a number, and land back in the text. "Raw", beside
 * "All", flips the whole text between symbols and raw markup (the Ctrl+Shift+. toggle).
 *
 * Docked (a phone), the same row is a bar fixed to the bottom of the visible page, on the keyboard:
 * Suggest sits beside "All", and Raw moves to the status bar. While translating, it leads with the
 * entries the English text uses (`leadEntries`).
 */
export const MarkupRow = memo(function MarkupRow({
  view,
  globals,
  usage,
  rawView,
  onRawView,
  docked = false,
  onSuggest,
  sourceText,
  tagSelection,
}: {
  view: RefObject<EditorView | null>;
  globals: MarkupGlobals;
  usage?: UsageCorpus;
  /** Whether the text shows as raw markup; undefined when this editor draws no symbols. */
  rawView?: boolean;
  onRawView?(): void;
  /** Fixed to the bottom of the visible page, on the keyboard (a phone). */
  docked?: boolean;
  /** Opens the suggestion menu; shown on the docked bar only. */
  onSuggest?(): void;
  /** The English text of this tooltip while translating: the docked bar leads with its entries. */
  sourceText?: string;
  /** Whether the selection can be tagged with an element (the row's "Tag selection:" mode). */
  tagSelection?: TagSelectionStore;
}) {
  const tagMode = useSyncExternalStore(
    tagSelection?.subscribe ?? noSubscription,
    tagSelection?.getSnapshot ?? noTagSelection,
  );
  // The toolbar catalogue depends only on variable definitions. Its insertion actions
  // receive the live globals separately; import snapshot edits must not rebuild every entry.
  const variables = globals.variables;
  const allowBaseEnhanced = offersBaseEnhanced(globals);
  const entries = useMemo(
    () => markupEntries({ variables, titles: '', allowBaseEnhanced }),
    [variables, allowBaseEnhanced],
  );
  const lead = docked ? sourceText : undefined;
  const items = useMemo(() => leadEntries(rowEntries(entries), lead), [entries, lead]);
  const buttons = items.filter((item): item is MarkupEntry => item !== rowSeparator);
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [edges, setEdges] = useState({ start: false, end: false });
  const [message, setMessage] = useState('');
  const bar = useRef<HTMLDivElement>(null);
  useKeyboardInset(docked);
  // The keyboard opening keeps the caret's paragraph (or a focused field, the All filter) in view.
  useKeyboardFollow(docked);
  useEffect(() => {
    const element = bar.current;
    if (!docked || !element) return;
    return observeDock(element);
  }, [docked]);

  function run(entry: MarkupEntry) {
    const editor = view.current;
    if (!editor) return;
    const refusal = tagMode.kind === 'refused' && isElementIcon(entry) ? tagMode.reason : '';
    const result = entry.run(editor, globals);
    // A selection that cannot be tagged: the icon went in at the caret as before; say why.
    setMessage(
      result === 'inserted' && refusal
        ? `Icon inserted at the caret. Can't tag the selection: ${refusal}.`
        : entryMessage(result),
    );
    if (result !== 'inserted') editor.focus();
  }

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 6000);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () =>
      setEdges({
        start: element.scrollLeft > 1,
        end: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
      });
    element.addEventListener('scroll', measure, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    // ResizeObserver supplies the initial dimensions after layout. Measuring here would
    // force a layout halfway through the editor's document switch.
    const frame = observer ? undefined : requestAnimationFrame(measure);
    // The wheel scrolls the row sideways (a vertical wheel has nothing else to do over it).
    const wheel = (event: WheelEvent) => {
      if (element.scrollWidth <= element.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      element.scrollLeft += delta;
      event.preventDefault();
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      element.removeEventListener('scroll', measure);
      element.removeEventListener('wheel', wheel);
      observer?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);

  function focusButton(index: number) {
    const all = scroller.current?.querySelectorAll<HTMLButtonElement>('[data-row-button]');
    const target = all?.[Math.max(0, Math.min(index, (all?.length ?? 1) - 1))];
    if (!target) return;
    target.focus();
    target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  function keyDown(event: React.KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowRight') focusButton(active + 1);
    else if (event.key === 'ArrowLeft') focusButton(active - 1);
    else if (event.key === 'Home') focusButton(0);
    else if (event.key === 'End') focusButton(buttons.length - 1);
    else if (event.key === 'Escape') view.current?.focus();
    else if (/^[1-9]$/.test(event.key) && !event.shiftKey) {
      const entry = buttons[Number(event.key) - 1];
      if (entry) run(entry);
    } else return;
    event.preventDefault();
  }

  let index = -1;
  return (
    <div ref={bar} className={styles.row} data-markup-row data-docked={docked || undefined}>
      {tagMode.kind === 'wrap' ? (
        <span className={styles.tagLabel} data-tag-mode="wrap">
          {docked ? 'Tag:' : 'Tag selection:'}
        </span>
      ) : tagMode.kind === 'refused' && !docked ? (
        <span
          className={styles.tagLabel}
          data-tag-mode="refused"
          title={`The element symbols insert at the caret: the selection ${tagMode.reason === tagRefusals.declaration ? 'is on a declaration line' : tagMode.reason}.`}
        >
          Can't tag: {tagMode.reason}
        </span>
      ) : null}
      <div
        className={styles.scrollWrap}
        data-more-start={edges.start || undefined}
        data-more-end={edges.end || undefined}
      >
        <div
          ref={scroller}
          className={styles.scroller}
          role="toolbar"
          aria-label="Markup tools"
          aria-orientation="horizontal"
          onKeyDown={keyDown}
        >
          {items.map((item, position) => {
            if (item === rowSeparator)
              return (
                <span
                  key={`separator-${position}`}
                  className={styles.separator}
                  aria-hidden="true"
                />
              );
            index++;
            const own = index;
            const key = own < numbered ? own + 1 : undefined;
            const wraps = tagMode.kind === 'wrap' && isElementIcon(item);
            return (
              <button
                key={item.id}
                type="button"
                className={styles.button}
                data-row-button
                data-entry={item.id}
                data-wrap={wraps || undefined}
                tabIndex={own === active ? 0 : -1}
                aria-label={wraps ? `Tag selection as ${elementLabel(item.label)}` : item.label}
                aria-keyshortcuts={key ? String(key) : undefined}
                title={
                  wraps
                    ? `Tag selection as ${elementLabel(item.label)}: <${item.label} … />${key ? `  ·  key ${key} while here` : ''}`
                    : `${item.id === 'inline:yellow' ? `${item.label}: ` : ''}${item.markup}${key ? `  ·  key ${key} while here` : ''}`
                }
                // Pressing never moves focus out of the text, so the selection stays put.
                onMouseDown={(event) => event.preventDefault()}
                onFocus={() => setActive(own)}
                onClick={() => run(item)}
              >
                <EntryGlyph glyph={item.glyph} />
              </button>
            );
          })}
        </div>
      </div>
      {rawView !== undefined && onRawView && (
        <button
          type="button"
          className={styles.rawButton}
          data-raw-toggle
          aria-pressed={rawView}
          aria-keyshortcuts="Control+Shift+Period"
          title="Show the raw markup instead of symbols and colours (Ctrl+Shift+.)"
          // Pressing it never moves focus out of the text.
          onMouseDown={(event) => event.preventDefault()}
          onClick={onRawView}
        >
          Raw
        </button>
      )}
      {docked && onSuggest && (
        <button
          type="button"
          className={styles.suggestButton}
          data-suggest-button
          title="List every markup option, with the ones that fit here first"
          // Pressing it never moves focus out of the text: a selection is what it transforms.
          onMouseDown={(event) => event.preventDefault()}
          onClick={onSuggest}
        >
          Suggest
        </button>
      )}
      <AllPopover
        view={view}
        globals={globals}
        usage={usage}
        onResult={setMessage}
        docked={docked}
      />
      {message && (
        <div className={styles.note} role="status">
          {message}
        </div>
      )}
    </div>
  );
});
