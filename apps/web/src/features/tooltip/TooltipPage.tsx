import { SkeletonBoundary } from '../../ui/Skeleton';
import { loadingWorkspace } from './TooltipLoadingWorkspace';
import type { ScopedMarkupGlobals } from '../editor/markupScope';
import { useGlobalDefinition } from '../globals/useGlobals';
import { GlobalUsages, GlobalUsageCount } from '../globals/GlobalsPage';
import { archiveCategoryLabel, archivedItemFor } from '../archive/archive';
import { AttachmentCategoryControl } from './AttachmentCategoryControl';
import { useCompendiumStore } from '../compendium/store';
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { isolateHistory } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { translationQueue, type Lang, type MarkupGlobals, type Tooltip } from '@clarity/core';
import { apiUrl } from '../../services/api';
import { tooltipImports } from '../../services/tooltipImports';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { usePausedForOtherTab, useConflictStore } from '../../stores/conflicts';
import { ConflictRows } from '../conflicts/ConflictRows';
import { previewDrafts } from '../conflicts/previewDrafts';
import { theirsLabel } from '../conflicts/rebase';
import type { CompareData } from '../conflicts/CompareView';
import { useAuthStore } from '../../stores/auth';
import {
  canonicalHash,
  classifiedCategory,
  editorName,
  previewPiece,
  sharedPerkLabel,
  singleOwnerLabel,
  tooltipFor,
  variantHashes,
} from '../navigation/catalog';
import { tooltipPath } from '../navigation/stepping';
import { ShellSlot } from '../navigation/ShellSlots';
import { useShellColumn } from '../navigation/ShellColumnContext';
import { usePreviewReviewStore } from '../../stores/previewReview';
import { ClarityEditor } from '../editor';
import { useMarkupRow } from '../editor/markupRow/useMarkupRow';
import { tooltipTextSources } from '../editor/references';
import { corpusUsage } from '../editor/suggest/usage';
import type { TooltipTarget } from '../editor/referenceActions';
import { PreviewColumn, type EnhancedView } from '../preview';
import { effectiveMode, previewedHashes, type PreviewMode } from '../preview/previewMode';
import { useAcknowledgePreview } from '../navigation/useAcknowledgePreview';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import { HistoryPanel } from '../history/HistoryPanel';
import { useSaveState } from '../../services/save/state';
import { AssociationsPanel } from '../associations/AssociationsPanel';
import { ManifestTextRow } from '../manifest/ManifestTextRow';
import { PanelRow } from '../../ui/PanelRow';
import { languageLabel } from '../../languageLabels';
import { editorAccess } from './access';
import { canPushLive } from '../auth/permissions';
import { DraftLoader, WithEditorDraft } from './DraftLoader';
import { defaultLanguage, withLanguage } from './language';
import { requireEnglish } from './requireEnglish';
import { LanguageSummary } from './LanguageSummary';
import { EditorPaneHeader } from './EditorPaneHeader';
import { QueueControl } from './QueueControl';
import { WorkThroughControl, leaveTarget } from '../queue/QueueControl';
import { queueSources } from '../queue/sources';
import { useWorkQueues } from '../queue/store';
import { useWorkThrough } from '../queue/useQueue';
import { queueContext, queuePath, queueSummary } from '../translations/worklist';
import { englishDiffFor } from '../translations/source';
import { categoryDisplay } from '../../services/categoryLabels';
import { TranslationSource } from './TranslationSource';
import { VariantWorkspace } from './VariantWorkspace';
import { CompendiumPanel } from '../compendium/CompendiumPanel';
import {
  categoriesWithEnhanced,
  editableOverrides,
  enhancedRender,
  previewedVariants,
} from './variants';
import { groupedPerks } from './grouping';
import styles from './TooltipPage.module.scss';
import {
  recordSteppingWorkspaceWork,
  settleStepping,
  useSteppingActivity,
} from '../navigation/steppingActivity';
import { LivePreviewIdentity, previewIdentityFor } from '../preview/LivePreviewIdentity';
import { ReportsPane } from '../reports/pane/ReportsPane';
import {
  openCount,
  reportLanguages,
  seesReports,
  useReportsIndex,
  useReportsIndexLoader,
} from '../reports/pane/indexStore';

