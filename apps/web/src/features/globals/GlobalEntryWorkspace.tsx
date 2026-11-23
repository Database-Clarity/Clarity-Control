import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Link,
  useLocation,
  useNavigate,
  useNavigationType,
  useSearchParams,
} from 'react-router-dom';
import { globalAggregateHash, languages, type Lang, type MarkupGlobals } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { ClarityEditor } from '../editor/ClarityEditor';
import { useMarkupRow } from '../editor/markupRow/useMarkupRow';
import { Popover } from '../../ui/Popover';
import {
  RightPane,
  RightPaneHeader,
  RightPaneTabsContext,
  type RightPaneTabs,
} from '../../ui/RightPane';
import { PanelRow } from '../../ui/PanelRow';
import { RenderedWordDiff } from '../history/RenderedWordDiff';
import { RawDiffToggle } from '../history/RawDiffToggle';
import { useRawDiff } from '../history/diffPreference';
import { WordDiff } from '../../ui/diff/WordDiff';
import { TooltipPreview } from '../preview/TooltipPreview';
import { ShellSlot } from '../navigation/ShellSlots';
import { useShellColumn } from '../navigation/ShellColumnContext';
import { EditorPaneHeader } from '../tooltip/EditorPaneHeader';
import { VariantWorkspace, useShowEditor } from '../tooltip/VariantWorkspace';
import page from '../tooltip/TooltipPage.module.scss';
import {
  canEditGlobal,
  canAcknowledgeGlobal,
  createGlobalImpactProjector,
  globalSyncState,
  type GlobalImpactProjector,
  type GlobalConsumerView,
  type GlobalProjectionSource,
  globalReviewState,
  canReviewGlobal,
  type GlobalActor,
  type GlobalConsumer,
  type GlobalEntry,
  type GlobalMutation,
  type GlobalSnapshot,
  type GlobalsService,
} from '../../services/globals';
import styles from './GlobalEntryWorkspace.module.scss';
import {
  readGlobalDraft,
  writeGlobalDraft,
  useGlobalDraftStorage,
  type GlobalDraft,
} from './globalDrafts';
import { GlobalHistory, type GlobalHistoryReader } from './GlobalHistory';
import { useAuthStore } from '../../stores/auth';
import { GlobalImpactComparison, validGlobalImpact } from './GlobalImpactComparison';
import { useDataStore, type EditorData } from '../../stores/data';
import { importGlobals } from '../../services/tooltipImports';
import { tooltipTextSources } from '../editor/references';
import { definitionPath } from '../editor/definitionPath';
import { canonicalHash, classifiedCategory, itemFor, listName } from '../navigation/catalog';
import { FinderIcon } from '../navigation/FinderIcon';
import { globalUsageIndex, type GlobalUsageIndex, type GlobalUsages } from './usages';

const globals = { variables: '', titles: '' };
type Action = 'create' | 'rename' | 'remove' | 'remove-language';
const destinationLabel = (value: string) =>
  value === 'live'
    ? 'Live'
    : value === 'saved'
      ? 'Saved'
      : value === 'upcoming'
        ? 'Upcoming'
        : value;
const kindLabel = (kind: GlobalEntry['kind']) =>
  kind === 'variables' ? 'Variable' : kind === 'exports' ? 'Export' : 'Title';

/**
 * `/globals/:id` (stable ID): a global opens in the tooltip editor's own slots. Header finder,
 * left column preview, the definition in the main editor, and Usages / Translations / History in
 * the right pane. `entryId` '' opens the first entry. No projection source is mounted yet: drafts
 * show saved impact.
 *
 * Saving stays the global mutation API (one Save in the pane header) until cut-over, when global
 * drafts are meant to move into the tooltip save pipeline; `run` below is the only write path.
 */
export function GlobalEntryWorkspace({
  service,
  actor,
  globalsByLanguage,
  projectionSource,
  entryId,
  history,
  onSnapshot,
}: {
  service: GlobalsService;
  actor: GlobalActor;
  globalsByLanguage?: Partial<Record<Lang, MarkupGlobals>>;
  projectionSource?: GlobalProjectionSource;
  /** Saved versions of an entry; the History tab shows only when it is supplied. */
  history?: GlobalHistoryReader;
  entryId: string;
  onSnapshot?(snapshot: GlobalSnapshot): void;
}) {
  const [snapshot, setSnapshot] = useState<GlobalSnapshot>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const snapshotListener = useRef(onSnapshot);
  snapshotListener.current = onSnapshot;
  useEffect(() => {
    if (snapshot) snapshotListener.current?.(snapshot);
  }, [snapshot]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    (service.readCatalog ? service.readCatalog() : service.read())
      .then((result) => {
        if (!active) return;
        if (result.kind === 'ok') setSnapshot(result.value);
        else setError(result.message);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load globals.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [service, reload]);
  if (loading || !snapshot)
    return (
      <section className={styles.workspace} aria-busy={loading}>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button onClick={() => setReload(reload + 1)}>Retry</button>
          </>
        ) : (
          <p>Loading globals…</p>
        )}
      </section>
    );
  return (
    <Workspace
      key={actor ? `${actor.role}:${actor.languages.join(',')}` : 'signed-out'}
      snapshot={snapshot}
      service={service}
      actor={actor}
      globalsByLanguage={globalsByLanguage}
      projectionSource={projectionSource}
      entryId={entryId}
      history={history}
      onSnapshot={setSnapshot}
    />
  );
}

