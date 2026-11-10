import { useEffect, useMemo, useState, type RefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import type { MarkupGlobals } from '@clarity/core';
import { Popover } from '../../../ui/Popover';
import { fuzzyScore } from '../suggest/source';
import type { UsageCorpus } from '../suggest/usage';
import { EntryGlyph } from './EntryGlyph';
import { entryGroups, entryMessage, markupEntries, type MarkupEntry } from './entries';
import styles from './MarkupRow.module.scss';

function AllList({
  view,
  globals,
  usage,
  close,
  onResult,
  docked,
}: {
  view: RefObject<EditorView | null>;
  globals: MarkupGlobals;
  usage?: UsageCorpus;
  close(restoreFocus?: boolean): void;
  onResult(message: string): void;
  docked: boolean;
}) {
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState<MarkupEntry | null>(null);
  // Variables are read when the popover opens, so the list is the document as it is now.
  const entries = useMemo(
    () => markupEntries(globals, view.current?.state.doc.toString() ?? ''),
    [globals, view],
  );
  const groups = useMemo(
    () =>
      entryGroups
        .map((group) => ({
          group,
          entries: entries
            .filter((entry) => entry.group === group)
            .map((entry) => ({
              entry,
              score: query
                ? Math.max(
                    fuzzyScore(`${entry.label} ${entry.markup}`.replace(/[<>/]/g, ' '), query) ??
                      -1,
                    (fuzzyScore(entry.keys, query) ?? 0) - 15,
                  )
                : 0,
            }))
            .filter(({ score }) => !query || score > 0)
            .sort((a, b) => b.score - a.score)
            .map(({ entry }) => entry),
        }))
        .filter(({ entries: found }) => found.length),
    [entries, query],
  );
  // Docked (a phone), Escape hands the caret back to the text, so the keyboard stays where the
  // author was typing. The window listener runs before the popover's own (document) one.
  useEffect(() => {
    if (!docked) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close(false);
      view.current?.focus();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [docked, close, view]);
  const used = current?.usage && usage ? usage.count(current.usage) : undefined;

  function insert(entry: MarkupEntry) {
    const editor = view.current;
    if (!editor) return;
    const result = entry.run(editor, globals);
    onResult(entryMessage(result));
    // The text gets the caret back; the popover has done its job.
    close(false);
    if (result !== 'inserted') editor.focus();
  }

  function keyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = {
      ArrowDown: 1,
      ArrowRight: 1,
      ArrowUp: -1,
      ArrowLeft: -1,
    };
    const step = moves[event.key];
    if (!step) return;
    const target = event.target as HTMLElement;
    const inField = target.tagName === 'INPUT';
    // Left and right belong to the filter field's caret while the focus is in it.
    if (inField && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return;
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-all-button]'),
    ];
    const at = buttons.indexOf(target as HTMLButtonElement);
    const next = inField
      ? step > 0
        ? buttons[0]
        : undefined
      : at + step < 0
        ? event.currentTarget.querySelector<HTMLInputElement>('input')
        : buttons[Math.min(at + step, buttons.length - 1)];
    if (!next) return;
    next.focus();
    event.preventDefault();
  }

  return (
    <div className={styles.all} onKeyDown={keyDown} data-all-popover>
      <input
        type="search"
        className={styles.filter}
        placeholder="Filter"
        aria-label="Filter markup"
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            const first = groups[0]?.entries[0];
            if (first) insert(first);
          }
        }}
      />
      <div className={styles.groups}>
        {groups.map(({ group, entries: found }) => (
          <div key={group} className={styles.group} role="group" aria-label={group}>
            <div className={styles.groupTitle}>{group}</div>
            <div className={styles.groupItems}>
              {found.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={styles.chip}
                  data-all-button
                  title={`${entry.label}: ${entry.markup}`}
                  aria-label={entry.label}
                  onFocus={() => setCurrent(entry)}
                  onMouseEnter={() => setCurrent(entry)}
                  onClick={() => insert(entry)}
                >
                  <EntryGlyph glyph={entry.glyph} />
                </button>
              ))}
            </div>
          </div>
        ))}
        {!groups.length && <p className={styles.empty}>Nothing matches “{query}”.</p>}
      </div>
      <p className={styles.footer}>
        {current ? (
          <>
            <code>{current.markup}</code>
            <span>
              {current.about}
              {used !== undefined &&
                (used === 0
                  ? ' Unused so far.'
                  : ` In ${new Intl.NumberFormat().format(used)} ${used === 1 ? 'tooltip' : 'tooltips'}.`)}
            </span>
          </>
        ) : (
          <span>Hover for details · Enter inserts the first match</span>
        )}
      </p>
    </div>
  );
}

/** "All": every markup option, grouped and filterable, in a popover (a bottom sheet on a phone). */
export function AllPopover({
  view,
  globals,
  usage,
  onResult,
  docked = false,
}: {
  view: RefObject<EditorView | null>;
  globals: MarkupGlobals;
  usage?: UsageCorpus;
  onResult(message: string): void;
  /** On the docked bar (bottom of the page) the sheet rises from the bottom, not from the trigger. */
  docked?: boolean;
}) {
  return (
    <Popover
      label="All markup"
      className={styles.allButton}
      trigger={
        <>
          All <span className={styles.chevron} aria-hidden="true" />
        </>
      }
      triggerTitle="Every markup option, grouped, with a filter"
      sheetFromTrigger={!docked}
    >
      {(close) => (
        <AllList
          view={view}
          globals={globals}
          usage={usage}
          close={close}
          onResult={onResult}
          docked={docked}
        />
      )}
    </Popover>
  );
}
