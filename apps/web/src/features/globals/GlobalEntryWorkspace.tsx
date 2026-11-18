import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Link,
  useLocation,
  useNavigate,
  useNavigationType,
  useSearchParams,
} from 'react-router-dom';
import { languages, type Lang, type MarkupGlobals } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { ClarityEditor } from '../editor/ClarityEditor';
import { Popover } from '../../ui/Popover';
import { RightPane } from '../../ui/RightPane';
import { RenderedWordDiff } from '../history/RenderedWordDiff';
import { RawDiffToggle } from '../history/RawDiffToggle';
import { useRawDiff } from '../history/diffPreference';
import { WordDiff } from '../../ui/diff/WordDiff';
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

/**
 * Mounted at `/globals/:id` (stable ID, `entryId`) behind the globals switch; without `entryId`
 * the selection lives in `?entry=`. No projection source is mounted yet: drafts show saved impact.
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
  /** Routed mode: the entry comes from the path; '' or undefined opens the first entry. */
  entryId?: string | null;
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
  entryId?: string | null;
  history?: GlobalHistoryReader;
  onSnapshot(value: GlobalSnapshot): void;
}) {
  const [params, setParams] = useSearchParams();
  const routed = entryId !== undefined;
  const navigateTo = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
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
  const selectedId = routed ? entryId || null : params.get('entry');
  const entries = snapshot.entries.filter((item) => !item.tombstone);
  const entry =
    entries.find((item) => item.id === selectedId) ?? (!selectedId ? entries[0] : undefined);
  const lang = languages.includes(params.get('lang') as Lang)
    ? (params.get('lang') as Lang)
    : actor?.role === 'translator'
      ? (actor.languages[0] ?? 'en')
      : 'en';
  const key = `${entry?.id}:${lang}`;
  const saved = entry?.definitions[lang]?.body ?? '';
  // Keyed drafts survive Back/Forward, finder stepping between entries, and reload (stored per
  // account and stable ID); a draft keeps the revision it started from, so staleness survives too.
  const owner = useAuthStore((state) => state.user?.login) ?? 'signed-out';
  const [drafts, setDrafts] = useState<Record<string, GlobalDraft | null>>({});
  const draftOf = (draftKey: string) =>
    draftKey in drafts ? drafts[draftKey] : readGlobalDraft(owner, draftKey);
  function setDraft(next: { key: string; body: string }) {
    const draftKey = next.key || key;
    // Typing back to the saved text leaves no draft behind (no phantom stale draft later).
    const value =
      next.key && !(next.key === key && next.body === saved)
        ? { body: next.body, revision: draftOf(draftKey)?.revision ?? entry?.revision }
        : null;
    writeGlobalDraft(owner, draftKey, value);
    setDrafts((previous) => ({ ...previous, [draftKey]: value }));
  }
  const body = draftOf(key)?.body ?? saved;
  const dirty = body !== saved;
  const staleDraft = dirty && draftOf(key)?.revision !== entry?.revision;
  const [pending, setPending] = useState(false);
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
  const navigationAnchor = useRef<HTMLElement>();
  const [navigation, setNavigation] = useState<Record<string, string>>();
  useLayoutEffect(() => {
    // The select becomes focusable again after the confirmation closes.
    if (!navigation) navigationAnchor.current?.focus();
  }, [navigation]);
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
  const [phone, setPhone] = useState('editor');
  const query = params.get('q') ?? '';
  const tab = params.get('tab') ?? (actor?.role === 'translator' ? 'translations' : 'usages');
  const shownTab =
    tab === 'translations' ? tab : tab === 'history' && history ? 'history' : 'usages';
  const sync = globalSyncState(snapshot, entry?.id ?? '');
  // The Worker requeues only causes this entry owns; the repository-wide status still blocks.
  const ownCauses = sync.causeIds.filter((cause) => snapshot.causeEntries?.[cause] === entry?.id);
  const savedImpacts = entry ? (snapshot.impacts[entry.id] ?? []) : [];
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
    ['usages', scope === 'projected' ? 'Projected impact' : 'Usages'],
    ['translations', 'Translations'],
    ...(history ? [['history', 'History'] as [string, string]] : []),
  ];
  const consumers = projectedScope ? (projection ?? []) : savedImpacts;
  function reviewState(row: GlobalConsumerView) {
    return projectedScope ? 'projected' : globalReviewState(row as GlobalConsumer);
  }
  const shown = consumers.filter(
    (row) =>
      `${row.name} ${row.consumer.hash} ${row.consumer.lang} ${row.category}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (!params.get('category') || params.get('category') === row.category) &&
      (!params.get('usageLang') || params.get('usageLang') === row.consumer.lang) &&
      (!params.get('review') || params.get('review') === reviewState(row)),
  );
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
  const disabled = pending || actionsOpen || !!navigation || reviewOpen;
  const editable = canEditGlobal(actor, lang);
  const structural = actor?.role === 'editor' || actor?.role === 'maintainer';
  function update(values: Record<string, string>, replace = false) {
    if (routed && 'entry' in values) {
      const { entry: id, ...rest } = values;
      const next = new URLSearchParams(params);
      for (const [name, value] of Object.entries(rest)) next.set(name, value);
      const query = next.toString();
      navigateTo(
        { pathname: id ? `/globals/${id}` : '/globals', search: query ? `?${query}` : '' },
        { replace },
      );
      return;
    }
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [name, value] of Object.entries(values)) next.set(name, value);
        return next;
      },
      { replace },
    );
  }
  function navigate(values: Record<string, string>, anchor: HTMLElement) {
    navigationAnchor.current = anchor;
    if (disabled) return;
    if (dirty) setNavigation(values);
    else {
      setDraft({ key: '', body: '' });
      update(values);
    }
  }
  async function run(mutation?: GlobalMutation) {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const result = mutation
        ? await service.mutate({ expectedHead: snapshot.head, mutation })
        : await service.read();
      if (!mounted.current) return false;
      if (result.kind === 'ok') {
        onSnapshot(result.value);
        setDraft({ key: '', body: '' });
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
        setError(result.message);
        setConflict(result.kind === 'conflict');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Request failed. Retry the action.');
    } finally {
      busy.current = false;
      setPending(false);
    }
    return false;
  }
  async function refreshSync(retry = false) {
    if ((retry && !entry) || busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const result =
        retry && entry
          ? await service.retrySync({
              expectedHead: snapshot.head,
              id: entry.id,
              causeIds: ownCauses,
            })
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
      if (mounted.current) setPending(false);
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
  return (
    <article className={styles.workspace} aria-busy={pending}>
      <header className={styles.header}>
        <h1>{entry?.name ?? 'Globals'}</h1>
        {entry && <span>{entry.kind === 'variables' ? 'Variable' : 'Title'}</span>}
        {actor && actor.role !== 'translator' && (
          <GlobalActions
            open={actionsOpen}
            disabled={pending || !!navigation || reviewOpen || reviewsMissing}
            onOpenChange={setActionsOpen}
            pending={pending}
            blocked={dirty || !!navigation || reviewOpen}
            referenced={savedImpacts.length > 0}
            structural={structural}
            maintainer={actor.role === 'maintainer'}
            entry={entry}
            lang={lang}
            onSubmit={run}
          />
        )}
      </header>
      <div className={styles.syncNotice}>
        {entry && (
          <strong role="status">
            {sync.status === 'sync-pending'
              ? 'Sync pending'
              : sync.status === 'sync-failed'
                ? 'Sync failed'
                : 'Current'}
          </strong>
        )}
        <button disabled={disabled} aria-label="Refresh sync" onClick={() => void refreshSync()}>
          Refresh
        </button>
        {entry && sync.status === 'sync-failed' && (
          <button
            disabled={disabled || !actor || !ownCauses.length}
            title={ownCauses.length ? undefined : 'Retry from the entry whose save is waiting.'}
            aria-label="Retry sync"
            onClick={() => void refreshSync(true)}
          >
            Retry
          </button>
        )}
        {entry && sync.status === 'sync-failed' && (
          <p role="alert">{sync.lastFailure ?? 'Failure details unavailable.'}</p>
        )}
      </div>
      {entry &&
        snapshot.renameIntents?.[entry.id]?.renameCompleted === false &&
        (snapshot.renameIntents[entry.id].status === 'not-applied' ? (
          <p role="alert" className={styles.warning}>
            Rename to {snapshot.renameIntents[entry.id].name} not applied. Rename again if it is
            still needed.
          </p>
        ) : (
          <p role="status">Rename queued; not complete.</p>
        ))}
      {Object.values(snapshot.destinationSync).some((state) => state.status !== 'current') && (
        <p role="status" className={styles.syncDestination}>
          Publishing to{' '}
          {Object.entries(snapshot.destinationSync)
            .filter(([, state]) => state.status !== 'current')
            .map(([destination]) => destinationLabel(destination))
            .join(' and ')}{' '}
          is blocked until sync finishes.
        </p>
      )}
      {(error || projectionError || staleDraft) && (
        <div role="alert">
          {error || projectionError || 'The saved revision changed while this draft was open.'}
          {(conflict || staleDraft) && (
            <button disabled={pending} onClick={() => void run()}>
              Reload and discard draft
            </button>
          )}
        </div>
      )}
      <div className={styles.selection}>
        <label>
          Entry{' '}
          <select
            aria-label="Global entry"
            disabled={disabled}
            value={entry?.id ?? ''}
            onChange={(e) => navigate({ entry: e.target.value, consumer: '' }, e.currentTarget)}
          >
            {!entry && <option value="">Choose an entry</option>}
            {entries.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.kind}
              </option>
            ))}
          </select>
        </label>
        <label>
          Language{' '}
          <select
            disabled={disabled}
            value={lang}
            onChange={(e) => navigate({ lang: e.target.value, consumer: '' }, e.currentTarget)}
          >
            {languages.map((value) => (
              <option key={value} value={value}>
                {languageLabel(value)}
              </option>
            ))}
          </select>
        </label>
        {navigation && (
          <Popover
            label="Discard unsaved definition"
            anchorElement={navigationAnchor.current}
            contain
            open={!!navigation}
            onOpenChange={(open) => {
              if (!open) setNavigation(undefined);
            }}
          >
            {(close) => (
              <>
                <p>Discard the unsaved definition before changing selection?</p>
                <button
                  data-autofocus
                  onClick={() => {
                    setNavigation(undefined);
                    close();
                  }}
                >
                  Cancel
                </button>{' '}
                <button
                  onClick={() => {
                    if (navigation) {
                      setDraft({ key: '', body: '' });
                      update(navigation);
                      setNavigation(undefined);
                    }
                    close();
                  }}
                >
                  Discard and continue
                </button>
              </>
            )}
          </Popover>
        )}
      </div>
      <nav className={styles.phoneNav} aria-label="Global views">
        {['preview', 'editor', 'usages'].map((view) => (
          <button
            key={view}
            aria-pressed={phone === view}
            disabled={disabled}
            onClick={() => setPhone(view)}
          >
            {view === 'usages'
              ? paneViews.find(([value]) => value === shownTab)![1]
              : view === 'editor'
                ? 'Editor'
                : 'Preview'}
          </button>
        ))}
      </nav>
      {!entry ? (
        <p>
          {entries.length
            ? 'Global not found. Choose another entry.'
            : 'No globals yet. Create a definition to begin.'}
        </p>
      ) : (
        <div className={styles.columns}>
          <aside className={styles.preview} data-phone-visible={phone === 'preview'}>
            <button
              disabled={disabled}
              onClick={() => {
                update({ tab: 'usages' });
                setPhone('usages');
              }}
            >
              {reviewsMissing ? (
                'Usages: Loading…'
              ) : sync.status === 'current' ? (
                <>
                  Usages: {new Set(savedImpacts.map((row) => row.consumer.hash)).size} tooltips,{' '}
                  {new Set(savedImpacts.map((row) => row.consumer.lang)).size} languages
                </>
              ) : sync.status === 'sync-pending' ? (
                'Usages: Sync pending'
              ) : (
                'Usages: Sync failed'
              )}
            </button>
            <Popover label="Definition preview" trigger="Preview definition">
              <RenderedWordDiff
                before=""
                after={body}
                lang={lang}
                hash={entry.kind === 'variables' ? 2 : 3}
              />
            </Popover>
          </aside>
          <section
            className={styles.editor}
            data-phone-visible={phone === 'editor'}
            aria-label="Definition editor"
          >
            <div className={styles.definitionHeader}>
              <strong>Definition body</strong>
              <span>{dirty ? 'Unsaved' : 'Saved'}</span>
              <span>Revision {entry.revision}</span>
            </div>
            <div className={styles.toolbar}>
              <button
                disabled={disabled || !dirty || !editable || conflict || staleDraft}
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
                Save definition
              </button>
              <button
                disabled={disabled || !dirty}
                onClick={() => {
                  setDraft({ key: '', body: '' });
                  setProjected(undefined);
                }}
              >
                Discard draft
              </button>
            </div>
            {entry.definitions[lang] === undefined && (
              <p>No definition in this language. Saving adds it.</p>
            )}
            <ClarityEditor
              key={key}
              value={body}
              lang={lang}
              globals={globalsByLanguage?.[lang] ?? globals}
              readOnly={disabled}
              readOnlyReason={disabled ? 'Finish the current action first.' : null}
              onChange={(value) => {
                setDraft({ key, body: value });
                setReviewed(undefined);
              }}
            />
            {!editable && (
              <p>
                {actor
                  ? 'This language is read-only for your role. Local drafts are available.'
                  : 'Sign in to save. Local drafts are available.'}
              </p>
            )}
            {projecting && <p role="status">Calculating projected impact… You can keep editing.</p>}
            {entry.kind === 'variables' && body === '' && <p>Explicit empty variable value.</p>}
            {dirty && projectionSource && (
              <button
                disabled={disabled}
                onClick={() => (projecting ? cancelProjection() : void project())}
              >
                {projecting ? 'Cancel calculation' : 'Calculate projected impact'}
              </button>
            )}
          </section>
          <section className={styles.pane} data-phone-visible={phone === 'usages'}>
            <RightPane
              label="Global usages and translations"
              header={
                <div className={styles.paneTabs} role="group" aria-label="Pane view">
                  {paneViews.map(([value, label]) => (
                    <button
                      key={value}
                      aria-pressed={shownTab === value}
                      disabled={disabled}
                      onClick={() => update({ tab: value })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              }
            >
              {tab === 'history' && history ? (
                <GlobalHistory
                  reader={history}
                  entry={entry}
                  lang={lang}
                  saved={saved}
                  canRestore={!disabled && editable && !conflict}
                  onRestore={(value) => {
                    setDraft({ key, body: value });
                    setReviewed(undefined);
                    setPhone('editor');
                  }}
                />
              ) : tab === 'translations' ? (
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
                            hash={entry.kind === 'variables' ? 2 : 3}
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
                          onClick={(e) => navigate({ lang: value }, e.currentTarget)}
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
                <div className={styles.paneBody}>
                  {scope === 'projected' && (
                    <p className={styles.impactHeading}>Projected impact — unsaved</p>
                  )}
                  {reviewsMissing &&
                    !projectedScope &&
                    (reviewError ? (
                      <div role="alert">
                        <p>{reviewError}</p>
                        <button onClick={() => setReviewReload((value) => value + 1)}>
                          Retry reviews
                        </button>
                      </div>
                    ) : (
                      <p role="status">Loading reviews…</p>
                    ))}
                  {projectedScope && !projection && (
                    <p>
                      Calculate projected impact to inspect this draft. Saved reviews remain
                      separate.
                    </p>
                  )}
                  {projectedScope && (
                    <p>
                      {reviewsMissing
                        ? 'Saved impact: Loading…'
                        : sync.status === 'current'
                          ? `Saved impact: ${savedImpacts.length} consumers.`
                          : 'Saved usages will update when sync finishes.'}
                    </p>
                  )}
                  <label className={styles.search}>
                    Filter consumers{' '}
                    <input
                      type="search"
                      disabled={disabled}
                      value={query}
                      onChange={(e) => update({ q: e.target.value }, true)}
                    />
                  </label>
                  <div className={styles.filters}>
                    {[
                      {
                        key: 'category',
                        label: 'Category',
                        values: [...new Set(consumers.map((row) => row.category))],
                      },
                      {
                        key: 'usageLang',
                        label: 'Language',
                        values: [...new Set(consumers.map((row) => row.consumer.lang))],
                      },
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
                              {value}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                  {!shown.length && (!reviewsMissing || projectedScope) && (
                    <p>
                      {query
                        ? 'No matching consumers. Clear the filter to restore them.'
                        : projectedScope && !projection
                          ? 'Projected usages have not been calculated.'
                          : !projectedScope && sync.status !== 'current'
                            ? 'Saved usages will update when sync finishes.'
                            : 'No affected consumers.'}
                    </p>
                  )}
                  <ul ref={usageList} className={styles.consumers}>
                    {shown.map((row) => (
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
                          <Popover
                            label="Review consumer impact"
                            trigger="Review"
                            triggerLabel={`Review ${row.name}`}
                            contain
                            open={reviewOpen && consumer?.id === row.id}
                            onOpenChange={(open) => {
                              if (pending || actionsOpen || navigation) return;
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
                                  onChange={(e) =>
                                    setReviewed(e.target.checked ? reviewKey : undefined)
                                  }
                                />
                                I reviewed both renders; no tooltip change needed.
                              </label>
                              <button
                                disabled={
                                  dirty ||
                                  pending ||
                                  actionsOpen ||
                                  !!navigation ||
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
                                    Only current, fully synced reviews can be acknowledged. Refresh
                                    after sync finishes.
                                  </p>
                                )
                              )}
                            </div>
                          </Popover>
                        </div>
                        <div className={styles.consumerMeta}>
                          <span>
                            {row.direct === null ? 'Unproven' : row.direct ? 'Direct' : 'Indirect'},{' '}
                            {reviewState(row)}, {destinationLabel(row.consumer.destination)}
                            {row.archived ? ', archived' : ''}
                          </span>
                          <span>
                            {row.path?.join(' → ') ?? 'Exact dependency path unavailable.'}
                          </span>
                          <span>
                            {row.causes.length} cause{row.causes.length === 1 ? '' : 's'}
                          </span>
                          <Link
                            tabIndex={disabled ? -1 : undefined}
                            onClick={(e) => {
                              if (disabled || dirty) e.preventDefault();
                            }}
                            to={`/t/${row.consumer.hash}?lang=${row.consumer.lang}&variant=${row.variant}${row.line === null ? '' : `&line=${row.line}`}`}
                          >
                            {row.line === null ? 'Open consumer' : `Open line ${row.line}`}
                          </Link>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </RightPane>
          </section>
        </div>
      )}
    </article>
  );
}

function GlobalActions({
  open,
  disabled,
  onOpenChange,
  structural,
  maintainer,
  referenced,
  pending,
  blocked,
  entry,
  lang,
  onSubmit,
}: {
  open: boolean;
  disabled: boolean;
  onOpenChange(value: boolean): void;
  structural: boolean;
  maintainer: boolean;
  referenced: boolean;
  pending: boolean;
  blocked: boolean;
  entry?: GlobalEntry;
  lang: Lang;
  onSubmit(mutation: GlobalMutation): Promise<boolean>;
}) {
  const [action, setAction] = useState<Action>();
  const cancel = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (action) cancel.current?.focus();
  }, [action]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'variables' | 'titles'>('variables');
  const [body, setBody] = useState('');
  const removing = action === 'remove' || action === 'remove-language';
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
          </div>
        ) : (
          <form
            className={styles.action}
            onSubmit={async (event) => {
              event.preventDefault();
              if (pending || blocked || (removing && referenced)) return;
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
                    onChange={(e) => setKind(e.target.value as 'variables' | 'titles')}
                  >
                    <option value="variables">Variable</option>
                    <option value="titles">Title</option>
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
              <button disabled={pending || blocked || (removing && referenced)}>
                {pending ? 'Working…' : label}
              </button>
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
