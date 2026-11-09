import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  isolateHistory,
  toggleComment,
} from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
  type Extension,
} from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from '@codemirror/view';
import {
  countConflicts,
  fixAllRetired,
  glyphWarnings,
  canReplaceGlyph,
  markupLanguage,
  type Lang,
  type MarkupGlobals,
  type RetiredFix,
  type RetiredOccurrence,
} from '@clarity/core';
import { clarityHighlighting, clarityLanguage } from './language';
import { tableFormattingTransaction } from './formatTable';
import { editorScrollMargins } from './scrollMargins';
import { findWidgetExtension, findWidgetPanel, openReplace } from './findWidget';
import { rememberSearch, restoreSearch } from './searchMemory';
import { rawMode, setSymbolReveal, symbolExtensions, toggleRaw, toggleRawView } from './symbols';
import { hasImportDependencies, validationDiagnostics } from './diagnostics';
import { useEditorDiagnostics } from './useEditorDiagnostics';
import { RetiredPanel, retiredIn } from './RetiredPanel';
import { createCursorPosition } from './cursorPosition';
import { MarkupRow } from './markupRow/MarkupRow';
import { SuggestChip } from './markupRow/SuggestChip';
import { chipHost, chipsExtension, type Chip } from './markupRow/chips';
import { useSettingsStore, type SuggestAccept } from '../../stores/settings';
import {
  ConflictPanel,
  GlyphPanel,
  HelpPanel,
  CursorStatusBar,
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

// Loading another saved/draft document must never call the authoring callback.
const documentLoad = Annotation.define<boolean>();

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
  /** Detach the expensive editor surface while selection input is still arriving. */
  suspended?: boolean;
  /** Navigation keeps the text live without moving the DOM selection on each step. */
  stepping?: boolean;
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
  suspended = false,
  stepping = false,
}: ClarityEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const wasSuspended = useRef(false);
  const restoreFocus = useRef(false);
  const wasStepping = useRef(false);
  const scrolled = useRef(false);
  if (suspended && !wasSuspended.current) restoreFocus.current = view.current?.hasFocus ?? false;
  wasSuspended.current = suspended;
  /** Fixed for the editor's lifetime: a stored form never joins the tab's find memory. */
  const remembersFind = useRef(findMemory);
  const callback = useRef(onChange);
  const [panel, setPanel] = useState<StatusPanel | null>(null);
  const panelOpen = useRef(false);
  panelOpen.current = panel !== null;
  const closePanel = useRef(() => setPanel(null));
  const closeAndFocus = () => setPanel(null);
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
  const flipRawView = useCallback(() => view.current && toggleRawView(view.current), []);
  const symbolsOn = useRef(symbols);
  const chipHooks = useRef({
    acceptKey: () => acceptKeyRef.current,
    onChange: (next: Chip | null) => setChip(next),
  });
  const [cursor] = useState(createCursorPosition);
  const referenceLive = useRef({ tooltipHash, referenceSources, onOpenTooltip });
  const references = useRef<Omit<ReferenceHost, 'lang' | 'globals'>>({
    sources: () => referenceLive.current.referenceSources,
    selfHash: () => referenceLive.current.tooltipHash,
    navigate: () => referenceLive.current.onOpenTooltip,
  });
  const initial = useRef({ value, lang, globals, readOnly, requireEnglish });
  initial.current = { value, lang, globals, readOnly, requireEnglish };
  const document = useRef({ tooltipHash, lang });
  const config = useRef(new Compartment());
  const undo = useRef(new Compartment());
  const historyUsed = useRef(false);
  const extensions = useRef<Extension[]>([]);
  const configured = useRef({ lang, globals, readOnly, requireEnglish });
  // Conflict blocks are checked as "mine" only (same offsets), so markers raise no markup errors.
  const diagnostics = useEditorDiagnostics(
    {
      text: value,
      lang,
      globals,
      requireEnglish,
      selfHash: tooltipHash,
    },
    !suspended,
  );
  // Retired markup has its own status item and panel; the generic count would double it.
  const issues = useMemo(
    () => diagnostics.issues.filter((issue) => issue.code !== 'retired'),
    [diagnostics.issues],
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
    for (const warning of diagnostics.glyphs) {
      const group = groups.get(warning.character);
      if (group) group.count++;
      else groups.set(warning.character, { warning, count: 1 });
    }
    return [...groups.values()];
  }, [diagnostics.glyphs]);

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

  /** One undo step; the occurrence is found again on the live text, so a late click is harmless. */
  function applyRetired(occurrence: RetiredOccurrence, fix: RetiredFix) {
    const editor = view.current;
    if (!editor || editor.state.readOnly) return;
    const live = retiredIn(editor.state.doc.toString())
      .find((found) => found.from === occurrence.from && found.token === occurrence.token)
      ?.fixes.find((candidate) => candidate.id === fix.id);
    if (!live) return;
    editor.dispatch({
      changes: live.edits,
      selection: { anchor: Math.min(...live.edits.map((edit) => edit.from)) },
      annotations: isolateHistory.of('full'),
      scrollIntoView: true,
    });
    editor.focus();
  }

  /** Fix all as one change from the first fixed form to the last, so a single undo restores it. */
  function fixAllRetiredMarkup() {
    const editor = view.current;
    if (!editor || editor.state.readOnly) return;
    const before = editor.state.doc.toString();
    const { text: after, fixed } = fixAllRetired(before, retiredIn);
    if (!fixed) return;
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let end = 0;
    while (
      end < before.length - start &&
      end < after.length - start &&
      before[before.length - 1 - end] === after[after.length - 1 - end]
    )
      end++;
    editor.dispatch({
      changes: {
        from: start,
        to: before.length - end,
        insert: after.slice(start, after.length - end),
      },
      selection: { anchor: start },
      annotations: isolateHistory.of('full'),
      scrollIntoView: true,
    });
    editor.focus();
  }

  useLayoutEffect(() => {
    callback.current = onChange;
  }, [onChange]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (stepping) {
      wasStepping.current = true;
      const selection = editor.dom.ownerDocument.getSelection();
      // Retire an old DOM range only when another control owns focus. A focused
      // editor must keep receiving native text/composition input during a burst.
      if (
        !editor.hasFocus &&
        selection?.anchorNode &&
        editor.contentDOM.contains(selection.anchorNode)
      )
        selection.removeAllRanges();
    }
  }, [stepping]);
  useLayoutEffect(() => {
    const editor = view.current;
    const container = host.current;
    if (!editor || !container) return;
    const owner = container.ownerDocument;
    if (suspended) {
      // Keep the view/state (including undo and caret), but take its DOM out of
      // layout so hidden CodeMirror measurements cannot compete with the finder.
      editor.dom.remove();
      const changedFocus = () => {
        restoreFocus.current = false;
      };
      owner.addEventListener('pointerdown', changedFocus, true);
      return () => owner.removeEventListener('pointerdown', changedFocus, true);
    }
    if (editor.dom.parentNode !== container) {
      container.append(editor.dom);
      editor.requestMeasure();
    }
  }, [suspended]);
  useEffect(() => {
    if (!suspended && view.current && symbolsOn.current)
      setSymbolReveal(view.current, symbolReveal);
  }, [symbolReveal, suspended]);
  useLayoutEffect(() => {
    referenceLive.current = { tooltipHash, referenceSources, onOpenTooltip };
  }, [tooltipHash, referenceSources, onOpenTooltip]);
  useEffect(() => {
    if (suspended || view.current || !host.current) return;
    const format = (editor: EditorView) => {
      if (editor.state.readOnly) return false;
      const transaction = tableFormattingTransaction(editor.state);
      if (transaction) editor.dispatch(transaction);
      return true;
    };
    const initialConfiguration = config.current.of(
      configuration(
        initial.current.lang,
        initial.current.globals,
        initial.current.readOnly,
        initial.current.requireEnglish,
        references.current,
        onSuggest.current,
        chipHooks.current,
      ),
    );
    const initialConflicts = conflictConfig.current.of(
      conflictHost.of({ compact: false, onCompare: () => undefined, onPanel: () => undefined }),
    );
    extensions.current = [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      EditorView.lineWrapping,
      EditorView.domEventHandlers({
        scroll(_event, editor) {
          scrolled.current = editor.scrollDOM.scrollTop !== 0;
        },
      }),
      editorScrollMargins(),
      conflictExtensions(),
      initialConflicts,
      undo.current.of(history()),
      search({ top: true, createPanel: findWidgetPanel }),
      findWidgetExtension,
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
        { key: 'Mod-h', run: openReplace, scope: 'editor search-panel', preventDefault: true },
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab,
      ]),
      initialConfiguration,
      EditorView.updateListener.of((update) => {
        const loaded = update.transactions.some((tr) => tr.annotation(documentLoad));
        const raw = update.state.field(rawMode, false);
        if (raw !== undefined && raw !== rawRef.current) {
          rawRef.current = raw;
          setRawView(raw);
        }
        if (remembersFind.current) rememberSearch(update);
        if (update.docChanged && !loaded) callback.current(update.state.doc.toString());
        if (update.docChanged || update.selectionSet) {
          if (!loaded) historyUsed.current = true;
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          cursor.set(line.number, head - line.from + 1);
        }
      }),
    ];
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: initial.current.value, extensions: extensions.current }),
    });
    view.current = editor;
    editor.dom.dataset.tooltipHash = String(referenceLive.current.tooltipHash ?? '');
    document.current = {
      tooltipHash: referenceLive.current.tooltipHash,
      lang: initial.current.lang,
    };
    configured.current = {
      lang: initial.current.lang,
      globals: initial.current.globals,
      readOnly: initial.current.readOnly,
      requireEnglish: initial.current.requireEnglish,
    };
    // Find and replace carries over from the previous tooltip (or page) in this tab.
    if (remembersFind.current) restoreSearch(editor);
  }, [cursor, suspended]);
  useEffect(
    () => () => {
      view.current?.destroy();
      view.current = null;
    },
    [],
  );

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
    if (suspended) return;
    view.current?.dispatch({
      effects: conflictConfig.current.reconfigure(conflictHostExtension()),
    });
  }, [compact, suspended]);

  useLayoutEffect(() => {
    if (suspended) return;
    const editor = view.current;
    if (!editor) return;
    const switched = document.current.tooltipHash !== tooltipHash || document.current.lang !== lang;
    document.current = { tooltipHash, lang };
    const endingStep = !stepping && wasStepping.current;
    if (endingStep) wasStepping.current = false;
    if (!switched && editor.state.doc.toString() === value) {
      if (
        endingStep &&
        (editor.state.selection.main.anchor !== 0 ||
          editor.state.selection.main.head !== 0 ||
          scrolled.current)
      )
        editor.dispatch({
          selection: { anchor: 0 },
          effects: EditorView.scrollIntoView(0, { y: 'start' }),
          annotations: Transaction.addToHistory.of(false),
        });
      return;
    }
    if (switched) {
      setPanel(null);
      setSuggestion(null);
      setChip(null);
      setCompare(null);
      setConflictIndex(0);
      cursor.set(1, 1);
      rawRef.current = false;
      setRawView(false);
    }
    const previous = configured.current;
    const reconfigure =
      previous.lang !== lang ||
      previous.globals !== globals ||
      previous.readOnly !== readOnly ||
      previous.requireEnglish !== requireEnglish;
    configured.current = { lang, globals, readOnly, requireEnglish };
    // Ordinary stepping is a single document transaction and retains the same
    // plugins and extensions. Only a used history field needs the extra reset:
    // mapping old undo deletions can resurrect text from another tooltip.
    const reset = historyUsed.current
      ? editor.state.update({ effects: undo.current.reconfigure([]) })
      : undefined;
    const from = reset?.state ?? editor.state;
    const load = from.update({
      changes: { from: 0, to: from.doc.length, insert: value },
      ...(stepping ? {} : { selection: { anchor: 0 } }),
      effects: [
        ...(reset ? [undo.current.reconfigure(history())] : []),
        ...(reconfigure
          ? [
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
            ]
          : []),
        ...(switched ? [toggleRaw.of(false)] : []),
        // Reading scrollTop during the React commit forces layout of the new
        // document. Let CodeMirror reset a scrolled view in its measure phase.
        ...(!stepping || scrolled.current ? [EditorView.scrollIntoView(0, { y: 'start' })] : []),
      ],
      annotations: [documentLoad.of(true), Transaction.addToHistory.of(false)],
    });
    editor.update(reset ? [reset, load] : [load]);
    historyUsed.current = false;
    editor.dom.dataset.tooltipHash = String(tooltipHash ?? '');
  }, [value, lang, globals, readOnly, requireEnglish, tooltipHash, suspended, stepping, cursor]);

  useLayoutEffect(() => {
    const editor = view.current;
    const owner = host.current?.ownerDocument;
    if (suspended || stepping || !editor || !owner) return;
    // Restore focus only after the landed document is installed. Focusing the
    // previous document first would measure and briefly expose its old caret.
    if (restoreFocus.current && owner.activeElement === owner.body) editor.focus();
    restoreFocus.current = false;
  }, [suspended, stepping, tooltipHash, lang]);

  useEffect(() => {
    if (suspended) return;
    const previous = configured.current;
    // A draft edit changes the imports snapshot even when this document does not import
    // anything. Keep its facets/decorations intact in that case. The live reference source
    // still updates, and typing an import immediately installs the latest snapshot.
    const sameDefinitions =
      previous.globals.variables === globals.variables &&
      previous.globals.titles === globals.titles &&
      previous.globals.type === globals.type;
    const importFree = !hasImportDependencies(value, globals);
    if (
      previous.lang === lang &&
      (previous.globals === globals || (sameDefinitions && importFree)) &&
      previous.readOnly === readOnly &&
      previous.requireEnglish === requireEnglish
    )
      return;
    configured.current = { lang, globals, readOnly, requireEnglish };
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
  }, [lang, globals, readOnly, requireEnglish, value, suspended]);

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
  }, [highlightLine, tooltipHash, lang]);

  const glyphCount = glyphs.reduce((sum, group) => sum + group.count, 0);
  const retiredCount = diagnostics.retired.length;
  // A panel for something that has gone away closes itself.
  const open =
    (panel === 'glyphs' && glyphCount === 0) ||
    (panel === 'conflicts' && conflictCount === 0) ||
    (panel === 'retired' && retiredCount === 0)
      ? null
      : panel;
  return (
    <div
      className={styles.editor}
      data-editor-root
      data-validation-pending={diagnostics.pending || undefined}
    >
      {markupRow && !readOnly && (
        <MarkupRow
          key={lang}
          view={view}
          globals={globals}
          usage={usage}
          rawView={symbols ? rawView : undefined}
          onRawView={flipRawView}
        />
      )}
      <div className={styles.textArea}>
        <div ref={host} className={styles.host} />
        {open === 'glyphs' && (
          <GlyphPanel
            groups={glyphs}
            value={value}
            readOnly={readOnly}
            onReplace={replaceGlyph}
            onClose={closeAndFocus}
          />
        )}
        {open === 'retired' && (
          <RetiredPanel
            value={value}
            readOnly={readOnly}
            onApply={applyRetired}
            onFixAll={fixAllRetiredMarkup}
            onClose={closeAndFocus}
          />
        )}
        {open === 'help' && <HelpPanel issues={issues} onClose={closeAndFocus} />}
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
            onClose={closeAndFocus}
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
      <CursorStatusBar
        validating={diagnostics.pending}
        readOnlyReason={readOnlyReason}
        issues={issues}
        glyphCount={glyphCount}
        retiredCount={retiredCount}
        cursor={cursor}
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
        // The markup row carries this toggle; the bar keeps it only while the row is not shown.
        rawView={symbols && !(markupRow && !readOnly) ? rawView : undefined}
        onRawView={flipRawView}
      />
    </div>
  );
}
