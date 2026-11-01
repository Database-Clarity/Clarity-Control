import { guidedDecisions, guidedRevision, type GuidedDecision } from './guidedDecisions';
import { importContext } from './importContext';
import { researchSuggestions } from './researchSuggestions';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { CompendiumData, Tooltip } from '@clarity/core';
import { groupManifestItems } from './manifestItems';
import { apiUrl } from '../../services/api';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl } from '../../services/compendium';
import { useSaveState } from '../../services/save/state';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useCompendiumStore } from './store';
import { LinkPicker } from './LinkPicker';
import { applyReviewProgress, mayDraftLink, reviewEvidence } from './reviewQueue';
import {
  progressSchema,
  reviewStorageKey,
  sourceFingerprint,
  type ReviewProgress,
} from './reviewProgress';
import { useReviewProgress } from './useReviewProgress';
import { advanceHash, recordDecision, restoreLink, shortcutAction } from './rapidReview';
import { ProposalContext } from './ProposalContext';
import { suggestionAnchor } from './suggestions';
import styles from './MatchReview.module.scss';
import { useProposals } from './useProposals';
import { CategoryReview } from './CategoryReview';
import { categoryId, reviewCategories, type ReviewCategory } from './reviewCategories';
import { useGuidance } from './useGuidance';
import { classifyScope } from './reviewScope';
import {
  BulkPreview,
  bulkPreviewCurrent,
  createBulkPreview,
  type BulkPreviewState,
  type BulkProposal,
} from './BulkPreview';
import { useSidebarQueueStore } from '../navigation/sidebarQueue';
import { workspaceShortcutsBlocked } from '../../ui/interaction';

const labels = {
  open: 'Unresolved',
  drafted: 'Drafted',
  saved: 'Saved',
  skipped: 'Skipped',
  'no-equivalent': 'No equivalent (local)',
};
type Undo = {
  progress: ReviewProgress;
  params?: string;
  links: { base: Tooltip; before: Tooltip['compendium']; after: Tooltip['compendium'] }[];
  revision: string;
};

export function MatchReviewPage() {
  const [params] = useSearchParams();
  const editor = useDataStore((state) => state.data);
  const { data, load, loading, error } = useCompendiumStore();
  const { user, loading: authLoading } = useAuthStore();
  useEffect(() => {
    void load();
  }, [load]);
  const storageKey = reviewStorageKey(
    `${bundleUrl}|${compendiumDataUrl}|${apiUrl ?? 'read-only'}`,
    user?.id,
  );
  return (
    <article
      className={`${styles.review} ${params.get('view') === 'entries' ? styles.entryReview : styles.categoryReview}`}
    >
      <header className={styles.heading}>
        <div>
          <Link to="/compendium">← Compendium</Link>
          <h1>Review matches</h1>
        </div>
        <Link to="/review">Review & save drafts →</Link>
        <details className={styles.help}>
          <summary aria-label="Review help">?</summary>
          <div>
            <p>
              Compare the entry with the proposed source. Accept creates a local draft; Review &
              save drafts uses the normal Worker save flow.
            </p>
            <p>
              Pick other opens the full sheet picker. Skip and No equivalent are local browser
              progress only. Changed evidence reopens these decisions.
            </p>
            <p>
              Bulk preview contains only validated resolver proposals. Accept applies only to the
              current preview page. Undo restores link metadata only, preserving text and
              association edits. Shortcuts are disabled while typing or using the picker.
            </p>
          </div>
        </details>
      </header>
      {error && <p role="alert">{error}</p>}
      {(loading || authLoading) && <p role="status">Loading review data…</p>}
      {editor && data && !authLoading && (
        <ReviewQueue key={storageKey} storageKey={storageKey} editor={editor} source={data} />
      )}
    </article>
  );
}

