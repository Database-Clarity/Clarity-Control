import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Lang } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { Overlay } from '../editor/StatusBar';
import type { Term } from './termList';
import styles from './TermsPanel.module.scss';
import { Popover } from '../../ui/Popover';
import { TermForm } from './TermForm';
import { canEditGlossary, ensureGlossary, useGlossaryStore } from '../../stores/glossary';
import { useAuthStore } from '../../stores/auth';

interface Row {
  term: Term;
  name: string;
  inGame?: boolean;
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
  missing = [],
}: {
  terms: readonly Term[];
  lang: Lang;
  canInsert: boolean;
  onInsert(text: string): void;
  onClose(): void;
  missing?: readonly string[];
}) {
  const rows: Row[] = terms
    .flatMap((term) => [
      ...term.official.map((name) => ({ term, name })),
      ...(term.inGame ?? [])
        .filter((name) => !term.official.includes(name))
        .map((name) => ({ term, name, inGame: true })),
    ])
    .sort((a, b) => Number(missing.includes(b.term.en)) - Number(missing.includes(a.term.en)));
  const [active, setActive] = useState(0);
  const [form, setForm] = useState<'add' | 'edit' | null>(null);
  useAuthStore((state) => state.user);
  const glossary = useGlossaryStore((state) => state.byLang[lang]);
  const canEdit = canEditGlossary(lang) && !!glossary?.remote && !glossary.loading;
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
    if (canEdit && (event.key.toLowerCase() === 'a' || event.key.toLowerCase() === 'e')) {
      event.preventDefault();
      setForm(event.key.toLowerCase() === 'a' ? 'add' : 'edit');
      return;
    }
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
      heading={`Terms · ${languageLabel(lang)}`}
      onClose={onClose}
    >
      {!rows.length && (
        <p className={styles.message}>
          No terms in this tooltip yet. Select words in the English text, or add a term here.
        </p>
      )}
      {glossary?.error && (
        <p role="alert" className={styles.message}>
          Glossary unavailable.{' '}
          <button type="button" onClick={() => ensureGlossary(lang, true)}>
            Retry
          </button>
        </p>
      )}
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
            data-missing={(!row.inGame && missing.includes(row.term.en)) || undefined}
            onPointerMove={() => setActive(index)}
            // The whole row inserts (one easy tap on a phone); Insert shows what a tap does.
            onMouseDown={(event) => event.preventDefault()}
            onClick={canInsert ? () => onInsert(row.name) : undefined}
          >
            <span className={styles.english} lang="en">
              {row.term.en}
              {row.inGame && <small> · In game</small>}
            </span>
            <strong className={styles.name}>
              {row.name}
              {!row.inGame && missing.includes(row.term.en) && <small> · Missing</small>}
            </strong>
            {canInsert && (
              <button
                type="button"
                className={styles.insert}
                tabIndex={-1}
                title="Insert at the caret in the translation"
              >
                Insert
              </button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className={styles.actions}>
          <Popover
            label="Add glossary term"
            trigger="Add term"
            width={340}
            open={form === 'add'}
            onOpenChange={(open) => setForm(open ? 'add' : null)}
            contain
          >
            {(close) => <TermForm lang={lang} onClose={close} />}
          </Popover>
          {rows[active] && (
            <Popover
              label="Edit glossary term"
              trigger={rows[active].term.glossary ? 'Edit term' : 'Add entry'}
              width={340}
              open={form === 'edit'}
              onOpenChange={(open) => setForm(open ? 'edit' : null)}
              contain
            >
              {(close) => (
                <TermForm
                  key={rows[active].term.en}
                  lang={lang}
                  entry={rows[active].term.glossary}
                  english={rows[active].term.en}
                  onClose={close}
                />
              )}
            </Popover>
          )}
        </div>
      )}
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
