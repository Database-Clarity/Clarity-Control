import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Lang } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { Overlay } from '../editor/StatusBar';
import type { Term } from './termList';
import styles from './TermsPanel.module.scss';

interface Row {
  term: Term;
  name: string;
}

/**
 * The tooltip's terms as a list over the text (Ctrl+K, then G, or the status bar's Terms item):
 * the keyboard and phone path to what the English pane's marks offer. Up and Down move, Enter or
 * Insert puts the in-game name at the caret, Esc goes back to the text.
 */
export function TermsPanel({
  terms,
  lang,
  canInsert,
  onInsert,
  onClose,
}: {
  terms: readonly Term[];
  lang: Lang;
  canInsert: boolean;
  onInsert(text: string): void;
  onClose(): void;
}) {
  const rows: Row[] = terms.flatMap((term) => term.official.map((name) => ({ term, name })));
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  // After the overlay has noted where focus came from (it returns there on close).
  useEffect(() => {
    const frame = requestAnimationFrame(() => list.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    list.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const onKeyDown = (event: KeyboardEvent) => {
    const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (move) {
      event.preventDefault();
      setActive((index) => Math.max(0, Math.min(rows.length - 1, index + move)));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : rows.length - 1);
    } else if (event.key === 'Enter' && canInsert && rows[active]) {
      event.preventDefault();
      onInsert(rows[active].name);
    }
  };
  return (
    <Overlay
      id="editor-panel-terms"
      label="Terms"
      heading={`Terms · in-game names in ${languageLabel(lang)}`}
      onClose={onClose}
    >
      <ul
        ref={list}
        className={styles.list}
        role="listbox"
        aria-label={`Terms in this tooltip, in-game names in ${languageLabel(lang)}`}
        aria-activedescendant={rows.length ? `${id}-${active}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {rows.map((row, index) => (
          <li
            key={`${row.term.en}\u0000${row.name}`}
            id={`${id}-${index}`}
            data-row={index}
            role="option"
            aria-selected={index === active}
            className={styles.row}
            onPointerMove={() => setActive(index)}
          >
            <span className={styles.english} lang="en">
              {row.term.en}
            </span>
            <strong className={styles.name}>{row.name}</strong>
            {canInsert && (
              <button
                type="button"
                className={styles.insert}
                tabIndex={-1}
                title="Insert at the caret in the translation"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onInsert(row.name)}
              >
                Insert
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className={styles.hint}>
        <kbd>↑</kbd> <kbd>↓</kbd> move
        {canInsert && (
          <>
            {' '}
            · <kbd>Enter</kbd> inserts
          </>
        )}{' '}
        · <kbd>Esc</kbd> back to the text
      </p>
    </Overlay>
  );
}
