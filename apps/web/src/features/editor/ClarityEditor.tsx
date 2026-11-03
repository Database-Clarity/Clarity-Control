import { useEffect, useMemo, useRef, useState } from 'react';
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
  countConflicts,
  glyphWarnings,
  canReplaceGlyph,
  maskConflicts,
  markupLanguage,
  validateText,
  type Lang,
  type MarkupGlobals,
} from '@clarity/core';
import { clarityHighlighting, clarityLanguage } from './language';
import { tableFormattingTransaction } from './formatTable';
import { editorScrollMargins } from './scrollMargins';
import { rememberSearch, restoreSearch } from './searchMemory';
import { rawMode, setSymbolReveal, symbolExtensions, toggleRawView } from './symbols';
import { validationDiagnostics } from './diagnostics';
import { MarkupRow } from './markupRow/MarkupRow';
import { SuggestChip } from './markupRow/SuggestChip';
import { chipHost, chipsExtension, type Chip } from './markupRow/chips';
import { useSettingsStore, type SuggestAccept } from '../../stores/settings';
import {
  ConflictPanel,
  GlyphPanel,
  HelpPanel,
  StatusBar,
  type PreviewStatus,
  type StatusPanel,
} from './StatusBar';
import { CompareView, type CompareData } from '../conflicts/CompareView';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import {
  conflictExtensions,
  conflictHost,
  conflictsOf,
  jumpToConflict,
  resolveBlock,
} from './conflicts';
import { referenceExtensions, type ReferenceHost, type TooltipTarget } from './referenceActions';
import { SuggestMenu } from './suggest/SuggestMenu';
import {
  openSuggest,
  suggestConfiguration,
  suggestExtension,
  type SuggestSnapshot,
} from './suggest/state';
import type { UsageCorpus } from './suggest/usage';
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
  /** Shows the markup row at the top of the editor (the page decides; Ctrl+. flips it). */
  markupRow?: boolean;
  /**
   * The versions an open conflict started from, for Compare. Without them Compare still shows
   * mine and theirs from the marker block itself.
   */
  conflictSource?: CompareData;
  /** Hash of the tooltip being edited; definitions inside it are selected, not navigated to. */
  tooltipHash?: number;
  /** Where every tooltip's text lives, for hover previews and go-to-definition across tooltips. */
  referenceSources?: ReferenceSources;
  /** Go-to-definition in another tooltip. Without it only same-document jumps are offered. */
  onOpenTooltip?: (target: TooltipTarget) => void;
  /** Saved English tooltips, for the suggestion menu's usage counts. */
  usage?: UsageCorpus;
  /** Draws icon and colour tags as symbols (Ctrl+Shift+. shows the raw markup). Off for stored forms. */
  symbols?: boolean;
  /** Carries find and replace across tooltips in this tab. Off for stored forms (a second editor). */
  findMemory?: boolean;
}