function Workspace({
  snapshot,
  service,
  actor,
  globalsByLanguage,
  projectionSource,
  entryId,
  history,
  onSnapshot,
}: {
  snapshot: GlobalSnapshot;
  service: GlobalsService;
  actor: GlobalActor;
  globalsByLanguage?: Partial<Record<Lang, MarkupGlobals>>;
  projectionSource?: GlobalProjectionSource;
  entryId: string;
  history?: GlobalHistoryReader;
  onSnapshot(value: GlobalSnapshot): void;
}) {
  const [params, setParams] = useSearchParams();
  const navigateTo = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const column = useShellColumn();
  const markupRow = useMarkupRow();
  const scrollPositions = useRef(new Map<string, number>());
  const usageList = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const list = usageList.current;
    if (list && navigationType === 'POP')
      list.scrollTop = scrollPositions.current.get(location.key) ?? 0;
    const positions = scrollPositions.current;
    return () => {
      if (list) positions.set(location.key, list.scrollTop);
    };
  }, [location.key, navigationType]);
  const entries = snapshot.entries.filter((item) => !item.tombstone);
  const entry = entries.find((item) => item.id === entryId) ?? (!entryId ? entries[0] : undefined);
  const lang = languages.includes(params.get('lang') as Lang)
    ? (params.get('lang') as Lang)
    : actor?.role === 'translator'
      ? (actor.languages[0] ?? 'en')
      : 'en';
  const key = `${entry?.id}:${lang}`;
  const saved = entry?.definitions[lang]?.body ?? '';
  // Keyed drafts survive Back/Forward, finder stepping between entries, language switches, and
  // reload (stored per account and stable ID); a draft keeps the revision it started from, so
  // staleness survives too.
  const owner = useAuthStore((state) => state.user?.login) ?? 'signed-out';
  const [drafts, setDrafts] = useState<Record<string, GlobalDraft | null>>({});
  const draftOf = (draftKey: string) =>
    draftKey in drafts ? drafts[draftKey] : readGlobalDraft(owner, draftKey);
  /** `null` removes this entry's draft in the open language. */
  function setDraft(next: string | null) {
    // Typing back to the saved text leaves no draft behind (no phantom stale draft later).
    const value =
      next !== null && next !== saved
        ? { body: next, revision: draftOf(key)?.revision ?? entry?.revision }
        : null;
    writeGlobalDraft(owner, key, value);
    setDrafts((previous) => ({ ...previous, [key]: value }));
  }
  const body = draftOf(key)?.body ?? saved;
  const dirty = body !== saved;
  const staleDraft = dirty && draftOf(key)?.revision !== entry?.revision;
  const [pendingAction, setPendingAction] = useState<'saving' | 'checking' | null>(null);
  const pending = pendingAction !== null;
  const pendingLabel = pendingAction === 'saving' ? 'Saving…' : 'Checking…';
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      useGlobalDraftStorage.setState({ failed: false });
    };
  }, []);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [projected, setProjected] = useState<{
    key: string;
    body: string;
    head: string;
    source: GlobalProjectionSource;
    consumers: GlobalConsumerView[];
  }>();
  const [projecting, setProjecting] = useState(false);
  const [projectionError, setProjectionError] = useState('');
  const projector = useRef<GlobalImpactProjector>();
  const projectionAbort = useRef<AbortController>();
  const projectionGeneration = useRef(0);
  const cancelProjection = useCallback(() => {
    ++projectionGeneration.current;
    projectionAbort.current?.abort();
    setProjecting(false);
    setProjectionError('');
  }, []);
  useEffect(() => {
    return cancelProjection;
  }, [key, body, snapshot.head, projectionSource, cancelProjection]);
  useEffect(() => () => projector.current?.dispose(), []);
  const [reviewed, setReviewed] = useState<string>();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [raw] = useRawDiff();
  const query = params.get('q') ?? '';
  const tab = params.get('tab') ?? (actor?.role === 'translator' ? 'translations' : 'usages');
  const shownTab =
    tab === 'translations' ? tab : tab === 'history' && history ? 'history' : 'usages';
  const sync = globalSyncState(snapshot, entry?.id ?? '');
  // The Worker requeues only causes this entry owns; the repository-wide status still blocks.
  const ownCauses = sync.causeIds.filter((cause) => snapshot.causeEntries?.[cause] === entry?.id);
  const openId = entry?.id;
  const savedImpacts = (openId && snapshot.impacts[openId]) || noImpacts;
  // The loaded tooltips (the same data the tooltip editor uses) give previews, references, and
  // usages; the definition being edited still comes from the globals catalogue.
  const data = useDataStore((state) => state.data);
  const sharedGlobals = useMemo(
    () => globalsByLanguage?.[lang] ?? (data ? importGlobals(data, {}, lang) : globals),
    [globalsByLanguage, data, lang],
  );
  const referenceSources = useMemo(
    () => (data ? tooltipTextSources(data.bundle.tooltips, {}, data.aliases) : undefined),
    [data],
  );
  const usageIndex = useGlobalUsageIndex(data, snapshot.entries, shownTab === 'usages');
  const uses = useMemo(
    () => (openId && usageIndex.index ? usageIndex.index.of(openId) : undefined),
    [usageIndex.index, openId],
  );
  const allRows = useMemo(
    () => usageRows(uses ?? noUses, savedImpacts, data, snapshot.entries, lang),
    [uses, savedImpacts, data, snapshot.entries, lang],
  );
  const [reviewReload, setReviewReload] = useState(0);
  const [reviewError, setReviewError] = useState('');
  const reviewsMissing =
    !!entry && service.readEntry !== undefined && snapshot.impacts[entry.id] === undefined;
  useEffect(() => {
    if (!reviewsMissing || !entry || !service.readEntry) return;
    let active = true;
    setReviewError('');
    service
      .readEntry(entry.id)
      .then((result) => {
        if (!active) return;
        if (result.kind === 'ok') onSnapshot(result.value);
        else setReviewError(result.message);
      })
      .catch((reason: unknown) => {
        if (active)
          setReviewError(reason instanceof Error ? reason.message : 'Could not load reviews.');
      });
    return () => {
      active = false;
    };
  }, [service, entry, reviewsMissing, snapshot.head, reviewReload, onSnapshot]);
  const projection =
    dirty &&
    projected?.key === key &&
    projected.body === body &&
    projected.head === snapshot.head &&
    projected.source === projectionSource
      ? projected.consumers
      : undefined;
  const projectedScope = dirty && !!projectionSource;
  const scope = projectedScope ? 'projected' : 'saved';
  // One stable switcher: every view keeps its place and the open one reads as selected.
  const paneViews: [string, string][] = [
    [
      'usages',
      scope === 'projected'
        ? 'Projected impact'
        : uses
          ? `Usages ${allRows.filter((row) => row.direct || row.via.length).length}`
          : 'Usages',
    ],
    ['translations', 'Translations'],
    ...(history ? [['history', 'History'] as [string, string]] : []),
  ];
  const consumers = projectedScope ? (projection ?? []) : savedImpacts;
  function reviewState(row: GlobalConsumerView) {
    return projectedScope ? 'projected' : globalReviewState(row as GlobalConsumer);
  }
  const matches = (text: string) => text.toLowerCase().includes(query.toLowerCase());
  // Language and Review filter the saved impacts under each row too (and so the selection); a
  // row stays while it uses the global in that language or still has a matching impact.
  const usageLang = params.get('usageLang') as Lang | null;
  const review = params.get('review');
  const shownRows = allRows
    .map((row) => ({
      ...row,
      impacts: row.impacts.filter(
        (impact) =>
          (!usageLang || impact.consumer.lang === usageLang) &&
          (!review || review === reviewState(impact)),
      ),
    }))
    .filter(
      (row) =>
        matches(`${row.name} ${row.hash ?? ''} ${row.category}`) &&
        (!params.get('category') || params.get('category') === row.category) &&
        (review
          ? row.impacts.length > 0
          : !usageLang || row.langs.includes(usageLang) || row.impacts.length > 0),
    );
  // Saved: the impacts of the rows shown. Projected: the calculated rows, filtered as before.
  const shown = projectedScope
    ? consumers.filter(
        (row) =>
          matches(`${row.name} ${row.consumer.hash} ${row.consumer.lang} ${row.category}`) &&
          (!params.get('category') || params.get('category') === row.category) &&
          (!params.get('usageLang') || params.get('usageLang') === row.consumer.lang) &&
          (!params.get('review') || params.get('review') === reviewState(row)),
      )
    : shownRows.flatMap((row) => row.impacts);
  const consumer = shown.find((row) => row.id === params.get('consumer')) ?? shown[0];
  const savedConsumer =
    !dirty && consumer ? savedImpacts.find((row) => row.id === consumer.id) : undefined;
  const canAcknowledge =
    !error &&
    !conflict &&
    !!entry &&
    !!savedConsumer &&
    validGlobalImpact(savedConsumer) &&
    canAcknowledgeGlobal(snapshot, entry.id, savedConsumer);
  const reviewKey =
    savedConsumer &&
    JSON.stringify([
      snapshot.head,
      savedConsumer.id,
      savedConsumer.review.contentDigest,
      savedConsumer.review.dependencyDigest,
      savedConsumer.impactDigest,
    ]);
  const disabled = pending || actionsOpen || reviewOpen;
  const editable = canEditGlobal(actor, lang);
  const structural = actor?.role === 'editor' || actor?.role === 'maintainer';
  /** Changes the view; `entry` moves to another stable-ID path ('' is the first entry). */
  function update(values: Record<string, string>, replace = false) {
    const { entry: id, ...rest } = values;
    if (id === undefined) {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          for (const [name, value] of Object.entries(rest)) next.set(name, value);
          return next;
        },
        { replace },
      );
      return;
    }
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(rest)) next.set(name, value);
    const search = next.toString();
    navigateTo(
      { pathname: id ? `/globals/${id}` : '/globals', search: search ? `?${search}` : '' },
      { replace },
    );
  }
  /** The only write path for global definitions (see the component's note). */
  async function run(mutation?: GlobalMutation) {
    if (busy.current) return false;
    busy.current = true;
    setPendingAction(mutation ? 'saving' : 'checking');
    setError('');
    try {
      const result = mutation
        ? await service.mutate({ expectedHead: snapshot.head, mutation })
        : await service.read();
      if (!mounted.current) return false;
      if (result.kind === 'ok') {
        onSnapshot(result.value);
        setDraft(null);
        setProjected(undefined);
        if (!mutation) setDrafts({});
        setReviewed(undefined);
        setConflict(false);
        if (mutation?.operation === 'remove') update({ entry: '' });
        if (mutation?.operation === 'create') {
          const created = result.value.entries.find(
            (item) => !snapshot.entries.some((old) => old.id === item.id),
          );
          if (created) update({ entry: created.id, consumer: '' });
        }
        return true;
      } else {
        if (mutation && result.kind === 'retry') {
          const reason = result.message.replace(/^Sync pending(?::\s*|\.?$)/i, '');
          setError(`Save unconfirmed. Refresh before trying again.${reason ? ` (${reason})` : ''}`);
        } else setError(result.message);
        setConflict(result.kind === 'conflict');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Request failed. Retry the action.');
    } finally {
      busy.current = false;
      setPendingAction(null);
    }
    return false;
  }
  async function refreshSync(retry = false) {
    if ((retry && !entry) || busy.current) return;
    busy.current = true;
    setPendingAction('checking');
    setError('');
    try {
      // Confirm the opened entry even when the bundle lags or its review page is unavailable.
      const result =
        retry && entry
          ? await service.retrySync({
              expectedHead: snapshot.head,
              id: entry.id,
              causeIds: ownCauses,
            })
          : entry && service.readEntry
            ? await service.readEntry(entry.id, { reviews: false })
            : await service.read();
      if (!mounted.current) return;
      if (result.kind === 'ok') {
        onSnapshot(result.value);
        setReviewed(undefined);
        setConflict(false);
      } else {
        setError(result.message);
        setConflict(result.kind === 'conflict');
      }
    } catch (reason) {
      if (mounted.current)
        setError(
          reason instanceof Error ? reason.message : 'Sync request failed. Retry the action.',
        );
    } finally {
      busy.current = false;
      if (mounted.current) setPendingAction(null);
    }
  }
  async function project() {
    if (!entry || !projectionSource) {
      setProjectionError('Projected calculation is unavailable until source snapshots load.');
      return;
    }
    cancelProjection();
    const generation = ++projectionGeneration.current;
    const controller = new AbortController();
    projectionAbort.current = controller;
    setProjecting(true);
    setProjectionError('');
    try {
      const input = projectionSource.prepare({
        expectedHead: snapshot.head,
        id: entry.id,
        revision: entry.revision,
        lang,
        body,
      });
      projector.current ??= createGlobalImpactProjector();
      const result = await projector.current.calculate(input, controller.signal);
      if (!mounted.current || generation !== projectionGeneration.current) return;
      setProjected({
        key,
        body,
        head: snapshot.head,
        source: projectionSource,
        consumers: result.rows.map((row) => projectionSource.describe(row, input)),
      });
      if (!result.complete)
        setProjectionError(`Projected calculation is incomplete: ${result.blockers.join('; ')}`);
    } catch (reason) {
      if (
        mounted.current &&
        generation === projectionGeneration.current &&
        !controller.signal.aborted
      )
        setProjectionError(
          reason instanceof Error
            ? reason.message
            : 'Projected calculation failed. Retry the calculation.',
        );
    } finally {
      if (mounted.current && generation === projectionGeneration.current) setProjecting(false);
    }
  }
  const paneBody = useRef<HTMLDivElement>(null);
  const focusTab = useRef(false);
  useLayoutEffect(() => {
    if (!focusTab.current) return;
    focusTab.current = false;
    paneBody.current?.previousElementSibling
      ?.querySelector<HTMLElement>('[data-pane-tab][aria-selected="true"]')
      ?.focus();
  }, [shownTab]);
  const paneTabs = useMemo<RightPaneTabs>(
    () => ({
      label: 'Global pane',
      tabs: paneViews.map(([id, label]) => ({ id, label })),
      active: shownTab,
      onSelect: (id) => {
        if (disabled) return;
        focusTab.current = true;
        update({ tab: id });
      },
    }),
    // `update` reads the latest params; the labels and the open tab decide the strip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paneViews.map(([, label]) => label).join('|'), shownTab, disabled, params],
  );

  const actions = actor && actor.role !== 'translator' && (
    <GlobalActions
      className={page.ghost}
      open={actionsOpen}
      disabled={pending || reviewOpen}
      onOpenChange={setActionsOpen}
      pending={pending}
      blocked={dirty || reviewOpen}
      reviewsMissing={reviewsMissing}
      referenced={savedImpacts.length > 0 || allRows.some((row) => row.direct || row.via.length)}
      structural={structural}
      maintainer={actor.role === 'maintainer'}
      entry={entry}
      lang={lang}
      onSubmit={run}
    />
  );
  if (!entry)
    return (
      <article className={`${page.page} ${styles.workspace}`}>
        <h1 className={page.srOnly}>Globals</h1>
        <p>
          {entries.length
            ? 'Global not found. Choose another entry in the finder.'
            : 'No globals yet. Create a definition to begin.'}
        </p>
        {error && <p role="alert">{error}</p>}
        {actions}
      </article>
    );

  const saveReason = !actor
    ? 'Sign in to save. Local drafts are available.'
    : !editable
      ? 'This language is read-only for your role. Local drafts are available.'
      : conflict || staleDraft
        ? 'Reload and discard the draft first.'
        : undefined;
  const header = (
    <EditorPaneHeader
      lang={lang}
      onLanguage={(value) => update({ lang: value, consumer: '' })}
      draft={dirty}
      saving={pending}
      onDiscard={() => {
        setDraft(null);
        setProjected(undefined);
      }}
      reason={null}
      onSwitch={() => {}}
      overrides={[]}
      activeOverride={undefined}
      onEditOverride={() => {}}
      onBack={() => {}}
      markup={markupRow}
      draftLoader={
        <button
          type="button"
          className={page.ghost}
          disabled={disabled || !dirty || !editable || conflict || staleDraft}
          title={saveReason}
          onClick={() =>
            void run({
              operation: 'edit',
              id: entry.id,
              revision: entry.revision,
              lang,
              body,
            })
          }
        >
          {pending ? pendingLabel : 'Save'}
        </button>
      }
      worklistControl={actions || undefined}
    />
  );
  const renameIntent = snapshot.renameIntents?.[entry.id];
  const renameQueued = renameIntent && renameIntent.status !== 'not-applied';
  const blockedDestinations = Object.entries(snapshot.destinationSync)
    .filter(([, state]) => state.status !== 'current')
    .map(([destination]) => destinationLabel(destination));
  const notices = (
    <>
      {renameIntent?.status === 'not-applied' && (
        <p role="alert" className={styles.notice} data-tone="warn">
          Rename to {renameIntent.name} did not apply. Open Actions and choose Rename to try again.
        </p>
      )}
      {(renameQueued || sync.status !== 'current' || blockedDestinations.length > 0) && (
        <div
          className={styles.notice}
          data-tone={sync.status === 'sync-failed' ? 'warn' : undefined}
        >
          <span role="status">
            {renameQueued && `Rename queued. Refresh to check whether it applied. `}
            {sync.status === 'sync-failed'
              ? /^sync failed/i.test(sync.lastFailure ?? '')
                ? sync.lastFailure
                : `Sync failed. ${sync.lastFailure ?? 'Failure details unavailable.'}`
              : sync.status === 'sync-pending'
                ? !snapshot.sync[entry.id]
                  ? 'Check status unavailable. Refresh to try again.'
                  : ownCauses.length && !renameQueued
                    ? 'Saved. Waiting for affected tooltips to be checked.'
                    : 'Waiting for global changes to be checked.'
                : null}{' '}
            {blockedDestinations.length > 0 &&
              `Publishing to ${blockedDestinations.join(' and ')} is paused.`}
          </span>
          <span className={styles.noticeActions}>
            <button
              type="button"
              className={page.ghost}
              disabled={pending}
              aria-label="Refresh sync"
              onClick={() => void refreshSync()}
            >
              Refresh
            </button>
            {sync.status === 'sync-failed' && (
              <button
                type="button"
                className={page.ghost}
                disabled={pending || !actor || !ownCauses.length}
                title={ownCauses.length ? undefined : 'Retry from the entry whose save is waiting.'}
                aria-label="Retry sync"
                onClick={() => void refreshSync(true)}
              >
                Retry
              </button>
            )}
          </span>
        </div>
      )}
      {(error || projectionError || staleDraft) && (
        <div role="alert" className={styles.notice} data-tone="warn">
          {error || projectionError || 'The saved revision changed while this draft was open.'}
          {(conflict || staleDraft) && (
            <button
              type="button"
              className={page.ghost}
              disabled={pending}
              onClick={() => void run()}
            >
              Reload and discard draft
            </button>
          )}
        </div>
      )}
      {entry.definitions[lang] === undefined && (
        <p className={styles.notice}>No definition in this language. Saving adds it.</p>
      )}
      {entry.kind === 'variables' && body === '' && (
        <p className={styles.notice}>Explicit empty variable value.</p>
      )}
    </>
  );
  const editor = (
    <section
      aria-label={`${entry.name} editor (${languageLabel(lang)})`}
      className={page.editorSection}
    >
      {notices}
      <div className={page.editorSlot}>
        <ClarityEditor
          key={key}
          value={body}
          lang={lang}
          globals={sharedGlobals}
          referenceSources={referenceSources}
          onOpenTooltip={(target) => navigateTo(definitionPath(target, data))}
          markupRow={markupRow.open}
          readOnly={pending}
          paused={pending}
          readOnlyReason={pending ? pendingLabel : null}
          preview={column ? { collapsed: column.collapsed, onShow: column.show } : undefined}
          onChange={(value) => {
            setDraft(value);
            setReviewed(undefined);
          }}
        />
      </div>
    </section>
  );
  const left = (
    <>
      <div className={page.previewBody}>
        <TooltipPreview
          text={body}
          lang={lang}
          name={entry.name}
          categoryLabel={kindLabel(entry.kind)}
          globals={sharedGlobals}
          fill
        />
      </div>
      {consumer && (
        <div className={page.rows}>
          <PanelRow
            label="Tooltip impact"
            summary={`${consumer.name} (${languageLabel(consumer.consumer.lang)})`}
          >
            <GlobalImpactComparison row={consumer} raw={raw} />
          </PanelRow>
        </div>
      )}
    </>
  );
  /** Plain words for a saved review; a sync that has not finished outranks it. */
  const reviewLabel = (state: string) =>
    !projectedScope && sync.status === 'sync-pending'
      ? entry && snapshot.sync[entry.id]
        ? 'Waiting for checks'
        : 'Check status unavailable'
      : !projectedScope && sync.status === 'sync-failed'
        ? 'Sync failed'
        : state === 'required'
          ? 'Needs review'
          : state === 'acknowledged'
            ? 'Acknowledged'
            : state === 'stale'
              ? 'Review out of date'
              : state;
  const reviewPopover = (row: GlobalConsumerView) => (
    <Popover
      label="Review tooltip impact"
      trigger="Review"
      triggerLabel={`Review ${row.name}`}
      contain
      open={reviewOpen && consumer?.id === row.id}
      onOpenChange={(open) => {
        if (pending || actionsOpen) return;
        if (open) update({ consumer: row.id }, true);
        setReviewOpen(open);
        setReviewed(undefined);
      }}
    >
      <div className={styles.review}>
        <div className={styles.reviewHeader}>
          <strong>
            {row.name} ({destinationLabel(row.consumer.destination)})
          </strong>
          <RawDiffToggle />
        </div>
        <GlobalImpactComparison row={row} raw={raw} />
        <label>
          <input
            type="checkbox"
            disabled={!canAcknowledge || pending || raw}
            checked={canAcknowledge && !!reviewKey && reviewed === reviewKey}
            onChange={(e) => setReviewed(e.target.checked ? reviewKey : undefined)}
          />
          I reviewed both renders; no tooltip change needed.
        </label>
        <button
          disabled={
            dirty ||
            pending ||
            actionsOpen ||
            conflict ||
            raw ||
            reviewed !== reviewKey ||
            !canReviewGlobal(actor, row.consumer.lang) ||
            !canAcknowledge
          }
          onClick={() =>
            savedConsumer &&
            canAcknowledge &&
            void run({
              operation: 'acknowledge',
              id: entry.id,
              consumerId: row.id,
              contentDigest: savedConsumer.review.contentDigest,
              impactDigest: savedConsumer.impactDigest,
              dependencyDigest: savedConsumer.review.dependencyDigest,
              decision: 'no-text-change',
            })
          }
        >
          Acknowledge review
        </button>
        {dirty ? (
          <p>Save this definition before acknowledging impact.</p>
        ) : (
          !canAcknowledge && (
            <p>
              Only current, fully synced reviews can be acknowledged. Refresh after sync finishes.
            </p>
          )
        )}
      </div>
    </Popover>
  );
  const filterValues = projectedScope
    ? {
        category: [...new Set(consumers.map((row) => row.category))],
        usageLang: [...new Set(consumers.map((row) => row.consumer.lang))],
      }
    : {
        category: [...new Set(allRows.map((row) => row.category).filter(Boolean))],
        usageLang: [
          ...new Set(
            allRows.flatMap((row) => [
              ...row.langs,
              ...row.impacts.map((impact) => impact.consumer.lang),
            ]),
          ),
        ],
      };
  const pane = (
    <RightPaneTabsContext.Provider value={paneTabs}>
      <RightPane
        bodyRef={paneBody}
        label="Global usages and translations"
        header={
          <RightPaneHeader title={paneViews.find(([id]) => id === shownTab)![1]}>
            {shownTab === 'usages' && dirty && projectionSource && (
              <button
                type="button"
                className={page.ghost}
                disabled={disabled}
                onClick={() => (projecting ? cancelProjection() : void project())}
              >
                {projecting ? 'Cancel calculation' : 'Calculate projected impact'}
              </button>
            )}
          </RightPaneHeader>
        }
      >
        {shownTab === 'history' && history ? (
          <HistoryTab
            reader={history}
            entry={entry}
            lang={lang}
            saved={saved}
            canRestore={!disabled && editable && !conflict}
            onRestore={(value) => {
              setDraft(value);
              setReviewed(undefined);
            }}
          />
        ) : shownTab === 'translations' ? (
          <div className={styles.paneBody}>
            <h2>English source</h2>
            <pre>{entry.definitions.en?.body ?? 'No English definition.'}</pre>
            {lang !== 'en' &&
              (snapshot.sourceBodies?.[entry.id]?.[lang] !== undefined ? (
                <Popover label="English source changes" trigger="English source changes">
                  <RawDiffToggle />
                  {raw ? (
                    <WordDiff
                      before={snapshot.sourceBodies![entry.id][lang]!}
                      after={entry.definitions.en?.body ?? ''}
                    />
                  ) : (
                    <RenderedWordDiff
                      before={snapshot.sourceBodies![entry.id][lang]!}
                      after={entry.definitions.en?.body ?? ''}
                      lang="en"
                      hash={globalAggregateHash(entry.kind)}
                    />
                  )}
                </Popover>
              ) : (
                <p>Previous English source unavailable.</p>
              ))}
            <ul className={styles.translations}>
              {languages.map((value) => (
                <li key={value}>
                  <button
                    disabled={disabled}
                    aria-current={value === lang || undefined}
                    onClick={() => update({ lang: value })}
                  >
                    {languageLabel(value)}
                  </button>
                  <span>
                    {!entry.definitions[value]
                      ? 'Missing'
                      : value === 'en' ||
                          entry.definitions[value]?.sourceRevision ===
                            entry.definitions.en?.revision
                        ? 'Current'
                        : 'Needs review'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className={`${styles.paneBody} ${styles.usagePane}`}>
            {scope === 'projected' && (
              <p className={styles.impactHeading}>Projected impact — unsaved</p>
            )}
            {projecting && <p role="status">Calculating projected impact… You can keep editing.</p>}
            {reviewsMissing &&
              !projectedScope &&
              (reviewError ? (
                <div role="alert">
                  <p>{reviewError}</p>
                  <button disabled={pending} onClick={() => setReviewReload((value) => value + 1)}>
                    Retry reviews
                  </button>
                </div>
              ) : (
                <p role="status">Loading reviews…</p>
              ))}
            {projectedScope && !projection && (
              <p>
                Calculate projected impact to inspect this draft. Saved reviews remain separate.
              </p>
            )}
            {projectedScope && (
              <p>
                {reviewsMissing
                  ? 'Saved impact: Loading…'
                  : sync.status === 'current'
                    ? `Saved impact: ${new Set(savedImpacts.map((row) => row.consumer.hash)).size} tooltips.`
                    : 'Saved usages will update when sync finishes.'}
              </p>
            )}
            <label className={styles.search}>
              Filter usages{' '}
              <input
                type="search"
                disabled={disabled}
                value={query}
                onChange={(e) => update({ q: e.target.value }, true)}
              />
            </label>
            <div className={styles.filters}>
              {[
                { key: 'category', label: 'Category', values: filterValues.category },
                { key: 'usageLang', label: 'Language', values: filterValues.usageLang },
                {
                  key: 'review',
                  label: 'Review',
                  values: ['required', 'acknowledged', 'stale'],
                },
              ].map((filter) => (
                <label key={filter.key}>
                  {filter.label}
                  <select
                    disabled={disabled}
                    value={params.get(filter.key) ?? ''}
                    onChange={(e) => update({ [filter.key]: e.target.value })}
                  >
                    <option value="">All</option>
                    {filter.values.map((value) => (
                      <option key={value} value={value}>
                        {filter.key === 'usageLang' ? languageLabel(value as Lang) : value}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            {projectedScope ? (
              !shown.length && (
                <p>
                  {query
                    ? 'No matching tooltips. Clear the filter to restore them.'
                    : !projection
                      ? 'Projected usages have not been calculated.'
                      : 'No affected tooltips.'}
                </p>
              )
            ) : !uses ? (
              <p role="status">
                {usageIndex.error ||
                  (data ? 'Finding usages…' : 'Usages show once the tooltips load.')}
              </p>
            ) : (
              !shownRows.length && (
                <p>
                  {query ||
                  params.get('category') ||
                  params.get('usageLang') ||
                  params.get('review')
                    ? 'No matching usages. Clear the filters to restore them.'
                    : 'Not used by any tooltip.'}
                </p>
              )
            )}
            <ul ref={usageList} className={styles.consumers}>
              {projectedScope
                ? shown.map((row) => (
                    <li
                      key={row.id}
                      data-global-consumer={row.id}
                      data-selected={consumer?.id === row.id}
                    >
                      <div className={styles.consumerHeading}>
                        <button
                          className={styles.consumerSelect}
                          disabled={disabled}
                          aria-pressed={consumer?.id === row.id}
                          onClick={() => update({ consumer: row.id })}
                        >
                          {row.name} ({languageLabel(row.consumer.lang)})
                        </button>
                        {reviewPopover(row)}
                      </div>
                      <div className={styles.projectedMeta}>
                        <span className={styles.projectedDetail}>
                          {row.direct === null ? 'Unproven' : row.direct ? 'Direct' : 'Indirect'},{' '}
                          {reviewState(row)}, {destinationLabel(row.consumer.destination)}
                          {row.archived ? ', archived' : ''}
                        </span>
                        <span className={styles.projectedDetail}>
                          {row.path?.join(' → ') ?? 'Exact dependency path unavailable.'}
                        </span>
                        <span>
                          {row.causes.length} cause{row.causes.length === 1 ? '' : 's'}
                        </span>
                        <Link
                          tabIndex={disabled ? -1 : undefined}
                          onClick={(e) => {
                            if (disabled) e.preventDefault();
                          }}
                          to={`/t/${row.consumer.hash}?lang=${row.consumer.lang}&variant=${row.variant}${row.line === null ? '' : `&line=${row.line}`}`}
                        >
                          {row.line === null ? 'Open tooltip' : `Open line ${row.line}`}
                        </Link>
                      </div>
                    </li>
                  ))
                : shownRows.map((row) => (
                    <li key={row.key} data-global-usage={row.key}>
                      <Link
                        className={styles.usageLink}
                        tabIndex={disabled ? -1 : undefined}
                        onClick={(e) => {
                          if (disabled) e.preventDefault();
                        }}
                        to={row.to}
                      >
                        {row.hash !== undefined && <FinderIcon icon={row.icon} />}
                        {row.name}
                      </Link>
                      <div className={styles.consumerMeta}>
                        <span>
                          {[
                            row.category,
                            row.langs.map(languageLabel).join(', '),
                            row.direct
                              ? 'Direct'
                              : row.via.length
                                ? `Through ${row.via.join(', ')}`
                                : 'No current use',
                            row.members > 1 && `${row.members} items`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </div>
                      {row.impacts.map((impact) => (
                        <div
                          key={impact.id}
                          className={styles.consumerHeading}
                          data-global-consumer={impact.id}
                          data-selected={consumer?.id === impact.id}
                        >
                          <button
                            className={styles.consumerSelect}
                            disabled={disabled}
                            aria-pressed={consumer?.id === impact.id}
                            onClick={() => update({ consumer: impact.id })}
                          >
                            <span>
                              {languageLabel(impact.consumer.lang)}:{' '}
                              {reviewLabel(reviewState(impact))},{' '}
                              {destinationLabel(impact.consumer.destination)}
                            </span>
                          </button>
                          {reviewPopover(impact)}
                        </div>
                      ))}
                    </li>
                  ))}
            </ul>
          </div>
        )}
      </RightPane>
    </RightPaneTabsContext.Provider>
  );

  return (
    <article className={page.page} aria-busy={pending || undefined}>
      <h1 className={page.srOnly}>{entry.name}</h1>
      <VariantWorkspace
        header={header}
        editor={editor}
        preview={column ? null : <div className={page.inlinePreview}>{left}</div>}
        compendium={pane}
        compendiumLabel="Details"
      />
      {column && (
        <ShellSlot name="left">
          <div className={page.leftStack}>{left}</div>
        </ShellSlot>
      )}
    </article>
  );
}

const noImpacts: GlobalConsumer[] = [];
const noUses: GlobalUsages = { tooltips: [], globals: [] };

/**
 * The usage index, built once per loaded data and catalogue: at once when the Usages tab is
 * open, otherwise when the browser is idle (so the tab count fills in). The previous index stays
 * shown while a newer one builds.
 */
function useGlobalUsageIndex(
  data: EditorData | null,
  entries: readonly GlobalEntry[],
  wanted: boolean,
): { index?: GlobalUsageIndex; error: string } {
  const [built, setBuilt] = useState<{
    data: EditorData;
    entries: readonly GlobalEntry[];
    index: GlobalUsageIndex;
  }>();
  const [error, setError] = useState('');
  const current = built?.data === data && built?.entries === entries;
  useEffect(() => {
    if (!data || current) return;
    const controller = new AbortController();
    const start = () =>
      void globalUsageIndex(data, entries).then(
        (index) => {
          if (controller.signal.aborted) return;
          setError('');
          setBuilt({ data, entries, index });
        },
        (reason: unknown) => {
          if (!controller.signal.aborted)
            setError(reason instanceof Error ? reason.message : 'Could not find usages.');
        },
      );
    let cancel = () => {};
    if (wanted) start();
    else if (typeof requestIdleCallback === 'function') {
      const idle = requestIdleCallback(start, { timeout: 2000 });
      cancel = () => cancelIdleCallback(idle);
    } else {
      const timer = setTimeout(start, 500);
      cancel = () => clearTimeout(timer);
    }
    return () => {
      cancel();
      controller.abort();
    };
  }, [data, entries, wanted, current]);
  return { index: built?.index, error };
}

interface UsageRow {
  key: string;
  name: string;
  icon?: string;
  category: string;
  /** Canonical tooltip hash; absent for a global. */
  hash?: number;
  langs: Lang[];
  direct: boolean;
  via: string[];
  members: number;
  to: string;
  /** Saved review obligations for this tooltip (any language or destination). */
  impacts: GlobalConsumer[];
}

/**
 * One row per tooltip (an alias group or base/enhanced pair once, under its canonical hash) and
 * per global that uses the entry, with any saved impacts attached. A saved impact without a
 * current use (the reference was removed since) keeps its own row so it can still be reviewed.
 */
function usageRows(
  uses: GlobalUsages,
  impacts: readonly GlobalConsumer[],
  data: EditorData | null,
  entries: readonly GlobalEntry[],
  lang: Lang,
): UsageRow[] {
  const canonical = (hash: number) => (data ? canonicalHash(hash, data) : hash);
  const byHash = new Map<number, GlobalConsumer[]>();
  for (const impact of impacts) {
    const hash = canonical(impact.consumer.hash);
    byHash.set(hash, [...(byHash.get(hash) ?? []), impact]);
  }
  const describe = (hash: number) => {
    const item = data ? itemFor(hash, data) : undefined;
    return {
      name: item && data ? listName(item, data) : `Tooltip ${hash}`,
      icon: item?.icon,
      category: (item && data && classifiedCategory(item, data)?.label) || '',
    };
  };
  // `import Perk from 42` reads as the tooltip's name, as in the finder.
  const named = (via: string) =>
    via.replace(/ from (\d+)$/, (_, hash: string) => ` from ${describe(Number(hash)).name}`);
  const languageOf = (langs: readonly Lang[]) => (langs.includes(lang) ? lang : langs[0]);
  const ordered = (langs: readonly Lang[]) => languages.filter((value) => langs.includes(value));
  const rows: UsageRow[] = uses.tooltips.map((use) => ({
    key: `t:${use.hash}`,
    ...describe(use.hash),
    hash: use.hash,
    langs: ordered(use.langs),
    direct: use.direct,
    via: use.via.map(named),
    members: use.members,
    // Member, language, and line of the same use, so the line exists where the editor opens.
    to: `/t/${use.hash}?lang=${use.open.lang}&variant=${use.open.variant}${use.open.line ? `&line=${use.open.line}` : ''}`,
    impacts: byHash.get(use.hash) ?? [],
  }));
  for (const [hash, list] of byHash)
    if (!uses.tooltips.some((use) => use.hash === hash))
      rows.push({
        key: `t:${hash}`,
        ...describe(hash),
        hash,
        langs: [],
        direct: false,
        via: [],
        members: 1,
        to: `/t/${hash}?lang=${list[0].consumer.lang}&variant=${list[0].variant}`,
        impacts: list,
      });
  for (const use of uses.globals) {
    const entry = entries.find((item) => item.id === use.id);
    if (!entry) continue;
    rows.push({
      key: `g:${use.id}`,
      name: entry.name,
      category: `Global ${kindLabel(entry.kind).toLowerCase()}`,
      langs: ordered(use.langs),
      direct: use.direct,
      via: use.via.map(named),
      members: 1,
      to: `/globals/${use.id}?lang=${languageOf(use.langs)}`,
      impacts: [],
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** History in the right pane; a restore shows the editor where it is a separate view (phones). */
function HistoryTab(props: Parameters<typeof GlobalHistory>[0]) {
  const showEditor = useShowEditor();
  return (
    <GlobalHistory
      {...props}
      onRestore={(value) => {
        props.onRestore(value);
        showEditor();
      }}
    />
  );
}

function GlobalActions({
  className,
  open,
  disabled,
  onOpenChange,
  structural,
  maintainer,
  referenced,
  pending,
  blocked,
  reviewsMissing,
  entry,
  lang,
  onSubmit,
}: {
  className?: string;
  open: boolean;
  disabled: boolean;
  onOpenChange(value: boolean): void;
  structural: boolean;
  maintainer: boolean;
  referenced: boolean;
  pending: boolean;
  blocked: boolean;
  reviewsMissing: boolean;
  entry?: GlobalEntry;
  lang: Lang;
  onSubmit(mutation: GlobalMutation): Promise<boolean>;
}): ReactNode {
  const [action, setAction] = useState<Action>();
  const cancel = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (action) cancel.current?.focus();
  }, [action]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<GlobalEntry['kind']>('variables');
  const [body, setBody] = useState('');
  const removing = action === 'remove' || action === 'remove-language';
  const submitDisabled = pending || blocked || reviewsMissing || (removing && referenced);
  const label = !action
    ? 'Global actions'
    : action === 'create'
      ? 'Create global'
      : action === 'rename'
        ? 'Rename'
        : action === 'remove-language'
          ? 'Remove language'
          : 'Remove';
  return (
    <Popover
      label={label}
      trigger="Actions"
      className={className}
      contain
      width={360}
      open={open}
      onOpenChange={(next) => {
        if (next && disabled) return;
        setAction(undefined);
        onOpenChange(next);
      }}
    >
      {(close) =>
        !action ? (
          <div className={styles.actionMenu}>
            {(
              [
                ['create', 'Create global', true],
                ['rename', 'Rename', entry && structural],
                ['remove', 'Remove', entry && maintainer],
                ['remove-language', 'Remove language', entry?.definitions[lang] && maintainer],
              ] as const
            ).map(
              ([value, title, allowed]) =>
                allowed && (
                  <button
                    key={value}
                    disabled={reviewsMissing}
                    onClick={() => {
                      setName(value === 'rename' ? (entry?.name ?? '') : '');
                      setBody('');
                      setAction(value);
                    }}
                  >
                    {title}
                  </button>
                ),
            )}
            {reviewsMissing && <p>Load reviews before changing globals.</p>}
          </div>
        ) : (
          <form
            className={styles.action}
            onSubmit={async (event) => {
              event.preventDefault();
              if (submitDisabled) return;
              const success =
                action === 'create'
                  ? await onSubmit({ operation: 'create', name, kind, lang, body })
                  : entry &&
                    (await onSubmit(
                      action === 'rename'
                        ? { operation: 'rename', id: entry.id, revision: entry.revision, name }
                        : {
                            operation: 'remove',
                            id: entry.id,
                            revision: entry.revision,
                            ...(action === 'remove-language' ? { lang } : {}),
                          },
                    ));
              if (success) close();
            }}
          >
            <strong>{label}</strong>
            {!removing && (
              <label>
                Name{' '}
                <input
                  required
                  disabled={pending}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            )}
            {action === 'create' && (
              <>
                <label>
                  Kind{' '}
                  <select
                    disabled={pending}
                    value={kind}
                    onChange={(e) => setKind(e.target.value as GlobalEntry['kind'])}
                  >
                    <option value="variables">Variable</option>
                    <option value="titles">Title</option>
                    <option value="exports">Export</option>
                  </select>
                </label>
                <label>
                  Definition body{' '}
                  <textarea
                    disabled={pending}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                </label>
              </>
            )}
            <p>
              {removing
                ? `Remove ${action === 'remove-language' ? `the ${languageLabel(lang)} definition` : 'this unused global in every language'}? The server checks saved, live, and upcoming references.`
                : action === 'rename'
                  ? 'Rename the stable entry and rewrite exact reference tokens in one transaction.'
                  : `Create a definition in ${languageLabel(lang)}.`}
            </p>
            <div className={styles.toolbar}>
              <button
                type="button"
                ref={cancel}
                data-autofocus
                disabled={pending}
                onClick={() => close()}
              >
                Cancel
              </button>
              <button disabled={submitDisabled}>{pending ? 'Working…' : label}</button>
            </div>
            {(blocked || (removing && referenced)) && (
              <p>Finish or discard your draft first. Removal also requires zero references.</p>
            )}
          </form>
        )
      }
    </Popover>
  );
}
