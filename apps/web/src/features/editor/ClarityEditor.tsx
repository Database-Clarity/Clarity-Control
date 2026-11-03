import { useEffect, useMemo, useRef } from 'react';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
} from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from '@codemirror/view';
import {
  glyphWarnings,
  canReplaceGlyph,
  markupLanguage,
  validateText,
  type Lang,
  type MarkupGlobals,
} from '@clarity/core';
import { clarityCompletions } from './completion';
import { clarityHighlighting, clarityLanguage } from './language';
import { tableFormattingTransaction } from './formatTable';
import { saveDockScrollMargins } from './scrollMargins';
import { validationDiagnostics } from './diagnostics';
import { MarkupToolbar } from './MarkupToolbar';
import styles from './ClarityEditor.module.scss';

export interface ClarityEditorProps {
  value: string;
  lang: Lang;
  onChange: (value: string) => void;
  globals: MarkupGlobals;
  readOnly?: boolean;
  requireEnglish?: boolean;
  highlightLine?: number;
  markupToolbar?: boolean;
}

function configuration(
  lang: Lang,
  globals: MarkupGlobals,
  readOnly: boolean,
  requireEnglish: boolean,
) {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    EditorView.contentAttributes.of({
      spellcheck: 'true',
      lang: markupLanguage(lang),
      autocorrect: 'on',
      autocapitalize: 'off',
      'aria-label': 'Clarity markup',
      'aria-multiline': 'true',
    }),
    autocompletion({ override: [clarityCompletions(globals)] }),
    validationDiagnostics(lang, globals, requireEnglish),
  ];
}

export function ClarityEditor({
  value,
  lang,
  onChange,
  globals,
  readOnly = false,
  requireEnglish = true,
  highlightLine,
  markupToolbar = false,
}: ClarityEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callback = useRef(onChange);
  const initial = useRef({ value, lang, globals, readOnly, requireEnglish });
  const config = useRef(new Compartment());
  const extensions = useRef<Extension[]>([]);
  const issues = useMemo(
    () => validateText(value, lang, globals, requireEnglish),
    [value, lang, globals, requireEnglish],
  );
  const glyphs = useMemo(() => {
    const groups = new Map<
      string,
      { warning: ReturnType<typeof glyphWarnings>[number]; count: number }
    >();
    for (const warning of glyphWarnings(value)) {
      const group = groups.get(warning.character);
      if (group) group.count++;
      else groups.set(warning.character, { warning, count: 1 });
    }
    return [...groups.values()];
  }, [value]);

  function replaceGlyph(character: string, replacement: string) {
    const editor = view.current;
    if (!editor || editor.state.readOnly) return;
    const from = editor.state.doc.toString().indexOf(character);
    if (from < 0) return;
    const text = editor.state.doc.toString();
    const warning = glyphWarnings(text.slice(from, from + character.length))[0];
    if (!warning || !canReplaceGlyph(text, { ...warning, from })) return;
    editor.dispatch({
      changes: { from, to: from + character.length, insert: replacement },
      selection: { anchor: from + replacement.length },
      scrollIntoView: true,
    });
    editor.focus();
  }

  useEffect(() => {
    callback.current = onChange;
  }, [onChange]);
  useEffect(() => {
    if (!host.current) return;
    const format = (editor: EditorView) => {
      if (editor.state.readOnly) return false;
      const transaction = tableFormattingTransaction(editor.state);
      if (transaction) editor.dispatch(transaction);
      return true;
    };
    extensions.current = [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      EditorView.lineWrapping,
      saveDockScrollMargins(),
      history(),
      search(),
      indentOnInput(),
      bracketMatching(),
      clarityLanguage,
      clarityHighlighting,
      keymap.of([
        { key: 'ScrollLock', run: format },
        { key: 'Mod-Shift-f', run: format },
        { key: 'Mod-/', run: toggleComment },
        ...searchKeymap,
        ...completionKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab,
      ]),
      config.current.of(
        configuration(
          initial.current.lang,
          initial.current.globals,
          initial.current.readOnly,
          initial.current.requireEnglish,
        ),
      ),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) callback.current(update.state.doc.toString());
      }),
    ];
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: initial.current.value, extensions: extensions.current }),
    });
    view.current = editor;
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    // A different tooltip/language must never undo into the previous document.
    editor.setState(EditorState.create({ doc: value, extensions: extensions.current }));
    editor.dispatch({
      effects: config.current.reconfigure(configuration(lang, globals, readOnly, requireEnglish)),
    });
  }, [value, lang, globals, readOnly, requireEnglish]);

  useEffect(() => {
    view.current?.dispatch({
      effects: config.current.reconfigure(configuration(lang, globals, readOnly, requireEnglish)),
    });
  }, [lang, globals, readOnly, requireEnglish]);

  useEffect(() => {
    const editor = view.current;
    if (
      !editor ||
      !highlightLine ||
      !Number.isInteger(highlightLine) ||
      highlightLine < 1 ||
      highlightLine > editor.state.doc.lines
    )
      return;
    const line = editor.state.doc.line(highlightLine);
    editor.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true });
    editor.focus();
  }, [highlightLine]);

  return (
    <div className={styles.editor}>
      {markupToolbar && !readOnly && <MarkupToolbar editor={view} globals={globals} />}
      <div ref={host} />
      <div role="status" aria-live="polite" className={styles.glyphStatus}>
        {glyphs.length > 0 && (
          <details open>
            <summary>
              Character display warning ({glyphs.reduce((sum, group) => sum + group.count, 0)}) —
              saving is allowed
            </summary>
            <ul aria-label="Character display warnings">
              {glyphs.slice(0, 6).map(({ warning, count }) => (
                <li key={warning.character}>
                  {warning.message} {count > 1 && `(${count} occurrences)`}{' '}
                  {!readOnly && canReplaceGlyph(value, warning) && (
                    <button
                      type="button"
                      onClick={() => replaceGlyph(warning.character, warning.replacement!)}
                    >
                      Replace first {warning.codePoint} with {warning.replacement}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {glyphs.length > 6 && (
              <p>{glyphs.length - 6} more character types highlighted in the editor.</p>
            )}
          </details>
        )}
      </div>
      <details className={styles.help}>
        <summary>{issues.length ? `${issues.length} markup issue(s)` : 'Markup help'}</summary>
        <p>
          Ctrl/Cmd+F: find and replace. Ctrl/Cmd+Space: complete. Ctrl/Cmd+Z: undo. Ctrl/Cmd+/:
          comment. Scroll Lock or Ctrl/Cmd+Shift+F: align tables. Tab indents; to leave the editor
          with the keyboard, press Esc, then Tab.
        </p>
        <p>
          Native spelling uses your browser&apos;s enabled dictionaries. Right-click a misspelling
          for suggestions.
        </p>
        {issues.length > 0 && (
          <ul aria-label="Markup issues">
            {issues.slice(0, 50).map((issue, index) => (
              <li key={index}>
                {issue.severity}: {issue.message}
              </li>
            ))}
            {issues.length > 50 && (
              <li>{issues.length - 50} more issues highlighted in the editor.</li>
            )}
          </ul>
        )}
      </details>
    </div>
  );
}
