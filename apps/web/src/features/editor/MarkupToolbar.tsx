import { useEffect, useState, type RefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import { insertMarkup, markupOptions } from './markupInsertion';
import styles from './ClarityEditor.module.scss';

const preferenceKey = 'clarity-translator-markup-toolbar';
const groups = [...new Set(markupOptions.map((option) => option.group))];

export function MarkupToolbar({ editor }: { editor: RefObject<EditorView | null> }) {
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
    } else if (!insertMarkup(editor.current, option)) {
      setMessage('Finish composing text before inserting markup.');
    } else {
      setMessage('');
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
