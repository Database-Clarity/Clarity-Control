import { LoadingSkeleton, useSkeletonVisible } from '../../ui/Skeleton';
import { offersBaseEnhanced, type ScopedMarkupGlobals } from './markupScope';
import { listDot } from './listDot';
import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  defaultKeymap,
  history,
  historyKeymap,
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
import { editorScrollMargins, entryTopScroll, keepParagraphInView } from './scrollMargins';
import { followKeyboard, visibleBand } from '../../ui/useKeyboardInset';
import { findWidgetExtension, findWidgetPanel, openReplace } from './findWidget';
import { globalFindExtension } from './globalFind/host';
import { rememberSearch, restoreSearch } from './searchMemory';
import { rawMode, setSymbolReveal, symbolExtensions, toggleRaw, toggleRawView } from './symbols';
import { hasImportDependencies, validationDiagnostics } from './diagnostics';
import { useEditorDiagnostics } from './useEditorDiagnostics';
import { useTooltipTerms } from '../terms/useTooltipTerms';
import { insertAtCaret } from '../terms/insert';
import { TermsPanel } from '../terms/TermsPanel';
import { RetiredPanel, retiredIn } from './RetiredPanel';
import { createCursorPosition } from './cursorPosition';
import { createTagSelectionStore, tagSelection } from './elementTags';
import { MarkupRow } from './markupRow/MarkupRow';
import { SuggestChip } from './markupRow/SuggestChip';
import { chipHost, chipsExtension, type Chip } from './markupRow/chips';
import { useSettingsStore, type SuggestAccept } from '../../stores/settings';
import {
  ConflictPanel,
  GlyphPanel,
  IssuesPanel,
  ParityPanel,
  CursorStatusBar,
  type PreviewStatus,
  type StatusPanel,
} from './StatusBar';
import { WorkingDiffPanel } from './WorkingDiffPanel';
import { fieldsChanged, textChanged, type WorkingDiffSource } from './workingDiff';
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
  takeSuggestion,
  type SuggestSnapshot,
} from './suggest/state';
import { helpIdForSuggestion } from './help/reference';
import type { UsageCorpus } from './suggest/usage';
import type { ReferenceSources } from './references';
import styles from './ClarityEditor.module.scss';

// The markup help is code only its first open needs. Once the editor has been input-quiet for a
// while, in idle time, the help loads, parses its examples, and builds its sheet hidden, so F1
// only reveals it. Any key or press restarts the wait; nothing runs on the typing path itself.
const loadHelp = () => import('./help/MarkupHelp');
const MarkupHelp = lazy(loadHelp);
const quietMs = 1500;
/** One parked sheet per page: the first editor to go quiet builds it. */
let helpParkClaimed = false;
function parkHelpWhenQuiet(ready: () => boolean, park: () => void): () => void {
  if (typeof requestIdleCallback !== 'function') return () => undefined;
  let lastInput = performance.now();
  let generation = 0;
  let timer = 0;
  let idle = 0;
  let stopped = false;
  const onInput = () => {
    lastInput = performance.now();
    generation += 1;
  };
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    if (idle) cancelIdleCallback(idle);
    removeEventListener('keydown', onInput, true);
    removeEventListener('pointerdown', onInput, true);
  };
  // Each step runs in its own idle period, and only while no input came since the wait began.
  const step = (mine: number, run: (deadline: IdleDeadline) => void) => {
    idle = requestIdleCallback((deadline) => {
      idle = 0;
      if (stopped) return;
      if (mine !== generation || !ready()) wait();
      else run(deadline);
    });
  };
  const wait = () => {
    const left = quietMs - (performance.now() - lastInput);
    timer = window.setTimeout(
      () => {
        if (performance.now() - lastInput < quietMs) return wait();
        const mine = generation;
        step(
          mine,
          () =>
            void loadHelp().then(
              ({ warmHelp }) => {
                if (stopped) return;
                // The examples parse over as many idle periods as they need, then the sheet builds.
                const warm = (deadline: IdleDeadline) => {
                  if (!warmHelp(deadline)) return step(mine, warm);
                  step(mine, () => {
                    if (helpParkClaimed) return stop();
                    helpParkClaimed = true;
                    stop();
                    park();
                  });
                };
                step(mine, warm);
              },
              () => stop(),
            ),
        );
      },
      Math.max(0, left),
    );
  };
  addEventListener('keydown', onInput, true);
  addEventListener('pointerdown', onInput, true);
  wait();
  return stop;
}