interface WorkspaceRoute {
  parameter?: string;
  search: URLSearchParams;
  /** The history entry's state: queue mode lives there (see translations/worklist). */
  state: unknown;
  setSearch: ReturnType<typeof useSearchParams>[1];
  navigate: ReturnType<typeof useNavigate>;
}
const StableWorkspace = memo(TooltipWorkspace);

/**
 * The editor page (variant model D): ONE base editor per item, whatever the role. Enhanced
 * versions are derived from the base text and shown in the preview; the few that keep text of
 * their own open in the same editor slot through "Edit override" (the base editor stays mounted
 * underneath, so its caret and undo history survive the round trip).
 */
export function TooltipPage({
  hashOverride,
  readOnly = false,
}: {
  hashOverride?: number;
  readOnly?: boolean;
}) {
  const active = useSteppingActivity((state) => state.active);
  const deferWorkspace = useSteppingActivity((state) => state.deferWorkspace);
  const urgentTarget = useSteppingActivity((state) => state.target);
  const { hash: parameter } = useParams();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const { state } = useLocation();
  const data = useDataStore((state) => state.data);
  const hydrated = useDraftStore((state) => state.hydrated);
  const draftError = useDraftStore((state) => state.error);
  const dataError = useDataStore((state) => state.error);
  const stepping = active && hashOverride === undefined;
  const targetHash =
    hashOverride === undefined && urgentTarget
      ? Number(urgentTarget.split('/')[2].split('?')[0])
      : undefined;
  const current = useMemo(
    () => ({ parameter, search, state, setSearch, navigate }),
    [parameter, search, state, setSearch, navigate],
  );
  const paintedRoute = useRef(current);
  const route =
    (stepping && deferWorkspace) || (targetHash !== undefined && targetHash !== Number(parameter))
      ? paintedRoute.current
      : current;
  useLayoutEffect(() => {
    paintedRoute.current = route;
  }, [route]);
  const catchUp = (target: EventTarget) => {
    if (
      (active || urgentTarget) &&
      target instanceof Element &&
      target.closest(
        '.cm-editor, section[aria-label*=" editor ("], section[aria-label^="Associations for "]',
      )
    )
      flushSync(settleStepping);
  };
  // Identity lands each frame. Route and document work can coalesce behind it,
  // and interaction synchronously catches up before the editor handles input.
  const hash =
    data && !readOnly
      ? canonicalHash(hashOverride ?? Number(route.parameter), data)
      : (hashOverride ?? Number(route.parameter));
  // Keep the workspace context stable while its document is retained. The
  // header leaf subscribes to urgent targets without propagating through it.
  const globalName = [1, 2, 3].includes(hash) ? route.search.get('global') : null;
  const identity = useMemo(() => {
    const identity = previewIdentityFor(hash, data, readOnly);
    return globalName
      ? {
          ...identity,
          name: globalName,
          categoryLabel: hash === 2 ? 'Variables' : hash === 3 ? 'Titles' : 'Exports',
        }
      : identity;
  }, [hash, data, readOnly, globalName]);
  return (
    <LivePreviewIdentity.Provider value={identity}>
      <article
        className={styles.page}
        aria-busy={
          route !== current ||
          (targetHash !== undefined && targetHash !== Number(route.parameter)) ||
          undefined
        }
        onFocusCapture={active || urgentTarget ? (event) => catchUp(event.target) : undefined}
        onPointerDownCapture={active || urgentTarget ? (event) => catchUp(event.target) : undefined}
        onKeyDownCapture={active || urgentTarget ? (event) => catchUp(event.target) : undefined}
        onBeforeInputCapture={active || urgentTarget ? (event) => catchUp(event.target) : undefined}
        onCompositionStartCapture={
          active || urgentTarget ? (event) => catchUp(event.target) : undefined
        }
      >
        <SkeletonBoundary
          pending={!data || (!hydrated && !draftError)}
          error={!!dataError}
          identity={hash}
          label="Loading tooltip content…"
          shape="none"
        >
          {(loading) => (
            <StableWorkspace
              loading={loading}
              hashOverride={hashOverride}
              readOnly={readOnly}
              route={route}
              suspended={stepping}
            />
          )}
        </SkeletonBoundary>
      </article>
    </LivePreviewIdentity.Provider>
  );
}

