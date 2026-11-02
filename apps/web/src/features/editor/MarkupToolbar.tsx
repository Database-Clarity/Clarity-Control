import { useState, type RefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import type { MarkupGlobals } from '@clarity/core';
import { insertMarkup, markupOptions } from './markupInsertion';
import { useSettingsStore } from '../../stores/settings';
import styles from './ClarityEditor.module.scss';

const groups = [...new Set(markupOptions.map((option) => option.group))];

export function MarkupToolbar({
  editor,
  globals,
}: {
  editor: RefObject<EditorView | null>;
  globals: MarkupGlobals;
}) {
  // The default comes from Settings; toggling here changes this view only.
  const [open, setOpen] = useState(
    () => useSettingsStore.getState().settings.markupToolbar === 'open',
  );
  const [choice, setChoice] = useState(markupOptions[0].id);
  const [message, setMessage] = useState('');

  function toggle() {
    setOpen(!open);
    setMessage('');
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
            : result === 'table-link'
              ? 'Links are not supported in table cells. Insert the link outside the table or edit the markup directly.'
              : result === 'expansion'
                ? 'Imports or variable expansions may change the surrounding markup. Edit the markup directly.'
                : result === 'line-style'
                  ? 'This line or table row cannot display another of that line style. Edit the markup directly.'
                  : result === 'context'
                    ? 'Cannot insert markup in this syntax or selection. Select plain text outside it or edit the markup directly.'
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
