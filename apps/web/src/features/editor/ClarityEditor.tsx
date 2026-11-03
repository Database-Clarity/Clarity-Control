import { useEffect, useMemo, useRef, useState } from 'react';
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
import { editorScrollMargins } from './scrollMargins';
import { validationDiagnostics } from './diagnostics';
import { MarkupToolbar } from './MarkupToolbar';
import {
  GlyphPanel,
  HelpPanel,
  StatusBar,
  type PreviewStatus,
  type StatusPanel,
} from './StatusBar';
import { referenceExtensions, type ReferenceHost, type TooltipTarget } from './referenceActions';
import type { ReferenceSources } from './references';
import styles from './ClarityEditor.module.scss';

export interface ClarityEditorProps {
  value: string;
  lang: Lang;
  onChange: (value: string) => void;
  globals: MarkupGlobals;
  readOnly?: boolean;
  requireEnglish?: boolean;
  highlightLine?: number;
  /** Why the text cannot be edited, shown in the status bar. */
  readOnlyReason?: string | null;
  /** The preview column's state, for the status bar (desktop page only). */
  preview?: PreviewStatus;
  markupToolbar?: boolean;
  /** Hash of the tooltip being edited; definitions inside it are selected, not navigated to. */
  tooltipHash?: number;
  /** Where every tooltip's text lives, for hover previews and go-to-definition across tooltips. */
  referenceSources?: ReferenceSources;
  /** Go-to-definition in another tooltip. Without it only same-document jumps are offered. */
  onOpenTooltip?: (target: TooltipTarget) => void;
}

function configuration(
  lang: Lang,
  globals: MarkupGlobals,
  readOnly: boolean,
  requireEnglish: boolean,
  references: Omit<ReferenceHost, 'lang' | 'globals'>,
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
    validationDiagnostics(lang, globals, requireEnglish, references.selfHash),
    referenceExtensions({ ...references, lang, globals }),
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
  readOnlyReason = null,
  preview,
  markupToolbar = false,
  tooltipHash,
  referenceSources,
  onOpenTooltip,
}: ClarityEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callback = useRef(onChange);
  const [panel, setPanel] = useState<StatusPanel | null>(null);
  const panelOpen = useRef(false);
  panelOpen.current = panel !== null;
  const closePanel = useRef(() => setPanel(null));
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const referenceLive = useRef({ tooltipHash, referenceSources, onOpenTooltip });
  const references = useRef<Omit<ReferenceHost, 'lang' | 'globals'>>({
    sources: () => referenceLive.current.referenceSources,
    selfHash: () => referenceLive.current.tooltipHash,
    navigate: () => referenceLive.current.onOpenTooltip,
  });
  const initial = useRef({ value, lang, globals, readOnly, requireEnglish });
  const config = useRef(new Compartment());
  const extensions = useRef<Extension[]>([]);
  const issues = useMemo(
    () => validateText(value, lang, globals, requireEnglish, tooltipHash),
    [value, lang, globals, requireEnglish, tooltipHash],
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
    referenceLive.current = { tooltipHash, referenceSources, onOpenTooltip };
  }, [tooltipHash, referenceSources, onOpenTooltip]);
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
      editorScrollMargins(),
      history(),
      search(),
      indentOnInput(),
      bracketMatching(),
      clarityLanguage,
      clarityHighlighting,
      keymap.of([
        {
          key: 'Escape',
          run: () => {
            // Esc closes an open panel first; otherwise it keeps its meaning (leave the editor).
            if (!panelOpen.current) return false;
            closePanel.current();
            return true;
          },
        },
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
          references.current,
        ),
      ),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) callback.current(update.state.doc.toString());
        if (update.docChanged || update.selectionSet) {
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          setCursor((previous) =>
            previous.line === line.number && previous.column === head - line.from + 1
              ? previous
              : { line: line.number, column: head - line.from + 1 },
          );
        }
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
      effects: config.current.reconfigure(
        configuration(lang, globals, readOnly, requireEnglish, references.current),
      ),
    });
  }, [value, lang, globals, readOnly, requireEnglish]);

  useEffect(() => {
    view.current?.dispatch({
      effects: config.current.reconfigure(
        configuration(lang, globals, readOnly, requireEnglish, references.current),
      ),
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

  const glyphCount = glyphs.reduce((sum, group) => sum + group.count, 0);
  // A panel for something that has gone away closes itself.
  const open = panel === 'glyphs' && glyphCount === 0 ? null : panel;
  return (
    <div className={styles.editor} data-editor-root>
      {markupToolbar && !readOnly && <MarkupToolbar editor={view} globals={globals} />}
      <div className={styles.textArea}>
        <div ref={host} className={styles.host} />
        {open === 'glyphs' && (
          <GlyphPanel
            groups={glyphs}
            value={value}
            readOnly={readOnly}
            onReplace={replaceGlyph}
            onClose={() => setPanel(null)}
          />
        )}
        {open === 'help' && <HelpPanel issues={issues} onClose={() => setPanel(null)} />}
      </div>
      <StatusBar
        readOnlyReason={readOnlyReason}
        issues={issues}
        glyphCount={glyphCount}
        line={cursor.line}
        column={cursor.column}
        preview={preview}
        panel={open}
        onPanel={setPanel}
      />
    </div>
  );
}