function TooltipWorkspace({
  loading,
  hashOverride,
  readOnly = false,
  route,
  suspended,
}: {
  loading: boolean;
  hashOverride?: number;
  readOnly?: boolean;
  route: WorkspaceRoute;
  suspended: boolean;
}) {
  const renderStarted = performance.now();
  const committedRoute = useRef(route);
  useLayoutEffect(() => {
    if (committedRoute.current !== route)
      recordSteppingWorkspaceWork(performance.now() - renderStarted);
    committedRoute.current = route;
  });
  const compendiumSource = useCompendiumStore((state) => state.data);
  const { parameter, search, state: routeState, setSearch, navigate } = route;
  const data = useDataStore((state) => state.data);
  const [remembered, setRemembered] = useState<Lang>();
  // The enhanced version whose own text is open in the editor (null: the base). Keyed by item and
  // by the link's own `variant`, so moving to another tooltip starts on its base, and a link to
  // an override (the queue's Next, Back, Forward) opens what it names.
  const [picked, setPicked] = useState<{ hash: number; at: string; variant: number | null }>();
  // The preview column's view (null: Compare on a desktop, Enhanced on a phone) and, when an item
  // has several enhanced versions, which one. Both are working choices, never saved.
  const [previewMode, setPreviewMode] = useState<PreviewMode | null>(null);
  const [previewPick, setPreviewPick] = useState<{ hash: number; variant: number }>();
  const [previewPainted, setPreviewPainted] = useState(hashOverride ?? Number(parameter));
  const onPreviewVariant = useCallback(
    (variant: number) => setPreviewPick({ hash: hashOverride ?? Number(parameter), variant }),
    [hashOverride, parameter],
  );
  const phone = useMedia(phoneQuery);
  const markupRow = useMarkupRow();
  const user = useAuthStore((state) => state.user);
  const lang = defaultLanguage(user, search, remembered);
  // Queue mode: the Translations view this tooltip was opened from. Never on an archive page.
  const queue = useMemo(
    () => (hashOverride === undefined ? queueContext(search, routeState, user) : null),
    [hashOverride, search, routeState, user],
  );
  // A work-through queue (Bungie drift, Lost text): active when the history entry names it,
  // paused on an ordinary editor visit while the tab works through one. An embedded page (the
  // Archive's detail) shows its queue in its own top row instead.
  const workThrough = useWorkThrough(routeState, hashOverride === undefined);
  const work = !queue && hashOverride === undefined ? workThrough : null;
  const endWork = useWorkQueues((state) => state.end);
  function changeLanguage(next: Lang) {
    setRemembered(next);
    setSearch(withLanguage(search, next));
  }
  const selectedGlobal = useGlobalDefinition(
    hashOverride ?? Number(parameter),
    [1, 2, 3].includes(hashOverride ?? Number(parameter)) ? search.get('global') : null,
  );
  const highlightLine = selectedGlobal ? selectedGlobal.lines[lang] : Number(search.get('line'));
  const drafts = useDraftStore((state) => state.drafts);
  // Previews, shared globals and references see "mine" where conflict blocks remain in a draft.
  const shown = useMemo(() => previewDrafts(drafts), [drafts]);
  const sessions = useConflictStore((state) => state.sessions);
  const pausedForOtherTab = usePausedForOtherTab();
  const edit = useDraftStore((state) => state.edit);
  const discard = useDraftStore((state) => state.discard);
  const hydrated = useDraftStore((state) => state.hydrated);
  const saving = useSaveState((state) => state.locked);
  const sharedGlobals = useMemo<MarkupGlobals>(() => {
    const imports = tooltipImports(data?.bundle.tooltips ?? {}, shown, lang, data?.aliases ?? {});
    return { variables: imports[2] ?? '', titles: imports[3] ?? '', imports };
  }, [data, shown, lang]);
  // One globals object per type, so renders that share a type share the object (and its parse).
  const typedGlobals = useMemo(() => {
    const cache = new Map<string, ScopedMarkupGlobals>();
    return (type: string | undefined, allowBaseEnhanced: boolean) => {
      const key = `${type}:${allowBaseEnhanced}`;
      let globals = cache.get(key);
      if (!globals) cache.set(key, (globals = { ...sharedGlobals, type, allowBaseEnhanced }));
      return globals;
    };
  }, [sharedGlobals]);
  const referenceSources = useMemo(
    () => tooltipTextSources(data?.bundle.tooltips ?? {}, shown, data?.aliases ?? {}),
    [data, shown],
  );
  // Saved text only, so the suggestion menu's usage counts do not change as you type.
  const usage = useMemo(() => corpusUsage(data?.bundle.tooltips ?? {}), [data?.bundle.tooltips]);
  // Reports: the tab label is a lookup in the session's marker index (no request per tooltip).
  useReportsIndexLoader();
  const reportIndex = useReportsIndex((state) => state.open);
  const previewHost = useRef<HTMLDivElement>(null);
  function openDefinition(target: TooltipTarget) {
    // Ordinary navigation (a pushed history entry), the same route a Globals page link takes.
    const canonical = data ? canonicalHash(target.hash, data) : target.hash;
    navigate(`/t/${canonical}?lang=${target.lang}&line=${target.line}&variant=${target.hash}`);
  }
  // With a left column beside the page (desktop shell) the preview, associations and history are
  // shown there; without one (a phone, or the page on its own) they stay inline in the page.
  const column = useShellColumn();
  const showPreview = column?.show;
  // "Show preview" from the leave guard opens the column. A view that already shows the unseen
  // edits (Base, Enhanced, or Compare, which shows both) is left as it is; otherwise it moves to
  // Base, or to Enhanced for an override with unseen edits.
  const reveal = useRef<() => void>(undefined);
  useEffect(() => {
    if (!showPreview) return;
    return usePreviewReviewStore.getState().registerHost({
      show() {
        showPreview();
        reveal.current?.();
      },
    });
  }, [showPreview]);
  if (!data) {
    if (!loading) return null;
    const frame = loadingWorkspace({
      hash: hashOverride ?? Number(parameter),
      lang,
      column,
      user,
      markup: markupRow,
      readOnly,
    });
    // Keep the real VariantWorkspace at the same child position across readiness.
    return (
      <>
        {false}
        <h1 className={styles.srOnly}>Tooltip {hashOverride ?? Number(parameter)}</h1>
        {frame.workspace}
        {frame.left}
      </>
    );
  }
  if (
    hashOverride === undefined &&
    (!parameter || !/^(0|[1-9]\d*)$/.test(parameter) || Number(parameter) > 0xffffffff)
  ) {
    return <h1>Invalid tooltip hash</h1>;
  }
  const requestedHash = hashOverride ?? Number(parameter);
  const canonical = canonicalHash(requestedHash, data);
  const hash = readOnly ? requestedHash : canonical;
  const item = archivedItemFor(hash, data);
  if (!item && !data.bundle.tooltips[hash])
    return queue || work?.mode === 'active' ? (
      // A queued entry that no longer exists: say so, and keep the way on.
      <p className={styles.queueGone} role="status">
        <span>Tooltip {hash} is no longer available.</span>
        {queue ? <QueueControl hash={hash} context={queue} /> : <WorkThroughControl work={work!} />}
      </p>
    ) : (
      <h1>Tooltip {hash} not found</h1>
    );
  const primaryBase = tooltipFor(hash, data);
  readOnly ||= hash > 3 && !data.items[hash] && !primaryBase.custom;
  const access = editorAccess({
    apiConfigured: Boolean(apiUrl),
    hydrated,
    saving,
    user,
    lang,
  });
  if (readOnly || (!item && hash > 3)) access.reason = 'Archived tooltip — read only';
  else if (pausedForOtherTab && !access.reason)
    access.reason = 'Paused: another tab changed your drafts. Answer the notice above.';

  // A phone's header row would grow for the pause sentence and push the text down; the status bar
  // (fixed height) already says it there.
  // Only the other-tab pause: an archived or loading text has no markup row to keep.
  const pausedForOther =
    !loading && pausedForOtherTab && access.reason?.startsWith('Paused:') === true;
  const pausedOnPhone = phone && pausedForOther;
  const hosted = column !== null;
  const nameOf = (variant: number) => archivedItemFor(variant, data)?.name ?? `Tooltip ${variant}`;
  const legacyOf = (variant: number) =>
    data.categories.find((category) => category.id === archivedItemFor(variant, data)?.categoryId)
      ?.legacyType;
  const globalsFor = (variant: number): ScopedMarkupGlobals =>
    typedGlobals(
      legacyOf(variant),
      categoriesWithEnhanced(data).has(
        data.items[variant]?.categoryId ?? archivedItemFor(variant, data)?.categoryId ?? '',
      ),
    );
  const textOf = (variant: number) =>
    (drafts[variant]?.next ?? tooltipFor(variant, data)).text[lang]?.text ?? '';
  // The base is the one the draft started from (as in save validation), not the live catalogue.
  const requiresEnglish = (variant: number) =>
    requireEnglish(
      hash,
      lang,
      (drafts[variant]?.base ?? tooltipFor(variant, data)).text.en?.text ?? '',
      textOf(variant),
    );
  // What the preview renders: the same text with conflict blocks resolved to "mine".
  const previewTextOf = (variant: number) =>
    (shown[variant]?.next ?? tooltipFor(variant, data)).text[lang]?.text ?? '';
  /** The three versions an open conflict started from, for the editor's Compare view. */
  const conflictSourceOf = (variant: number): CompareData | undefined => {
    const session = sessions[variant];
    if (!session) return undefined;
    const theirs = session.head?.text[lang];
    return {
      mine: session.mine.text[lang]?.text ?? '',
      base: session.base ? (session.base.text[lang]?.text ?? '') : null,
      theirs: theirs?.text ?? '',
      theirsLabel: theirsLabel(theirs),
    };
  };

  // Enhanced versions: previewed next to the base; the ones with text of their own can be opened.
  const others = variantHashes(hash, data).filter((variant) => variant !== hash);
  const previewed = readOnly ? others : previewedVariants(hash, data);
  const overrides = readOnly ? [] : editableOverrides(hash, data);
  const grouped = !readOnly && user?.role === 'maintainer' ? groupedPerks(hash, data) : undefined;
  // A canonical redirect drops line/variant highlights, just like tooltipPath.
  const requested = requestedHash === hash ? Number(search.get('variant')) : NaN;
  const pickedAt = search.get('variant') ?? '';
  const pick = picked?.hash === hash && picked.at === pickedAt ? picked : undefined;
  // A pick made on another tooltip or under another link is over; it must not come back with it.
  if (picked && !pick) setPicked(undefined);
  const activeVariant = pick ? pick.variant : overrides.includes(requested) ? requested : null;
  const activeHash = activeVariant ?? hash;
  const activeBase = tooltipFor(activeHash, data);
  const activeTooltip = drafts[activeHash]?.next ?? activeBase;
  const value = previewTextOf(hash);

  const enhancedViews: EnhancedView[] = previewed.map((variant) => {
    // Derived versions render the base text (drafts included) as their own type; overrides and
    // archived tooltips show the text they hold.
    const rendered = readOnly ? undefined : enhancedRender(hash, variant, lang, data, shown);
    return {
      hash: variant,
      name: nameOf(variant),
      text: rendered ? rendered.text : previewTextOf(variant),
      globals: globalsFor(variant),
      derived: rendered?.form === 'derived',
    };
  });
  const baseEntry = archivedItemFor(hash, data);
  const heading = baseEntry ? editorName(baseEntry) : nameOf(hash);
  const baseCategory = classifiedCategory(baseEntry, data);
  const pickedVariant = previewPick?.hash === hash ? previewPick.variant : undefined;
  const selectedView =
    enhancedViews.find((view) => view.hash === pickedVariant) ?? enhancedViews[0];
  const mode = effectiveMode(previewMode, phone, selectedView !== undefined);
  reveal.current = () => {
    const unseen = usePreviewReviewStore.getState().unreviewed(canonical);
    const shownNow = previewedHashes(mode, hash, selectedView);
    if (unseen.every((variant) => shownNow.includes(variant))) return;
    const override = enhancedViews.find((view) => !view.derived && unseen.includes(view.hash));
    if (override && !unseen.includes(hash)) {
      setPreviewPick({ hash, variant: override.hash });
      setPreviewMode('enhanced');
    } else setPreviewMode('base');
  };
  // A deferred preview acknowledges text only after that version actually commits.
  const seen = column
    ? previewedHashes(mode, hash, selectedView).map((variant) => (
        <PreviewAck key={variant} variant={variant} visible={!column.collapsed && !suspended} />
      ))
    : null;
  const previews = (
    <PreviewColumn
      hash={hash}
      lang={lang}
      name={selectedGlobal?.name ?? nameOf(hash)}
      piece={baseEntry && previewPiece(baseEntry)}
      icon={baseEntry?.icon || undefined}
      categoryLabel={
        readOnly && baseEntry
          ? archiveCategoryLabel(baseEntry.categoryId, data)
          : (baseCategory?.label ?? baseEntry?.categoryId)
      }
      archiveIcon={readOnly}
      baseText={
        selectedGlobal
          ? selectedGlobal.definitions[lang] === undefined
            ? ''
            : selectedGlobal.kind === 'variables'
              ? `#${selectedGlobal.name}`
              : selectedGlobal.kind === 'titles'
                ? `<title ${selectedGlobal.name} [${selectedGlobal.name}] />`
                : `import ${selectedGlobal.name} from global`
          : value
      }
      baseGlobals={globalsFor(hash)}
      enhanced={enhancedViews}
      mode={mode}
      onMode={setPreviewMode}
      variant={selectedView?.hash}
      onVariant={onPreviewVariant}
      acknowledgement={seen}
      stepping={suspended}
      onDocumentPaint={setPreviewPainted}
      loadingContent={loading}
    />
  );

  const owner = singleOwnerLabel(hash, data);
  const shared = sharedPerkLabel(hash, data, compendiumSource);
  const rows = (
    <div className={styles.rows}>
      {!readOnly && (
        <>
          <ConflictRows hash={hash} lang={lang} onLanguage={changeLanguage} />
          {activeHash !== hash && (
            <ConflictRows hash={activeHash} lang={lang} onLanguage={changeLanguage} />
          )}
        </>
      )}
      {!readOnly && item && <AttachmentCategoryControl base={primaryBase} item={item} />}
      {owner && <NoteRow text={owner} />}
      {shared && <NoteRow text={shared} />}
      <ManifestTextRow hash={activeHash} />
      {!readOnly && <AssociationsPanel hash={activeHash} suspended={suspended} />}
      <HistoryPanel
        language={lang}
        hash={activeHash}
        readOnly={readOnly}
        suspended={suspended}
        attribution={
          <LanguageSummary
            base={activeBase}
            lang={lang}
            draft={activeTooltip.text[lang]?.text !== activeBase.text[lang]?.text}
            plain
          />
        }
      />
    </div>
  );

  // The editor's status bar tells how many edits the preview has not shown yet, and offers it.
  const previewStatus = column
    ? {
        review: {
          canonical,
          scheduled: previewedHashes(mode, hash, selectedView),
          visible: !column.collapsed && !suspended,
        },
        collapsed: column.collapsed,
        onShow: () => {
          const host = usePreviewReviewStore.getState().host;
          if (host) host.show();
          else column.show();
        },
      }
    : undefined;
  const translation = translationQueue([activeBase], [lang], data.aliases)[0];
  const compendiumPane = selectedGlobal ? (
    <GlobalUsages hash={selectedGlobal.hash} name={selectedGlobal.name} />
  ) : !readOnly && user?.role !== 'translator' ? (
    <SteppingCompendium
      base={activeBase}
      active={suspended || loading}
      ready={!loading && previewPainted === hash}
    />
  ) : null;
  // Roles that may see reports, in a language they may read, beside another side pane (the tab
  // shares the right pane; it never takes a pane of its own).
  const reportsShown =
    !readOnly &&
    !selectedGlobal &&
    hash > 3 &&
    seesReports(user) &&
    (reportLanguages(user)?.includes(lang) ?? true) &&
    (lang !== 'en' || compendiumPane !== null);
  const reports =
    reportsShown && user
      ? {
          count: openCount(reportIndex, hash, lang),
          pane: (
            <ReportsPane
              hash={hash}
              lang={lang}
              user={user}
              text={value}
              globals={globalsFor(hash)}
              variants={enhancedViews}
              previewHost={previewHost}
              suspended={suspended}
              ready={previewPainted === hash}
            />
          ),
        }
      : undefined;
  const overrideTargets = overrides.map((variant) => ({ hash: variant, name: nameOf(variant) }));
  const editing = (variant: number, base: Tooltip) => (
    <ClarityEditor
      pending={loading}
      stepping={suspended && !selectedGlobal}
      focusHighlight={!selectedGlobal}
      value={textOf(variant)}
      lang={lang}
      globals={globalsFor(variant)}
      requireEnglish={requiresEnglish(variant)}
      readOnly={loading || access.reason !== null}
      readOnlyReason={access.reason}
      preview={previewStatus}
      tooltipHash={variant}
      referenceSources={referenceSources}
      usage={usage}
      onOpenTooltip={openDefinition}
      markupRow={markupRow.open}
      paused={pausedForOther}
      sourceText={lang === 'en' ? undefined : base.text.en?.text}
      conflictSource={conflictSourceOf(variant)}
      workingDiff={
        readOnly
          ? undefined
          : {
              saved: drafts[variant]?.base ?? base,
              current: drafts[variant]?.next ?? base,
              item: archivedItemFor(variant, data),
            }
      }
      highlightLine={requestedHash === hash && variant === activeHash ? highlightLine : undefined}
      onChange={(text) => edit(base, lang, text, user?.login ?? 'local draft')}
    />
  );

  // An agent-written draft for an empty English tooltip: editors and maintainers only.
  const draftable =
    !readOnly &&
    !selectedGlobal &&
    !suspended &&
    lang === 'en' &&
    access.reason === null &&
    canPushLive(user) &&
    activeHash > 3 &&
    !/\S/.test(activeBase.text.en?.text ?? '') &&
    !/\S/.test(textOf(activeHash));
  /** Loading is a typed-in edit: one undo step in the editor, then the normal draft and save flow. */
  const loadDraft = (text: string) => {
    const root = document.querySelector<HTMLElement>(
      `.cm-editor[data-tooltip-hash="${activeHash}"]`,
    );
    const editor = root && EditorView.findFromDOM(root);
    if (editor && !editor.state.readOnly) {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: text },
        selection: { anchor: 0 },
        annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.paste')],
        scrollIntoView: true,
      });
      editor.focus();
    } else edit(activeBase, 'en', text, user?.login ?? 'local draft');
  };

  const header = (
    <WithEditorDraft hash={activeHash} enabled={draftable}>
      {(draft) => (
        <EditorPaneHeader
          lang={lang}
          onLanguage={changeLanguage}
          draft={!readOnly && Boolean(drafts[activeHash])}
          saving={saving}
          onDiscard={() => discard(activeHash)}
          reason={pausedOnPhone ? null : access.reason}
          switchTo={access.switchTo}
          onSwitch={changeLanguage}
          overrides={overrideTargets}
          activeOverride={
            activeVariant === null
              ? undefined
              : { hash: activeVariant, name: nameOf(activeVariant) }
          }
          markup={
            access.reason === null || pausedForOther
              ? { open: markupRow.open, toggle: markupRow.toggle }
              : undefined
          }
          onEditOverride={(variant) => setPicked({ hash, at: pickedAt, variant })}
          onBack={() => setPicked({ hash, at: pickedAt, variant: null })}
          grouped={grouped}
          draftLoader={
            draft && (
              <DraftLoader
                draft={draft}
                name={nameOf(activeHash)}
                categoryLabel={baseCategory?.label}
                globals={globalsFor(activeHash)}
                onLoad={loadDraft}
              />
            )
          }
          queue={
            queue ? (
              <QueueControl hash={hash} context={queue} />
            ) : (
              work && <WorkThroughControl work={work} />
            )
          }
          queueBack={
            queue
              ? {
                  to: queuePath(queue, user),
                  label: queueSummary(queue, languageLabel, (id) => categoryDisplay(id).label),
                }
              : work?.mode === 'active'
                ? {
                    ...leaveTarget(work.queue),
                    text: 'Leave queue',
                    label: queueSources[work.queue.source].label,
                    onClick: () => endWork(work.queue.id),
                  }
                : undefined
          }
        />
      )}
    </WithEditorDraft>
  );

  return (
    <>
      {/* Correct the URL without tearing down the live editor during the redirect.
        Remounting CodeMirror reads the DOM selection while sibling panes are dirty,
        forcing the whole workspace to lay out before its ordinary paint. */}
      {!readOnly && requestedHash !== canonical && (
        <Navigate to={tooltipPath(canonical, search.toString())} replace state={routeState} />
      )}
      <h1 className={styles.srOnly}>{heading}</h1>
      <VariantWorkspace
        compendiumLabel={selectedGlobal ? 'Usages' : undefined}
        header={header}
        initialPanel={readOnly ? 'preview' : undefined}
        source={
          lang === 'en' ? undefined : (
            <TranslationSource
              hash={activeHash}
              key={`${activeHash}:${lang}`}
              text={activeTooltip.text.en?.text}
              diff={englishDiffFor(activeBase, lang, translation?.state)}
            />
          )
        }
        editor={
          <section
            aria-label={`${heading} editor (${languageLabel(lang)})`}
            className={styles.editorSection}
          >
            {/* The base editor stays mounted while an override is open: caret and undo survive. */}
            <div className={styles.editorSlot} hidden={activeVariant !== null}>
              {editing(hash, primaryBase)}
            </div>
            {activeVariant !== null && (
              <div className={styles.editorSlot}>
                {editing(activeVariant, tooltipFor(activeVariant, data))}
              </div>
            )}
          </section>
        }
        preview={
          hosted ? null : (
            <div className={styles.inlinePreview} ref={previewHost}>
              {previews}
              {selectedGlobal && (
                <GlobalUsageCount hash={selectedGlobal.hash} name={selectedGlobal.name} />
              )}
              {rows}
            </div>
          )
        }
        compendium={compendiumPane}
        reports={reports}
      />
      {hosted && (
        <ShellSlot name="left">
          <div className={styles.leftStack}>
            <div
              ref={previewHost}
              className={styles.previewBody}
              data-global-preview={selectedGlobal ? true : undefined}
            >
              {previews}
              {selectedGlobal && (
                <GlobalUsageCount hash={selectedGlobal.hash} name={selectedGlobal.name} />
              )}
            </div>
            {rows}
          </div>
        </ShellSlot>
      )}
    </>
  );
}

/** Lower-priority sheet work starts only after the newest editor/preview paint. */
function SteppingCompendium({
  base,
  active,
  ready,
}: {
  base: Tooltip;
  active: boolean;
  ready: boolean;
}) {
  const [painted, setPainted] = useState(base);
  useEffect(() => {
    if (!ready || painted === base) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => startTransition(() => setPainted(base)), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [base, painted, ready]);
  return (
    <CompendiumPanel
      base={painted}
      target={base.hash}
      stepping={active || !ready || painted !== base}
    />
  );
}

/** One line of context under the preview; the full text is the tooltip. */
function NoteRow({ text }: { text: string }) {
  return <PanelRow label={<span title={text}>{text}</span>} className={styles.noteRow} />;
}

/** Records that the preview shows this variant's current text, while the preview is visible. */
function PreviewAck({ variant, visible }: { variant: number; visible: boolean }) {
  useAcknowledgePreview(variant, visible);
  return null;
}