// Loading another saved/draft document must never call the authoring callback.
const documentLoad = Annotation.define<boolean>();
const noTagSelection = { kind: 'none' } as const;

export interface ClarityEditorProps {
  value: string;
  lang: Lang;
  onChange: (value: string) => void;
  globals: ScopedMarkupGlobals;
  readOnly?: boolean;
  pending?: boolean;
  requireEnglish?: boolean;
  highlightLine?: number;
  /** Declaration stepping keeps keyboard focus in the finder. */
  focusHighlight?: boolean;
  /** Why the text cannot be edited, shown in the status bar. */
  readOnlyReason?: string | null;
  /** The preview column's state, for the status bar (desktop page only). */
  preview?: PreviewStatus;
  /** Shows the markup row at the top of the editor (the page decides; Ctrl+. flips it). */
  markupRow?: boolean;
  /**
   * Read-only only for a moment (another tab changed the drafts; the page asks what to do): the
   * markup row stays, disabled, so the text below it never moves.
   */
  paused?: boolean;
  /**
   * The versions an open conflict started from, for Compare. Without them Compare still shows
   * mine and theirs from the marker block itself.
   */
  conflictSource?: CompareData;
  /**
   * The saved version and the work in progress, for the status bar's Changes view (Ctrl+K, D).
   * Without it (archive pages, stored forms) the bar has no Changes item.
   */
  workingDiff?: WorkingDiffSource;
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
  /**
   * The saved English text of this tooltip while translating: on a phone the docked markup bar
   * leads with the entries it uses. Undefined for English.
   */
  sourceText?: string;
  /**
   * Translate mode in a language the account may translate: the Terms list (in-game names for the
   * English's terms, Ctrl+K then G). The English pane shows the same terms as marks.
   */
  terms?: boolean;
}

/** The reference host's live getters, plus the English a translation is checked against. */
type EditorReferences = Omit<ReferenceHost, 'lang' | 'globals'> & {
  sourceText(): string | undefined;
};

function configuration(
  lang: Lang,
  globals: MarkupGlobals,
  readOnly: boolean,
  requireEnglish: boolean,
  references: EditorReferences,
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
    validationDiagnostics(
      lang,
      globals,
      requireEnglish,
      references.selfHash,
      references.sourceText,
    ),
    referenceExtensions({ ...references, lang, globals }),
    globalFindExtension({ ...references, lang, globals }),
  ];
}

