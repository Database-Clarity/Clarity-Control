import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { languages, type Lang, type MarkupGlobals } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { ClarityEditor } from '../editor/ClarityEditor';
import { Popover } from '../../ui/Popover';
import { RightPane, RightPaneHeader } from '../../ui/RightPane';
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
import { GlobalImpactComparison, validGlobalImpact } from './GlobalImpactComparison';

const globals = { variables: '', titles: '' };
type Action = 'create' | 'rename' | 'remove' | 'remove-language';

/** Deliberately unmounted: S5 supplies the gated service and stable-ID route. */
export function GlobalEntryWorkspace({
  service,
  actor,
  globalsByLanguage,
  projectionSource,
}: {
  service: GlobalsService;
  actor: GlobalActor;
  globalsByLanguage?: Partial<Record<Lang, MarkupGlobals>>;
  projectionSource?: GlobalProjectionSource;
}) {
  const [snapshot, setSnapshot] = useState<GlobalSnapshot>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    service
      .read()
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
  onSnapshot,
}: {
  snapshot: GlobalSnapshot;
  service: GlobalsService;
  actor: GlobalActor;
  globalsByLanguage?: Partial<Record<Lang, MarkupGlobals>>;
  projectionSource?: GlobalProjectionSource;
  onSnapshot(value: GlobalSnapshot): void;
}) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const scrollPositions = useRef(new Map<string, number>());
  const usageList = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const list = usageList.current;
    if (list) list.scrollTop = scrollPositions.current.get(location.key) ?? 0;
    const positions = scrollPositions.current;
    return () => {
      if (list) positions.set(location.key, list.scrollTop);
    };
  }, [location.key]);
  const selectedId = params.get('entry');
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
  // Retain keyed drafts when browser Back/Forward changes the URL directly.
  const [drafts, setDrafts] = useState<Record<string, { body: string; revision?: string }>>({});
  function setDraft(next: { key: string; body: string }) {
    setDrafts((previous) => {
      const values = { ...previous };
      if (next.key) values[next.key] = { body: next.body, revision: entry?.revision };
      else delete values[key];
      return values;
    });
  }
  const body = drafts[key]?.body ?? saved;
  const dirty = body !== saved;
  const staleDraft = dirty && drafts[key]?.revision !== entry?.revision;
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [action, setAction] = useState<Action>();
  const [navigation, setNavigation] = useState<Record<string, string>>();
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
  const sync = globalSyncState(snapshot, entry?.id ?? '');
  const savedImpacts = entry ? (snapshot.impacts[entry.id] ?? []) : [];
  const projection =
    dirty &&
    projected?.key === key &&
    projected.body === body &&
    projected.head === snapshot.head &&
    projected.source === projectionSource
      ? projected.consumers
      : undefined;
  const scope = dirty ? 'projected' : 'saved';
  const consumers = dirty ? (projection ?? []) : savedImpacts;
  function reviewState(row: GlobalConsumerView) {
    return dirty ? 'projected' : globalReviewState(row as GlobalConsumer);
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
  const disabled = pending || !!action || !!navigation || reviewOpen;
  const editable = canEditGlobal(actor, lang);
  const structural = actor?.role === 'editor' || actor?.role === 'maintainer';
  function update(values: Record<string, string>, replace = false) {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [name, value] of Object.entries(values)) next.set(name, value);
        return next;
      },
      { replace },
    );
  }
  function navigate(values: Record<string, string>) {
    if (disabled) return;
    if (dirty) setNavigation(values);
    else {
      setDraft({ key: '', body: '' });
      update(values);
    }
  }
  async function run(mutation?: GlobalMutation) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const result = mutation
        ? await service.mutate({ expectedHead: snapshot.head, mutation })
        : await service.read();
      if (!mounted.current) return;
      if (result.kind === 'ok') {
        onSnapshot(result.value);
        setDraft({ key: '', body: '' });
        setProjected(undefined);
        if (!mutation) setDrafts({});
        setReviewed(undefined);
        setAction(undefined);
        setConflict(false);
        if (mutation?.operation === 'remove') update({ entry: '' });
        if (mutation?.operation === 'create') {
          const created = result.value.entries.find(
            (item) => !snapshot.entries.some((old) => old.id === item.id),
          );
          if (created) update({ entry: created.id, consumer: '' });
        }
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
              causeIds: sync.causeIds,
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
      <header className={styles.toolbar}>
        <h1>{entry?.name ?? 'Globals'}</h1>
        {actor && actor.role !== 'translator' && (
          <ActionPopover
            action="create"
            current={action}
            setAction={setAction}
            pending={pending}
            blocked={dirty || !!navigation || reviewOpen}
            entry={entry}
            lang={lang}
            onSubmit={run}
          />
        )}
        {entry && structural && (
          <ActionPopover
            action="rename"
            current={action}
            setAction={setAction}
            pending={pending}
            blocked={dirty || !!navigation || reviewOpen}
            entry={entry}
            lang={lang}
            onSubmit={run}
          />
        )}
        {entry && actor?.role === 'maintainer' && (
          <ActionPopover
            action="remove"
            current={action}
            setAction={setAction}
            pending={pending}
            blocked={dirty || !!navigation || reviewOpen || savedImpacts.length > 0}
            entry={entry}
            lang={lang}
            onSubmit={run}
          />
        )}
        {entry?.definitions[lang] && actor?.role === 'maintainer' && (
          <ActionPopover
            action="remove-language"
            current={action}
            setAction={setAction}
            pending={pending}
            blocked={dirty || !!navigation || reviewOpen || savedImpacts.length > 0}
            entry={entry}
            lang={lang}
            onSubmit={run}
          />
        )}
        <span>{entry?.kind}</span>
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
            disabled={disabled || !actor}
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
      {entry && snapshot.renameIntents?.[entry.id]?.renameCompleted === false && (
        <p role="status">Rename queued; not complete.</p>
      )}
      {Object.entries(snapshot.destinationSync)
        .filter(([, state]) => state.status !== 'current')
        .map(([destination, state]) => (
          <p key={destination} role="status" className={styles.syncDestination}>
            {destination}:{' '}
            {state.status === 'sync-pending'
              ? 'Sync pending. Publishing here is blocked until sync finishes.'
              : 'Sync failed. Publishing here is blocked until sync succeeds.'}
          </p>
        ))}
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
      <div className={styles.toolbar}>
        <label>
          Entry{' '}
          <select
            aria-label="Global entry"
            disabled={disabled}
            value={entry?.id ?? ''}
            onChange={(e) => navigate({ entry: e.target.value, consumer: '' })}
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
            onChange={(e) => navigate({ lang: e.target.value, consumer: '' })}
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
            trigger="Discard"
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
            {view === 'usages' ? 'Usages / Translations' : view === 'editor' ? 'Editor' : 'Preview'}
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
              {sync.status === 'current' ? (
                <>
                  Usages: {new Set(savedImpacts.map((row) => row.consumer.hash)).size} tooltips ·{' '}
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
            {consumer && (
              <p>
                Selected consumer: {consumer.name} · {languageLabel(consumer.consumer.lang)}
              </p>
            )}
            <p>Saved revision: {entry.revision}</p>
          </aside>
          <section
            className={styles.editor}
            data-phone-visible={phone === 'editor'}
            aria-label="Definition editor"
          >
            <div className={styles.toolbar}>
              <strong>Definition body</strong>
              <span>{dirty ? 'Unsaved' : 'Saved'}</span>
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
                  setDraft({ key, body: saved });
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
            {dirty && (
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
                <RightPaneHeader title={tab === 'translations' ? 'Translations' : 'Usages'}>
                  <button
                    disabled={disabled}
                    onClick={() => update({ tab: tab === 'usages' ? 'translations' : 'usages' })}
                  >
                    {tab === 'usages' ? 'Translations' : 'Usages'}
                  </button>
                </RightPaneHeader>
              }
            >
              {tab === 'translations' ? (
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
                  <ul>
                    {languages.map((value) => (
                      <li key={value}>
                        <button disabled={disabled} onClick={() => navigate({ lang: value })}>
                          {languageLabel(value)}
                        </button>{' '}
                        {!entry.definitions[value]
                          ? 'Missing'
                          : value === 'en' ||
                              entry.definitions[value]?.sourceRevision ===
                                entry.definitions.en?.revision
                            ? 'Current'
                            : 'Needs review'}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className={styles.paneBody}>
                  <strong>
                    {scope === 'projected' ? 'Projected impact — unsaved' : 'Saved impact'}
                  </strong>
                  {dirty && !projection && (
                    <p>
                      Calculate projected impact to inspect this draft. Saved reviews remain
                      separate.
                    </p>
                  )}
                  {dirty && (
                    <p>
                      {sync.status === 'current'
                        ? `Saved impact: ${savedImpacts.length} consumers.`
                        : 'Saved usages will update when sync finishes.'}
                    </p>
                  )}
                  <label>
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
                        label: 'Consumer language',
                        values: [...new Set(consumers.map((row) => row.consumer.lang))],
                      },
                      {
                        key: 'review',
                        label: 'Review status',
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
                  {!shown.length && (
                    <p>
                      {query
                        ? 'No matching consumers. Clear the filter to restore them.'
                        : dirty && !projection
                          ? 'Projected usages have not been calculated.'
                          : !dirty && sync.status !== 'current'
                            ? 'Saved usages will update when sync finishes.'
                            : 'No affected consumers.'}
                    </p>
                  )}
                  <ul ref={usageList} className={styles.consumers}>
                    {shown.map((row) => (
                      <li key={row.id}>
                        <button
                          disabled={disabled}
                          aria-pressed={consumer?.id === row.id}
                          onClick={() => update({ consumer: row.id })}
                        >
                          {row.name} · {languageLabel(row.consumer.lang)}
                        </button>
                        <span>
                          {row.direct === null ? 'Unproven' : row.direct ? 'Direct' : 'Indirect'} ·{' '}
                          {reviewState(row)} · {row.consumer.destination}
                          {row.archived ? ' · Archived' : ''}
                        </span>
                        <span>{row.path?.join(' → ') ?? 'Exact dependency path unavailable.'}</span>
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
                          Open consumer{row.line === null ? '' : ` · line ${row.line}`}
                        </Link>
                      </li>
                    ))}
                  </ul>
                  {consumer && (
                    <Popover
                      label="Review consumer impact"
                      trigger={`Review ${consumer.name}`}
                      contain
                      open={reviewOpen}
                      onOpenChange={(open) => {
                        if (pending || action || navigation) return;
                        setReviewOpen(open);
                        setReviewed(undefined);
                      }}
                    >
                      <div className={styles.review}>
                        <strong>
                          {consumer.name} · {consumer.consumer.destination}
                        </strong>
                        <RawDiffToggle />
                        <GlobalImpactComparison row={consumer} raw={raw} />
                        <label>
                          <input
                            type="checkbox"
                            disabled={
                              !canAcknowledge || pending || raw || !validGlobalImpact(consumer)
                            }
                            checked={canAcknowledge && !!reviewKey && reviewed === reviewKey}
                            onChange={(e) => setReviewed(e.target.checked ? reviewKey : undefined)}
                          />
                          I reviewed both renders; no tooltip change needed.
                        </label>
                        <button
                          disabled={
                            dirty ||
                            pending ||
                            !!action ||
                            !!navigation ||
                            conflict ||
                            raw ||
                            reviewed !== reviewKey ||
                            !canReviewGlobal(actor, consumer.consumer.lang) ||
                            !validGlobalImpact(consumer) ||
                            !canAcknowledge
                          }
                          onClick={() =>
                            savedConsumer &&
                            canAcknowledge &&
                            void run({
                              operation: 'acknowledge',
                              id: entry.id,
                              consumerId: consumer.id,
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
                              Only current, fully synced reviews can be acknowledged. Refresh after
                              sync finishes.
                            </p>
                          )
                        )}
                      </div>
                    </Popover>
                  )}
                </div>
              )}
            </RightPane>
          </section>
        </div>
      )}
    </article>
  );
}

function ActionPopover({
  action,
  current,
  setAction,
  pending,
  blocked,
  entry,
  lang,
  onSubmit,
}: {
  action: Action;
  current?: Action;
  setAction(value?: Action): void;
  pending: boolean;
  blocked: boolean;
  entry?: GlobalEntry;
  lang: Lang;
  onSubmit(mutation: GlobalMutation): Promise<void>;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'variables' | 'titles'>('variables');
  const [body, setBody] = useState('');
  const removing = action === 'remove' || action === 'remove-language';
  const label =
    action === 'create'
      ? 'Create global'
      : action === 'rename'
        ? 'Rename'
        : action === 'remove-language'
          ? 'Remove language'
          : 'Remove';
  return (
    <Popover
      label={label}
      trigger={label}
      contain
      open={current === action}
      onOpenChange={(open) => {
        if (pending || (open && current && current !== action)) return;
        setName(action === 'rename' ? (entry?.name ?? '') : '');
        setBody('');
        setAction(open ? action : undefined);
      }}
    >
      <form
        className={styles.action}
        onSubmit={(event) => {
          event.preventDefault();
          if (pending || blocked) return;
          if (action === 'create') void onSubmit({ operation: 'create', name, kind, lang, body });
          else if (entry)
            void onSubmit(
              action === 'rename'
                ? { operation: 'rename', id: entry.id, revision: entry.revision, name }
                : {
                    operation: 'remove',
                    id: entry.id,
                    revision: entry.revision,
                    ...(action === 'remove-language' ? { lang } : {}),
                  },
            );
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
              <textarea disabled={pending} value={body} onChange={(e) => setBody(e.target.value)} />
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
            data-autofocus
            disabled={pending}
            onClick={() => setAction(undefined)}
          >
            Cancel
          </button>
          <button disabled={pending || blocked}>{pending ? 'Working…' : label}</button>
        </div>
        {blocked && (
          <p>Finish or discard your draft first. Removal also requires zero references.</p>
        )}
      </form>
    </Popover>
  );
}