export function ReviewQueue({
  editor,
  source,
  storageKey,
}: {
  editor: EditorData;
  source: CompendiumData;
  storageKey: string;
}) {
  const actionBar = useRef<HTMLElement>(null);
  const { progress, update, error } = useReviewProgress(storageKey);
  const setSidebarCategories = useSidebarQueueStore((state) => state.setCompendiumCategories);
  const [params, setParams] = useSearchParams();
  const categoryView = params.get('view') !== 'entries';
  const groupId = params.get('group');
  const scopeKey = `review-scope-restored:${bundleUrl}|${compendiumDataUrl}`;
  const [scopeState, setScopeState] = useState(() => {
    try {
      const raw = localStorage.getItem(scopeKey);
      const value: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(value) || !value.every((hash) => Number.isSafeInteger(hash)))
        throw new Error('Invalid stored restore list');
      return { hashes: new Set<number>(value), error: '' };
    } catch {
      return {
        hashes: new Set<number>(),
        error: 'Could not load restored scope from local storage.',
      };
    }
  });
  const scopeRef = useRef(scopeState);
  function restoreScope(hash: number) {
    if (scopeRef.current.hashes.has(hash)) return;
    const hashes = new Set(scopeRef.current.hashes);
    hashes.add(hash);
    let error = '';
    try {
      localStorage.setItem(scopeKey, JSON.stringify([...hashes]));
    } catch {
      error = 'Could not save restored scope to local storage.';
    }
    const next = { hashes, error };
    scopeRef.current = next;
    setScopeState(next);
    setBulk(undefined);
  }
  const [message, setMessage] = useState('');
  const [picker, setPicker] = useState(false);
  const [bulk, setBulk] = useState<BulkPreviewState>();
  const [bulkPage, setBulkPage] = useState(0);
  const [undo, setUndo] = useState<Undo>();
  const { drafts, hydrated } = useDraftStore();
  const user = useAuthStore((state) => state.user);
  const locked = useSaveState((state) => state.locked);
  useLayoutEffect(() => {
    const actions = actionBar.current;
    const page = actions?.closest('article');
    if (!page || !actions) return;
    const updateHeight = () =>
      page.style.setProperty(
        '--review-action-bar-height',
        `${actions.getBoundingClientRect().height}px`,
      );
    updateHeight();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateHeight);
      return () => {
        window.removeEventListener('resize', updateHeight);
        page.style.removeProperty('--review-action-bar-height');
      };
    }
    const observer = new ResizeObserver(updateHeight);
    observer.observe(actions, { box: 'border-box' });
    return () => {
      observer.disconnect();
      page.style.removeProperty('--review-action-bar-height');
    };
  }, []);
  const fingerprint = useMemo(() => sourceFingerprint(source.tabs), [source]);
  const evidence = useMemo(
    () => reviewEvidence(editor, source, drafts, fingerprint),
    [editor, source, drafts, fingerprint],
  );
  const entries = useMemo(() => applyReviewProgress(evidence, progress), [evidence, progress]);
  const manifest = useMemo(
    () => groupManifestItems(editor.items, editor.aliases),
    [editor.items, editor.aliases],
  );
  const { proposals, loading: matching, error: proposalError } = useProposals(editor, source);
  const categories = useMemo(
    () =>
      reviewCategories(entries, editor, proposals, matching, !!proposalError).map((category) => {
        const decorated = new Map(
          category.entries.map((entry) => [
            entry.hash,
            {
              ...entry,
              scopeRestored: scopeState.hashes.has(entry.hash),
            },
          ]),
        );
        const decorate = (entry: (typeof category.entries)[number]) => decorated.get(entry.hash)!;
        return {
          ...category,
          entries: category.entries.map(decorate),
          samples: category.samples.map(decorate),
          reasons: Object.fromEntries(
            Object.entries(category.reasons).map(([reason, items]) => [
              reason,
              items.map(decorate),
            ]),
          ) as typeof category.reasons,
        };
      }),
    [entries, editor, proposals, matching, proposalError, scopeState.hashes],
  );
  useEffect(() => {
    setSidebarCategories(categories.map(({ id, name }) => ({ id, name })));
  }, [categories, setSidebarCategories]);
  const guidance = useGuidance(
    categories,
    `${editor.bundle.sourceCommit}|${fingerprint}`,
    source,
    !matching && !proposalError,
  );
  const inScope = new Set(
    categories.flatMap((category) =>
      category.entries
        .filter((entry) => !classifyScope(entry, category.id))
        .map((entry) => entry.hash),
    ),
  );
  const scopedEntries = entries.filter((entry) => inScope.has(entry.hash));
  const routeFilter = progressSchema.shape.filter.safeParse(params.get('status'));
  // New category links reset stale filters; normalized URLs retain each history entry's filters.
  const queueProgress: ReviewProgress = {
    ...progress,
    query: params.get('query') ?? (groupId ? '' : progress.query),
    category: groupId ? '' : (params.get('category') ?? progress.category),
    filter: routeFilter.success ? routeFilter.data : groupId ? 'open' : progress.filter,
  };
  const proposalFilter = params.get('proposal') ?? 'all';
  const filtered = scopedEntries.filter(
    (entry) =>
      (!groupId || categoryId(entry.category) === groupId) &&
      (!queueProgress.category || entry.category === queueProgress.category) &&
      (!queueProgress.query ||
        `${entry.name} ${entry.hash}`.toLowerCase().includes(queueProgress.query.toLowerCase())) &&
      (queueProgress.filter === 'all' || entry.status === queueProgress.filter) &&
      (proposalFilter === 'all' ||
        (proposalFilter === 'yes') === !!proposals.get(entry.hash)?.link),
  );
  const routeHash = params.get('hash');
  const selected =
    filtered.find((entry) => String(entry.hash) === routeHash) ??
    filtered.find((entry) => entry.hash === progress.selected) ??
    filtered[0];
  const index = selected ? filtered.indexOf(selected) : -1;
  const proposal = selected && proposals.get(selected.hash);
  const hints = selected
    ? researchSuggestions(selected.hash, source, selected.category, selected.name)
    : [];
  const [candidate, setCandidate] = useState(0);
  const matches = proposal?.match ? [proposal.match] : (proposal?.candidates ?? []);
  const hint = hints[0];
  const hintTab = hint && source.tabs.find((tab) => tab.gid === hint.gid);
  const hintRow = hintTab && suggestionAnchor(hintTab, hint);
  const match =
    matches[candidate] ??
    matches[0] ??
    (hintTab && hintRow ? { tab: hintTab, row: hintRow } : undefined);
  const canEdit = mayDraftLink(user?.role, !!apiUrl, hydrated, locked);
  const bulkEntries = filtered.filter(
    (entry) => entry.status === 'open' && proposals.get(entry.hash)?.link,
  );
  const bulkCurrent =
    !!bulk && bulkPreviewCurrent(bulk, editor, source, entries, proposals, drafts);
  const completed = scopedEntries.filter((entry) => entry.status !== 'open').length;
  const nextHash = advanceHash(
    filtered.map((entry) => entry.hash),
    index,
  );
  function selectionParams(
    hash: number | undefined,
    state = queueProgress,
    next = new URLSearchParams(params),
  ) {
    next.set('query', state.query);
    next.set('category', state.category);
    next.set('status', state.filter);
    next.set('proposal', next.get('proposal') ?? 'all');
    if (hash === undefined) next.delete('hash');
    else next.set('hash', String(hash));
    return next;
  }
  useEffect(() => {
    if (categoryView) return;
    const next = selectionParams(selected?.hash);
    if (next.toString() === params.toString()) return;
    setParams(next, { replace: true });
  });
  function keepEntryVisible() {
    if (window.matchMedia('(max-width: 700px)').matches)
      requestAnimationFrame(() =>
        document
          .querySelector('[aria-label="Entry to review"]')
          ?.scrollIntoView({ block: 'start' }),
      );
  }
  function choose(hash?: number) {
    update((state) => ({ ...state, selected: hash }));
    setParams(selectionParams(hash));
    setCandidate(0);
    setPicker(false);
  }
  function snapshot(links: Undo['links'] = []) {
    setUndo({
      progress: categoryView ? progress : { ...queueProgress, selected: selected?.hash },
      params: categoryView ? undefined : selectionParams(selected?.hash).toString(),
      links,
      revision: editor.bundle.sourceCommit,
    });
  }
  function decide(kind: 'skipped' | 'no-equivalent') {
    if (!selected) return;
    snapshot();
    update((state) => recordDecision(state, selected.hash, selected.evidence, kind, nextHash));
    setParams(selectionParams(nextHash), { replace: true });
    setCandidate(0);
    setPicker(false);
    setMessage(`${selected.name}: ${labels[kind]}.`);
    keepEntryVisible();
  }
  function accept() {
    if (!canEdit || !selected || selected.status !== 'open' || !proposal?.link) return;
    snapshot([{ base: selected.base, before: selected.next.compendium, after: proposal.link }]);
    useDraftStore
      .getState()
      .updateDraft(selected.base, (next) => ({ ...next, compendium: proposal.link }));
    update((state) => recordDecision(state, selected.hash, selected.evidence, 'open', nextHash));
    setParams(selectionParams(nextHash), { replace: true });
    setCandidate(0);
    setMessage(`${selected.name}: link drafted, not saved.`);
    keepEntryVisible();
  }
  function undoLast() {
    if (!undo || locked || (undo.links.length > 0 && !canEdit)) return;
    if (
      undo.revision !== editor.bundle.sourceCommit ||
      undo.links.some(
        ({ base, before, after }) =>
          !restoreLink(
            useDraftStore.getState().drafts[base.hash]?.next ??
              editor.bundle.tooltips[base.hash] ??
              base,
            before,
            after,
          ),
      )
    ) {
      setMessage('Cannot undo: this link or saved data changed. Inspect the draft first.');
      return;
    }
    useDraftStore.getState().updateDrafts(
      undo.links.map(({ base, before, after }) => ({
        base,
        update: (next) => restoreLink(next, before, after)!,
      })),
    );
    update(() => undo.progress);
    if (undo.params !== undefined)
      setParams(
        selectionParams(undo.progress.selected, undo.progress, new URLSearchParams(undo.params)),
        { replace: true },
      );
    setUndo(undefined);
    setPicker(false);
    setCandidate(0);
    setMessage('Last decision undone.');
  }
  function acceptGuided(category: ReviewCategory, decisions: GuidedDecision[], revision: string) {
    // Read authoritative state at invocation: a captured handler may predate a synchronous edit.
    if (scopeRef.current.hashes !== scopeState.hashes) {
      setMessage('Review scope changed. Open a new preview.');
      return;
    }
    const latest = guidance.persistence.getSnapshot();
    if (
      !mayDraftLink(
        useAuthStore.getState().user?.role,
        !!apiUrl,
        useDraftStore.getState().hydrated,
        useSaveState.getState().locked,
      ) ||
      latest.conflict ||
      latest.reloading ||
      !latest.proposalInput ||
      !decisions.length ||
      latest.planningRevision !== guidance.planningRevision
    )
      return;
    const group = guidedDecisions(
      latest.proposalInput,
      categories,
      proposals,
      source,
      `${editor.bundle.sourceCommit}|${fingerprint}`,
      `${bundleUrl}|${compendiumDataUrl}`,
    ).find((group) => group.id === category.id);
    if (!group || guidedRevision([group]) !== revision) {
      setMessage('Guided evidence changed. Open a new preview.');
      return;
    }
    const selected = decisions.map((decision) => ({
      decision,
      entry: category.entries.find((entry) => entry.hash === decision.hash),
    }));
    if (
      new Set(decisions.map((decision) => decision.hash)).size !== decisions.length ||
      selected.some(
        ({ decision, entry }) =>
          !entry ||
          entry.status !== 'open' ||
          !decision.link ||
          !group.entries.some(
            (current) =>
              JSON.stringify(current) === JSON.stringify(decision) &&
              current.action === 'link' &&
              current.confidence !== 'unresolved',
          ) ||
          (useDraftStore.getState().drafts[entry.hash]?.next ??
            editor.bundle.tooltips[entry.hash] ??
            entry.base) !== entry.next,
      )
    ) {
      setMessage('Preview or drafts changed. Open a new preview.');
      return;
    }
    snapshot(
      selected.map(({ decision, entry }) => ({
        base: entry!.base,
        before: entry!.next.compendium,
        after: decision.link,
      })),
    );
    useDraftStore.getState().updateDrafts(
      selected.map(({ decision, entry }) => ({
        base: entry!.base,
        update: (next) => ({ ...next, compendium: decision.link }),
      })),
    );
    setMessage(`${selected.length} links drafted, not saved.`);
  }
  function acceptBulk(visible: BulkProposal[]) {
    if (!canEdit || !bulk || !visible.length) return;
    if (
      scopeRef.current.hashes !== scopeState.hashes ||
      !bulkPreviewCurrent(bulk, editor, source, entries, proposals, useDraftStore.getState().drafts)
    ) {
      setMessage('Preview evidence or drafts changed. Cancel and open a new preview.');
      return;
    }
    snapshot(
      visible.map(({ entry, link }) => ({
        base: entry.base,
        before: entry.next.compendium,
        after: link,
      })),
    );
    useDraftStore.getState().updateDrafts(
      visible.map(({ entry, link }) => ({
        base: entry.base,
        update: (next) => ({ ...next, compendium: link }),
      })),
    );
    update((state) =>
      visible.reduce(
        (next, { entry }) => recordDecision(next, entry.hash, entry.evidence, 'open', undefined),
        state,
      ),
    );
    setParams(selectionParams(undefined), { replace: true });
    setMessage(`${visible.length} links drafted, not saved.`);
    setBulk(undefined);
  }
  useEffect(() => {
    if (categoryView) return;
    function keydown(event: KeyboardEvent) {
      if (workspaceShortcutsBlocked(event)) return;
      if (event.key === 'Escape' && (picker || bulk)) {
        setPicker(false);
        setBulk(undefined);
        return;
      }
      const target = event.target instanceof Element ? event.target : undefined;
      const action = shortcutAction(
        event,
        picker || !!bulk || !!target?.closest('input, textarea, select, [contenteditable="true"]'),
      );
      if (!action || event.repeat) return;
      event.preventDefault();
      if (action === 'accept') accept();
      if (action === 'pick' && selected) setPicker(true);
      if (action === 'none') decide('no-equivalent');
      if (action === 'skip') decide('skipped');
      if (action === 'undo') undoLast();
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });
  function filter(patch: Partial<ReviewProgress>, next = new URLSearchParams(params)) {
    const state = { ...queueProgress, ...patch, selected: undefined };
    update(() => state);
    setParams(selectionParams(undefined, state, next), { replace: true });
    setCandidate(0);
    setPicker(false);
  }
  function reviewCategory(category?: ReviewCategory, hash?: number) {
    const state = { ...progress, category: '', query: '', filter: 'open' as const, selected: hash };
    update(() => state);
    setCandidate(0);
    setPicker(false);
    setParams(
      selectionParams(
        hash,
        state,
        new URLSearchParams(
          category ? { view: 'entries', group: category.id } : { view: 'entries' },
        ),
      ),
    );
  }
  if (categoryView)
    return (
      <>
        {proposalError && <p role="alert">{proposalError}</p>}
        {error && <p role="alert">{error}</p>}
        {scopeState.error && <p role="alert">{scopeState.error}</p>}
        {message && <p role="status">{message}</p>}
        <button disabled={!undo || !canEdit} onClick={undoLast}>
          Undo last decision
        </button>
        <CategoryReview
          canEdit={canEdit}
          onAccept={acceptGuided}
          onRestore={restoreScope}
          categories={categories}
          editor={editor}
          source={source}
          proposals={proposals}
          guidance={guidance}
          onReview={reviewCategory}
        />
      </>
    );
  return (
    <>
      <div className={styles.entryNav}>
        <button
          onClick={() => {
            setPicker(false);
            setBulk(undefined);
            setParams({});
          }}
        >
          Back to category guidance
        </button>
        {groupId && (
          <span>
            {categories.find((category) => category.id === groupId)?.name ??
              'Category no longer in queue'}
          </span>
        )}
        {groupId && <button onClick={() => reviewCategory()}>Review all categories</button>}
      </div>
      {proposalError && <p role="alert">{proposalError}</p>}
      {scopeState.error && <p role="alert">{scopeState.error}</p>}
      <div className={styles.progress}>
        <progress value={completed} max={scopedEntries.length || 1} />
        <span>
          {completed} / {scopedEntries.length} reviewed ·{' '}
          {scopedEntries.filter((e) => e.status === 'drafted').length} drafts
        </span>
      </div>
      <div className={styles.filters}>
        <label>
          Find entry
          <input
            value={queueProgress.query}
            placeholder="Name or hash"
            onChange={(e) => filter({ query: e.target.value })}
          />
        </label>
        <label>
          Category
          <select
            value={
              groupId
                ? (categories.find((category) => category.id === groupId)?.entries[0]?.category ??
                  '')
                : queueProgress.category
            }
            onChange={(e) => {
              const next = new URLSearchParams(params);
              next.delete('group');
              filter({ category: e.target.value }, next);
            }}
          >
            <option value="">All categories</option>
            {editor.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Show
          <select
            value={queueProgress.filter}
            onChange={(e) => filter({ filter: e.target.value as ReviewProgress['filter'] })}
          >
            <option value="all">All entries</option>
            {Object.entries(labels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Proposal
          <select
            value={proposalFilter}
            onChange={(e) => {
              const next = new URLSearchParams(params);
              next.set('proposal', e.target.value);
              filter({}, next);
            }}
          >
            <option value="all">With or without</option>
            <option value="yes">Has proposal</option>
            <option value="no">No proposal</option>
          </select>
        </label>
        <button
          onClick={() => {
            setBulkPage(0);
            setBulk(createBulkPreview(editor, source, bulkEntries, proposals));
          }}
          disabled={!bulkEntries.length}
        >
          {matching ? 'Finding proposals…' : `Bulk preview (${bulkEntries.length})`}
        </button>
      </div>
      <div className={styles.notice} role="status">
        {message ||
          (canEdit
            ? 'Accept creates a local draft. Save when ready.'
            : 'Browsing only · linking requires a configured API and signed-in editor, trial or maintainer.')}
      </div>
      {error && <p role="alert">{error}</p>}
      {selected ? (
        <>
          <div className={styles.entryNav}>
            <button disabled={index <= 0} onClick={() => choose(filtered[index - 1].hash)}>
              ← Previous
            </button>
            <span>
              {index + 1} / {filtered.length} in filter
            </span>
            <button
              disabled={index >= filtered.length - 1}
              onClick={() => choose(filtered[index + 1].hash)}
            >
              Next →
            </button>
            <span>{labels[selected.status]}</span>
            {(selected.status === 'skipped' || selected.status === 'no-equivalent') && (
              <button
                onClick={() => {
                  snapshot();
                  update((state) =>
                    recordDecision(state, selected.hash, selected.evidence, 'open', selected.hash),
                  );
                  setParams(selectionParams(selected.hash), { replace: true });
                }}
              >
                Reopen decision
              </button>
            )}
          </div>
          <div className={styles.workspace}>
            <section className={styles.card} aria-label="Entry to review">
              <p className={styles.eyebrow}>
                {selected.category} · {selected.hash}
              </p>
              <h2>{selected.name}</h2>
              {selected.stale && <p>Source evidence changed; review again.</p>}
              <h3>Current English</h3>
              <pre>{selected.next.text.en?.text || 'No English text yet.'}</pre>
              <h3>Manifest</h3>
              {(manifest.get(selected.hash) ?? []).length ? (
                manifest.get(selected.hash)!.map((item) => (
                  <div key={item.hash} className={styles.manifestItem}>
                    <strong>{item.name || 'Unnamed item'}</strong> <small>· {item.hash}</small>
                    <pre>{item.inGameDescription || 'No manifest description available.'}</pre>
                  </div>
                ))
              ) : (
                <p>No manifest item available.</p>
              )}
              {importContext(
                selected.next.text.en?.text ?? '',
                editor.bundle.tooltips,
                editor.aliases,
              ).map((context, i) => (
                <details key={i}>
                  <summary>Authored import context</summary>
                  <pre>{context}</pre>
                </details>
              ))}
              <Link to={`/t/${selected.hash}`}>Inspect tooltip / draft ↗</Link>
            </section>
            <section className={styles.card} aria-label="Proposed source">
              <p className={styles.eyebrow}>
                {proposal?.link
                  ? 'Validated proposal · check scope'
                  : 'Candidate locations · manual selection required'}
              </p>
              {matches.length > 1 && (
                <label>
                  Compare candidate
                  <select value={candidate} onChange={(e) => setCandidate(Number(e.target.value))}>
                    {matches.map((m, i) => (
                      <option key={i} value={i}>
                        {m.tab.name} / {m.row.name} / row {m.row.rowIndex}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <ProposalContext match={match} source={source} />
              {!proposal?.link && hint && (
                <details>
                  <summary>Why this location?</summary>
                  <p>{hint.rationale}</p>
                </details>
              )}
            </section>
          </div>
          {picker && (
            <section
              className={styles.overlay}
              role="dialog"
              aria-modal="false"
              aria-label="Pick another source"
            >
              <header>
                <h2>Pick another source</h2>
                <button autoFocus onClick={() => setPicker(false)}>
                  Close picker
                </button>
              </header>
              <LinkPicker
                key={selected.hash}
                base={selected.base}
                name={selected.name}
                category={selected.category}
                suggestions={hints}
                readOnly={!canEdit}
                onBeforeLinked={(link) =>
                  snapshot([{ base: selected.base, before: selected.next.compendium, after: link }])
                }
                onLinked={() => {
                  update((state) =>
                    recordDecision(state, selected.hash, selected.evidence, 'open', nextHash),
                  );
                  setParams(selectionParams(nextHash), { replace: true });
                  setPicker(false);
                  setCandidate(0);
                  setMessage(`${selected.name}: link drafted, not saved.`);
                  keepEntryVisible();
                }}
              />
            </section>
          )}
        </>
      ) : (
        <section className={styles.empty}>
          <h2>Filter complete</h2>
          <p>Change filters to revisit decisions or find more entries.</p>
          <button
            onClick={() => {
              reviewCategory();
            }}
          >
            Show all unresolved
          </button>
        </section>
      )}
      {bulk && (
        <BulkPreview
          preview={bulk}
          page={bulkPage}
          canEdit={canEdit}
          current={bulkCurrent}
          onPage={setBulkPage}
          onCancel={() => setBulk(undefined)}
          onAccept={acceptBulk}
        />
      )}
      <footer ref={actionBar} className={styles.actionBar} aria-label="Review actions">
        <p className={styles.actionConsequence}>
          Links create local drafts, not saves · Skip/No equivalent stay in browser.
        </p>
        <button
          className={styles.primary}
          disabled={!canEdit || !proposal?.link || selected?.status !== 'open' || picker || !!bulk}
          onClick={accept}
        >
          Accept proposed link <kbd>A</kbd>
        </button>
        <button disabled={!selected || !!bulk} onClick={() => setPicker(!picker)}>
          Pick other <kbd>P</kbd>
        </button>
        <button disabled={!selected || picker || !!bulk} onClick={() => decide('no-equivalent')}>
          No equivalent <kbd>N</kbd>
        </button>
        <button disabled={!selected || picker || !!bulk} onClick={() => decide('skipped')}>
          Skip <kbd>S</kbd>
        </button>
        <button
          disabled={!undo || locked || (undo.links.length > 0 && !canEdit) || picker || !!bulk}
          onClick={undoLast}
        >
          Undo last <kbd>U</kbd>
        </button>
      </footer>
    </>
  );
}
