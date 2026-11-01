import { useEffect, useState, type RefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import type { MarkupGlobals } from '@clarity/core';
import { insertMarkup, markupOptions } from './markupInsertion';
import styles from './ClarityEditor.module.scss';

const preferenceKey = 'clarity-translator-markup-toolbar';
const groups = [...new Set(markupOptions.map((option) => option.group))];

export function MarkupToolbar({
  editor,
  globals,
}: {
  editor: RefObject<EditorView | null>;
  globals: MarkupGlobals;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(markupOptions[0].id);
  const [message, setMessage] = useState('');

  useEffect(() => {
    try {
      setOpen(localStorage.getItem(preferenceKey) === 'open');
    } catch {
      setMessage('Cannot read the saved markup toolbar preference.');
    }
  }, []);

  function toggle() {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(preferenceKey, next ? 'open' : 'closed');
      setMessage('');
    } catch {
      setMessage('Cannot save the markup toolbar preference.');
    }
  }

  function insert() {
    const option = markupOptions.find((item) => item.id === choice);
    if (!editor.current || !option) {
      setMessage('The markup editor is not ready.');
    } else {
      const result = insertMarkup(editor.current, option, globals);
      setMessage(
        result === 'composing'
          ? 'Finish composing text before inserting markup.'
          : result === 'read-only'
            ? 'The markup editor is read-only.'
            : result === 'unsupported'
              ? 'Cannot insert markup here without breaking existing syntax. Select plain text outside markup.'
              : '',
      );
    }
  }

  return (
    <div className={styles.toolbar}>
      <button type="button" aria-expanded={open} onClick={toggle}>
        {open ? 'Hide markup tools' : 'Show markup tools'}
      </button>
      {open && (
        <div className={styles.toolbarControls}>
          <label>
            Markup
            <select value={choice} onChange={(event) => setChoice(event.target.value)}>
              {groups.map((group) => (
                <optgroup key={group} label={group}>
                  {markupOptions
                    .filter((option) => option.group === group)
                    .map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={insert}>
            Insert
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