export function ClarityEditor({
  value,
  lang,
  onChange,
  globals,
  readOnly = false,
  pending = false,
  requireEnglish = true,
  highlightLine,
  focusHighlight = true,
  readOnlyReason = null,
  preview,
  markupRow = false,
  paused = false,
  conflictSource,
  workingDiff,
  tooltipHash,
  referenceSources,
  onOpenTooltip,
  usage,
  symbols = true,
  findMemory = true,
  suspended = false,
  stepping = false,
  sourceText,
  terms: termsEnabled = false,
}: ClarityEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  // Held past `pending` until a painted skeleton has had its minimum (ui/Skeleton timing rule).
  const skeletonShown = useSkeletonVisible(pending, 'content', true);
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
  const textArea = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState<StatusPanel | null>(null);
  const panelOpen = useRef(false);
  panelOpen.current = panel !== null;
  const closePanel = useRef(() => setPanel(null));
  const closeAndFocus = () => setPanel(null);
  // The help row to open on, when F1 came over the Ctrl+Space menu; else the caret's markup.
  const [helpStart, setHelpStart] = useState<string | null>(null);
  const helpOpen = useRef(false);
  helpOpen.current = panel === 'help';
  /** F1: the help on the markup under the caret, or on the menu's highlighted option; again closes. */
  const toggleHelp = useRef((editor: EditorView) => {
    if (helpOpen.current) {
      setPanel(null);
      return true;
    }
    const option = takeSuggestion(editor);
    setHelpStart(option ? helpIdForSuggestion(option) : null);
    setPanel('help');
    return true;
  });
  const onPanel = useCallback((next: StatusPanel | null) => {
    setHelpStart(null);
    setPanel(next);
  }, []);
  // The help's sheet, built hidden once the editor is input-quiet (see parkHelpWhenQuiet).
  const [helpParked, setHelpParked] = useState(false);
  const parkedHere = useRef(false);
  // Read only by Insert: a change of globals while typing never re-renders the hidden sheet.
  const helpGlobals = useRef(globals);
  helpGlobals.current = globals;
  useEffect(() => {
    if (helpParked || suspended) return;
    return parkHelpWhenQuiet(
      () => view.current !== null,
      () => {
        parkedHere.current = true;
        startTransition(() => setHelpParked(true));
      },
    );
  }, [helpParked, suspended]);
  useEffect(
    () => () => {
      if (parkedHere.current) helpParkClaimed = false;
    },
    [],
  );
  // The Changes view. Closed, it costs one string comparison per render (is anything unsaved?);
  // the comparison itself runs only inside the open panel. The other fields keep their object
  // identity while typing, so they are compared again only when one of them is edited.
  const savedVersion = workingDiff?.saved;
  const workingVersion = workingDiff?.current;
  const otherFieldsChanged = useMemo(
    () =>
      fieldsChanged(
        {
          associated: savedVersion?.associated ?? [],
          custom: savedVersion?.custom,
          archive: savedVersion?.archive,
          compendium: savedVersion?.compendium,
        },
        {
          associated: workingVersion?.associated ?? [],
          custom: workingVersion?.custom,
          archive: workingVersion?.archive,
          compendium: workingVersion?.compendium,
        },
      ),
    [
      savedVersion?.associated,
      savedVersion?.custom,
      savedVersion?.archive,
      savedVersion?.compendium,
      workingVersion?.associated,
      workingVersion?.custom,
      workingVersion?.archive,
      workingVersion?.compendium,
    ],
  );
  const changed =
    savedVersion !== undefined &&
    workingVersion !== undefined &&
    savedVersion !== workingVersion &&
    (textChanged(savedVersion, workingVersion, lang) || otherFieldsChanged);
  const diffLive = useRef({ panel, changed, available: workingDiff !== undefined });
  diffLive.current = { panel, changed, available: workingDiff !== undefined };
  /** Ctrl+K, D: the same as the bar's Changes item (which does nothing while nothing changed). */
  const toggleDiff = useRef(() => {
    const now = diffLive.current;
    if (!now.available) return false;
    if (now.panel === 'diff') setPanel(null);
    else if (now.changed) setPanel('diff');
    return true;
  });
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
  const [tagMode] = useState(createTagSelectionStore);
  const parityText = lang === 'en' ? undefined : sourceText;
  const termsOn = termsEnabled && lang !== 'en';
  const tooltipTerms = useTooltipTerms(lang, termsOn && !suspended && !stepping, parityText);
  // One object per change: the status bar is memoised, and a fresh object on every render would
  // re-render it on every key.
  const termsCount = tooltipTerms.terms.length;
  const termsStatus = useMemo(
    () => (termsOn ? { count: termsCount, loading: tooltipTerms.loading } : undefined),
    [termsOn, termsCount, tooltipTerms.loading],
  );
  const termsLive = useRef(termsOn);
  termsLive.current = termsOn;
  /** Ctrl+K, G: the same as the bar's Terms item. */
  const toggleTerms = useRef(() => {
    if (!termsLive.current) return false;
    setPanel((current) => (current === 'terms' ? null : 'terms'));
    return true;
  });
  const insertTerm = useCallback((text: string) => {
    setPanel(null);
    if (view.current) insertAtCaret(view.current, text);
  }, []);
  const referenceLive = useRef({ tooltipHash, referenceSources, onOpenTooltip, parityText });
  const references = useRef<EditorReferences>({
    sources: () => referenceLive.current.referenceSources,
    selfHash: () => referenceLive.current.tooltipHash,
    navigate: () => referenceLive.current.onOpenTooltip,
    sourceText: () => referenceLive.current.parityText,
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
      sourceText: parityText,
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
  // The markup row shows when the page opens it and the text can be edited, or is paused for a
  // moment (then disabled, never removed: the text must not jump); on a phone it docks on the
  // keyboard as a bar (Suggest moves into it, Raw to the status bar).
  const rowShown = markupRow && (!readOnly || pending || paused);
  const phone = useMedia(phoneQuery);
  const docked = phone && rowShown;
  // Read by the document load, which must not run again when only the screen size changes.
  const pageScrolls = useRef(phone);
  pageScrolls.current = phone;
  const suggestHere = useCallback(() => {
    if (view.current) openSuggest(view.current);
  }, []);
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
    // Stepping to another entry closes the Changes view at the first step, so it never shows
    // the previous entry's changes beside a new entry's name. Closed, this does nothing.
    if (stepping && diffLive.current.panel === 'diff') setPanel(null);
  }, [stepping]);
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
    referenceLive.current = { tooltipHash, referenceSources, onOpenTooltip, parityText };
  }, [tooltipHash, referenceSources, onOpenTooltip, parityText]);
  useEffect(() => {
    if (suspended || view.current || !host.current) return;
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
      listDot,
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
        // VS Code's "Compare with Saved". Ctrl may stay held for the D, as with Ctrl+K Ctrl+I.
        { key: 'Mod-k d', run: () => toggleDiff.current() },
        { key: 'Mod-k Mod-d', run: () => toggleDiff.current() },
        { key: 'Mod-k g', run: () => toggleTerms.current() },
        { key: 'Mod-k Mod-g', run: () => toggleTerms.current() },
        { key: 'F1', run: (editor) => toggleHelp.current(editor), preventDefault: true },
        { key: 'Mod-/', run: toggleComment },
        { key: 'Mod-h', run: openReplace, scope: 'editor search-panel', preventDefault: true },
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        // A bare Tab does nothing: focus stays in the text (snippet blanks and chips take Tab
        // first, at a higher precedence). Esc, then Tab still leaves: CodeMirror lets that Tab
        // through to the page without consulting the keymap.
        { key: 'Tab', run: () => true, shift: () => true, preventDefault: true },
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
          // The markup row's "Tag selection:" mode; nothing to judge while nothing is selected.
          tagMode.set(
            update.state.selection.ranges.every((range) => range.empty)
              ? noTagSelection
              : tagSelection(update.state, configured.current.globals),
          );
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
  }, [cursor, tagMode, suspended]);
  useEffect(
    () => () => {
      view.current?.destroy();
      view.current = null;
    },
    [],
  );
  // The keyboard opening (a phone) keeps the caret's paragraph in view (ui/useKeyboardInset.ts).
  useEffect(() => {
    const editor = view.current;
    if (suspended || !editor) return;
    return followKeyboard(editor.dom, () => keepParagraphInView(editor, visibleBand()));
  }, [suspended]);

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
          effects: pageScrolls.current
            ? entryTopScroll(editor)
            : EditorView.scrollIntoView(0, { y: 'start' }),
          annotations: Transaction.addToHistory.of(false),
        });
      return;
    }
    if (switched) {
      // The markup help is about markup, not this text: stepping on leaves it open, untouched.
      setPanel((now) => (now === 'help' ? now : null));
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
        // On a phone the page scrolls, not the editor: "start" would scroll the page until the
        // first line meets the top of the screen, under the sticky header and tabs, with the
        // editor's own tools above it (entryTopScroll keeps them in view).
        ...(!stepping || scrolled.current
          ? [
              pageScrolls.current
                ? entryTopScroll(editor)
                : EditorView.scrollIntoView(0, { y: 'start' }),
            ]
          : []),
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
      previous.globals.type === globals.type &&
      offersBaseEnhanced(previous.globals) === offersBaseEnhanced(globals);
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
    if (focusHighlight) editor.focus();
  }, [highlightLine, tooltipHash, lang, focusHighlight]);

  const glyphCount = glyphs.reduce((sum, group) => sum + group.count, 0);
  const retiredCount = diagnostics.retired.length;
  const parityCount = diagnostics.parity.length;
  // A panel for something that has gone away closes itself.
  // The issues panel closes for good at zero issues (a later issue never reopens it over the text);
  // focus it held goes back to the text.
  useLayoutEffect(() => {
    if (panel !== 'issues' || issues.length) return;
    setPanel(null);
    const page = globalThis.document;
    if (page.activeElement === page.body) view.current?.focus();
  }, [panel, issues.length]);
  const open =
    (panel === 'glyphs' && glyphCount === 0) ||
    (panel === 'conflicts' && conflictCount === 0) ||
    (panel === 'retired' && retiredCount === 0) ||
    (panel === 'parity' && parityCount === 0) ||
    (panel === 'terms' && (!termsOn || tooltipTerms.terms.length === 0)) ||
    (panel === 'issues' && issues.length === 0)
      ? null
      : panel;
  // The open Changes view covers the bottom of the text. While it is open the text gets that
  // much room below its last line, so the end can always be scrolled, and typed, clear of the
  // view (the scroll margins need somewhere to scroll to). Opening moves no visible text; closed,
  // there is no room and no observer.
  const diffOpen = open === 'diff' && workingDiff !== undefined;
  useLayoutEffect(() => {
    const area = textArea.current;
    const cover = area?.querySelector<HTMLElement>('[data-editor-overlay][data-headed]');
    if (!diffOpen || !area || !cover) return;
    // Where the page scrolls and the editor is as tall as its text (a phone), the room would
    // push the bar and the view down the page instead. There the text area grows no taller than
    // it was for as long as the view is open, and the text scrolls inside it. Only a limit, never
    // a fixed height: a text made shorter still takes the bar and the view up with it.
    const height = area.getBoundingClientRect().height;
    let room: number | undefined;
    const fit = () => {
      const grew = room !== undefined && cover.offsetHeight > room;
      room = cover.offsetHeight;
      area.style.setProperty('--overlay-room', `${room}px`);
      if (!area.style.maxHeight && area.getBoundingClientRect().height > height + 0.5)
        area.style.maxHeight = `${height}px`;
      const editor = view.current;
      if (!editor) return;
      editor.requestMeasure();
      // The view grew while open (a longer comparison arrived once typing paused) and now covers
      // the caret: bring the caret back above it. Never on opening, which moves nothing.
      if (!grew || !editor.hasFocus) return;
      const head = editor.state.selection.main.head;
      const caret = editor.coordsAtPos(head);
      if (caret && caret.bottom > cover.getBoundingClientRect().top)
        editor.dispatch({ effects: EditorView.scrollIntoView(head) });
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(cover);
    return () => {
      observer?.disconnect();
      area.style.removeProperty('--overlay-room');
      area.style.removeProperty('max-height');
      view.current?.requestMeasure();
    };
  }, [diffOpen]);
  return (
    <div
      className={styles.editor}
      {...(pending || skeletonShown ? { inert: '' } : {})}
      data-editor-root
      data-docked={docked || undefined}
      data-validation-pending={diagnostics.pending || undefined}
    >
      {rowShown && (
        <MarkupRow
          key={lang}
          view={view}
          globals={globals}
          usage={usage}
          rawView={symbols && !docked ? rawView : undefined}
          onRawView={flipRawView}
          docked={docked}
          disabled={readOnly && !pending}
          onSuggest={docked ? suggestHere : undefined}
          sourceText={lang === 'en' ? undefined : sourceText}
          tagSelection={tagMode}
        />
      )}
      <div ref={textArea} className={styles.textArea}>
        <div ref={host} className={styles.host} />
        {(pending || skeletonShown) && (
          <div className={styles.loadingContent}>
            <LoadingSkeleton label="Loading editor text…" count={12} visible={skeletonShown} />
          </div>
        )}
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
        {open === 'issues' && <IssuesPanel issues={issues} onClose={closeAndFocus} />}
        {open === 'parity' && <ParityPanel gaps={diagnostics.parity} onClose={closeAndFocus} />}
        {open === 'terms' && (
          <TermsPanel
            key={`${tooltipHash}:${lang}`}
            terms={tooltipTerms.terms}
            lang={lang}
            canInsert={!readOnly}
            onInsert={insertTerm}
            onClose={closeAndFocus}
          />
        )}
        {(open === 'help' || helpParked) && (
          <Suspense fallback={null}>
            <MarkupHelp
              open={open === 'help'}
              view={view}
              globals={helpGlobals}
              readOnly={readOnly}
              start={helpStart}
              onClose={closePanel.current}
            />
          </Suspense>
        )}
        {open === 'diff' && workingDiff && (
          <WorkingDiffPanel
            key={`${tooltipHash}:${lang}`}
            source={workingDiff}
            lang={lang}
            onClose={closeAndFocus}
          />
        )}
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
        parityCount={parityCount}
        terms={termsStatus}
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
        changes={workingDiff ? changed : undefined}
        panel={open}
        onPanel={onPanel}
        // The docked bar carries Suggest; the status bar keeps it otherwise.
        onSuggest={readOnly || docked ? undefined : suggestHere}
        // The markup row carries this toggle; the bar keeps it while the row is not shown or docked.
        rawView={symbols && (!rowShown || docked) ? rawView : undefined}
        onRawView={flipRawView}
      />
    </div>
  );
}