function configuration(
  lang: Lang,
  globals: MarkupGlobals,
  readOnly: boolean,
  requireEnglish: boolean,
  references: Omit<ReferenceHost, 'lang' | 'globals'>,
  onSuggest: (snapshot: SuggestSnapshot | null) => void,
  chips: { acceptKey(): SuggestAccept; onChange(chip: Chip | null): void },
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
    suggestConfiguration({ globals, onChange: onSuggest }),
    chipHost.of({ globals, ...chips }),
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
  markupRow = false,
  conflictSource,
  tooltipHash,
  referenceSources,
  onOpenTooltip,
  usage,
  symbols = true,
  findMemory = true,
}: ClarityEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callback = useRef(onChange);
  const [panel, setPanel] = useState<StatusPanel | null>(null);
  const panelOpen = useRef(false);
  panelOpen.current = panel !== null;
  const closePanel = useRef(() => setPanel(null));
  const [suggestion, setSuggestion] = useState<SuggestSnapshot | null>(null);
  const onSuggest = useRef((snapshot: SuggestSnapshot | null) => setSuggestion(snapshot));
  const [chip, setChip] = useState<Chip | null>(null);
  const acceptKey = useSettingsStore((state) => state.device.suggestAccept);
  const acceptKeyRef = useRef(acceptKey);
  acceptKeyRef.current = acceptKey;
  const symbolReveal = useSettingsStore((state) => state.device.symbolReveal);
  const revealRef = useRef(symbolReveal);
  revealRef.current = symbolReveal;
  const rawRef = useRef(false);
  const [rawView, setRawView] = useState(false);
  const symbolsOn = useRef(symbols);
  const chipHooks = useRef({
    acceptKey: () => acceptKeyRef.current,
    onChange: (next: Chip | null) => setChip(next),
  });
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
  // Conflict blocks are checked as "mine" only (same offsets), so markers raise no markup errors.
  const issues = useMemo(
    () => validateText(maskConflicts(value), lang, globals, requireEnglish, tooltipHash),
    [value, lang, globals, requireEnglish, tooltipHash],
  );
  const conflictCount = useMemo(() => countConflicts(value), [value]);
  const compact = useMedia(`${phoneQuery}, (pointer: coarse)`);
  const [compare, setCompare] = useState<CompareData | null>(null);
  const [conflictIndex, setConflictIndex] = useState(0);
  const conflictConfig = useRef(new Compartment());
  const conflictLive = useRef({ conflictSource });
  conflictLive.current = { conflictSource };

  /** Compare for one block: the three versions when known, else the block's own two sides. */
  function openCompare(index: number) {
    const editor = view.current;
    const block = editor ? conflictsOf(editor.state).blocks[index] : undefined;
    const known = conflictLive.current.conflictSource;
    if (known) setCompare(known);
    else if (block)
      setCompare({
        mine: block.mineLines.join('\n'),
        base: null,
        theirs: block.theirsLines.join('\n'),
        theirsLabel: block.label,
      });
  }
  const compareRef = useRef(openCompare);
  compareRef.current = openCompare;
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
    if (view.current && symbolsOn.current) setSymbolReveal(view.current, symbolReveal);
  }, [symbolReveal]);
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
      conflictExtensions(),
      conflictConfig.current.of(
        conflictHost.of({ compact: false, onCompare: () => undefined, onPanel: () => undefined }),
      ),
      history(),
      search({ top: true }),
      indentOnInput(),
      bracketMatching(),
      clarityLanguage,
      clarityHighlighting,
      suggestExtension(),
      chipsExtension(),
      ...(symbolsOn.current
        ? symbolExtensions({ mode: () => revealRef.current, raw: () => rawRef.current })
        : []),
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
          onSuggest.current,
          chipHooks.current,
        ),
      ),
      EditorView.updateListener.of((update) => {
        const raw = update.state.field(rawMode, false);
        if (raw !== undefined && raw !== rawRef.current) {
          rawRef.current = raw;
          setRawView(raw);
        }
        if (findMemory) rememberSearch(update);
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
    // Find and replace carries over from the previous tooltip (or page) in this tab.
    if (findMemory) restoreSearch(editor);
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, []);

  // The conflict actions' host: set again whenever the editor state is rebuilt for a new text.
  const compactRef = useRef(compact);
  compactRef.current = compact;
  const conflictHostExtension = () =>
    conflictHost.of({
      compact: compactRef.current,
      onCompare: (index) => compareRef.current(index),
      onPanel(index) {
        setConflictIndex(index);
        setPanel('conflicts');
      },
    });
  useEffect(() => {
    view.current?.dispatch({
      effects: conflictConfig.current.reconfigure(conflictHostExtension()),
    });
  }, [compact]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    // A different tooltip/language must never undo into the previous document.
    editor.setState(EditorState.create({ doc: value, extensions: extensions.current }));
    editor.dispatch({
      effects: [
        config.current.reconfigure(
          configuration(
            lang,
            globals,
            readOnly,
            requireEnglish,
            references.current,
            onSuggest.current,
            chipHooks.current,
          ),
        ),
        // A rebuilt state starts from the initial extensions: the compartments need their live values.
        conflictConfig.current.reconfigure(conflictHostExtension()),
      ],
    });
    // The rebuilt state starts with find closed: bring back what was open.
    if (findMemory) restoreSearch(editor);
  }, [value, lang, globals, readOnly, requireEnglish]);

  useEffect(() => {
    view.current?.dispatch({
      effects: config.current.reconfigure(
        configuration(
          lang,
          globals,
          readOnly,
          requireEnglish,
          references.current,
          onSuggest.current,
          chipHooks.current,
        ),
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
  const open =
    (panel === 'glyphs' && glyphCount === 0) || (panel === 'conflicts' && conflictCount === 0)
      ? null
      : panel;
  return (
    <div className={styles.editor} data-editor-root>
      {markupRow && !readOnly && <MarkupRow view={view} globals={globals} usage={usage} />}
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
        {open === 'conflicts' && (
          <ConflictPanel
            index={Math.min(conflictIndex, conflictCount - 1)}
            count={conflictCount}
            readOnly={readOnly}
            onResolve={(choice) => {
              if (view.current)
                resolveBlock(view.current, Math.min(conflictIndex, conflictCount - 1), choice);
              setPanel(null);
            }}
            onCompare={() => {
              setPanel(null);
              openCompare(conflictIndex);
            }}
            onStep={(direction) => {
              const editor = view.current;
              if (!editor) return;
              jumpToConflict(editor, direction);
              setConflictIndex(conflictsOf(editor.state).active);
            }}
            onClose={() => setPanel(null)}
          />
        )}
        {compare && (
          <CompareView
            data={compare}
            onClose={() => {
              setCompare(null);
              view.current?.focus();
            }}
          />
        )}
      </div>
      {suggestion && view.current && (
        <SuggestMenu
          snapshot={suggestion}
          view={view.current}
          globals={globals}
          lang={lang}
          usage={usage}
        />
      )}
      {chip && view.current && !suggestion && (
        <SuggestChip chip={chip} view={view.current} acceptKey={acceptKey} />
      )}
      <StatusBar
        readOnlyReason={readOnlyReason}
        issues={issues}
        glyphCount={glyphCount}
        line={cursor.line}
        column={cursor.column}
        preview={preview}
        conflicts={
          conflictCount > 0
            ? {
                count: conflictCount,
                onNext() {
                  if (view.current) jumpToConflict(view.current, 1);
                },
              }
            : undefined
        }
        panel={open}
        onPanel={setPanel}
        onSuggest={readOnly ? undefined : () => view.current && openSuggest(view.current)}
        rawView={symbols ? rawView : undefined}
        onRawView={() => view.current && toggleRawView(view.current)}
      />
    </div>
  );
}
