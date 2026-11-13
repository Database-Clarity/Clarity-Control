import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CompendiumPage } from './CompendiumPage';
import { compendiumChanges } from './tracking';
import type { CompendiumData } from '@clarity/core';
import { apiUrl } from '../../services/api';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl } from '../../services/compendium';
import { openDraftSaveReview } from '../../services/save/openReview';
import { useSaveState } from '../../services/save/state';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import {
  SkeletonBlock,
  SkeletonRows,
  SkeletonStatus,
  useSkeletonVisible,
} from '../../ui/Skeleton';
import { workspaceShortcutsBlocked } from '../../ui/interaction';
import { approvalEvidence } from './approvalEvidence';
import { useAdvanceSetting } from './advanceSetting';
import { candidateBlocks } from './candidateBlocks';
import { CompendiumActionBar } from './CompendiumActionBar';
import { CompendiumDetail } from './CompendiumDetail';
import { LinkPicker } from './LinkPicker';
import { PickerStage } from './PickerStage';
import { decidedKinds, openKinds, parseShow, queueCounts, type QueueRow } from './queueRows';
import { useCompendiumQueueStore } from './queueStore';
import {
  buildQueue,
  nextOpenRow,
  selectedRow,
  type CategoryInfo,
  type QueueFilters,
} from './queueView';
import { advanceHash, recordDecision, restoreLink } from './rapidReview';
import { mayDraftLink, reviewEvidence } from './reviewQueue';
import { sourceFingerprint, reviewStorageKey, type ReviewProgress } from './reviewProgress';
import {
  preparedDecisions,
  preparedEvidence,
  preparedProposals,
  preparedQueueRows,
  reviewedEntries,
} from './reviewViewCache';
import { researchSuggestions } from './researchSuggestions';
import { confirmCompendiumSelection } from './selection';
import { useCompendiumStore } from './store';
import { useDisplayMatches } from './useDisplayMatches';
import { useProposals } from './useProposals';
import { useReviewProgress } from './useReviewProgress';
import { groupManifestItems } from './manifestItems';
import styles from './CompendiumTab.module.scss';

const number = new Intl.NumberFormat('en');

type Undo = {
  progress: ReviewProgress;
  hash: number;
  links: { base: import('@clarity/core').Tooltip; before: unknown; after: unknown }[];
  revision: string;
};

/** The Compendium tab: the review queue's detail, decisions, and header counts. */
export function CompendiumTab() {
  const editor = useDataStore((state) => state.data);
  const { data, load, error } = useCompendiumStore();
  const { user, loading: authLoading } = useAuthStore();
  const drafts = useDraftStore((state) => state.drafts);
  const display = useDisplayMatches(editor, data, drafts, user?.id);
  const prepared = display.reviewPrepared;
  useEffect(() => {
    void load();
  }, [load]);
  const storageKey = reviewStorageKey(
    `${bundleUrl}|${compendiumDataUrl}|${apiUrl ?? 'read-only'}`,
    user?.id,
  );
  const [params] = useSearchParams();
  const ready =
    !!editor && !!data && !authLoading && (!!prepared || typeof Worker === 'undefined');
  const showSkeleton = useSkeletonVisible(!ready && !error, 'tab', false);
  if (params.get('tab') === 'linked')
    return (
      <article className={styles.tab} aria-label="Linked sources changed">
        <header className={styles.summary}>
          <h1 className={styles.heading}>Linked sources changed</h1>
          <Link to={{ search: withoutTab(params) }} className={styles.counts}>
            ← Back to the review queue
          </Link>
        </header>
        {error && (
          <p role="alert" className={styles.alert}>
            {error}
          </p>
        )}
        {editor && data && <CompendiumPage />}
      </article>
    );
  return (
    <article className={styles.tab} aria-label="Compendium review">
      {error && (
        <p role="alert" className={styles.alert}>
          {error}{' '}
          <button type="button" onClick={() => void load(true)}>
            Retry
          </button>
        </p>
      )}
      {display.error && (
        <p role="alert" className={styles.alert}>
          {display.error}
        </p>
      )}
      {ready && !showSkeleton ? (
        <Workspace
          key={storageKey}
          storageKey={storageKey}
          editor={editor}
          source={data}
          prepared={prepared}
        />
      ) : (
        !error && (
          <SkeletonStatus>
            <div className={styles.loading}>
              <SkeletonRows count={1} columns={[40, 30, 10]} rowHeight="1.75rem" />
              <SkeletonBlock />
            </div>
          </SkeletonStatus>
        )
      )}
    </article>
  );
}

function withTab(params: URLSearchParams) {
  const next = new URLSearchParams(params);
  next.set('tab', 'linked');
  return `?${next}`;
}
function withoutTab(params: URLSearchParams) {
  const next = new URLSearchParams(params);
  next.delete('tab');
  const search = next.toString();
  return search ? `?${search}` : '';
}

function loadRestored(scopeKey: string) {
  try {
    const raw = localStorage.getItem(scopeKey);
    const value: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(value) || !value.every((hash) => Number.isSafeInteger(hash)))
      throw new Error('Invalid stored restore list');
    return { hashes: new Set<number>(value), error: '' };
  } catch {
    return { hashes: new Set<number>(), error: 'Could not load restored scope from local storage.' };
  }
}

function Workspace({
  editor,
  source,
  storageKey,
  prepared,
}: {
  editor: EditorData;
  source: CompendiumData;
  storageKey: string;
  prepared?: ReturnType<typeof useDisplayMatches>['reviewPrepared'];
}) {
  const { progress, update, error: progressError } = useReviewProgress(storageKey);
  const [params, setParams] = useSearchParams();
  // A timer or listener set up in an earlier render must not write back that render's URL: a
  // search typed or a row tapped since then would be undone.
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const { drafts, hydrated } = useDraftStore();
  const user = useAuthStore((state) => state.user);
  const locked = useSaveState((state) => state.locked);
  const toggled = useCompendiumQueueStore((state) => state.toggled);
  const publish = useCompendiumQueueStore((state) => state.publish);
  const advanceMs = useAdvanceSetting((state) => state.ms);

  // Rows excluded by rule come back with Re-include; the choice is remembered on this device.
  const scopeKey = `review-scope-restored:${bundleUrl}|${compendiumDataUrl}`;
  const [scope, setScope] = useState(() => loadRestored(scopeKey));
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const fingerprint = useMemo(
    () => prepared?.fingerprint ?? sourceFingerprint(source.tabs),
    [source, prepared],
  );
  const evidence = useMemo(
    () =>
      prepared
        ? preparedEvidence(prepared, drafts, editor, source)
        : reviewEvidence(editor, source, drafts, fingerprint),
    [editor, source, drafts, fingerprint, prepared],
  );
  const entries = useMemo(() => reviewedEntries(evidence, progress), [evidence, progress]);
  const entryByHash = useMemo(() => new Map(entries.map((entry) => [entry.hash, entry])), [entries]);
  const { proposals: core, loading: matching, error: proposalError } = useProposals(editor, source);
  const proposals = useMemo(
    () => (prepared ? preparedProposals(prepared, core) : core),
    [core, prepared],
  );
  const categories = useMemo(
    () =>
      new Map<string, CategoryInfo>(
        editor.categories.map((category) => [
          category.id,
          { id: category.id, label: category.label, order: category.order ?? 9999 },
        ]),
      ),
    [editor.categories],
  );
  const modelReady = !matching || !!proposalError;
  const rows = useMemo(
    () =>
      modelReady ? preparedQueueRows(entries, prepared, proposals, scope.hashes, categories) : null,
    [modelReady, entries, prepared, proposals, scope.hashes, categories],
  );
  const counts = useMemo(() => queueCounts(rows ?? []), [rows]);

  const filters: QueueFilters = {
    show: parseShow(params.get('show')),
    query: params.get('q') ?? '',
    group: params.get('group') ?? '',
  };
  const hashParam = params.get('hash') ? Number(params.get('hash')) : undefined;
  const routeHash = hashParam !== undefined && Number.isSafeInteger(hashParam) ? hashParam : undefined;
  const model = useMemo(
    () =>
      buildQueue({
        rows: rows ?? [],
        filters,
        categories,
        toggled,
        hash: routeHash,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, filters.show, filters.query, filters.group, categories, toggled, routeHash],
  );
  const selected = rows ? selectedRow(rows, model.steps, routeHash) : undefined;
  const selectedEntry = selected && entryByHash.get(selected.hash);
  const stepIndex = selected ? model.steps.findIndex((row) => row.hash === selected.hash) : -1;
  const canEdit = mayDraftLink(user?.role, !!apiUrl, hydrated, locked);

  // ---- selection ----
  // `searches` are the URL at the decision and the URL holding the decided entry (the router may
  // apply the hold a render later); any other URL (a search, a filter, a row tapped in the queue,
  // Back) is the user going elsewhere, which cancels the move.
  const [pending, setPending] = useState<{
    from: number;
    next?: QueueRow;
    token: number;
    searches: string[];
  }>();
  const pendingTimer = useRef<ReturnType<typeof setTimeout>>();
  const [highlight, setHighlight] = useState(-1);
  const [picker, setPicker] = useState(false);
  const [message, setMessage] = useState('');
  const [undo, setUndo] = useState<Undo>();
  const clearPending = useCallback(() => {
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    pendingTimer.current = undefined;
    setPending(undefined);
  }, []);
  useEffect(() => () => clearTimeout(pendingTimer.current), []);
  const select = useCallback(
    (hash: number | undefined, mode: 'replace' | 'push' = 'replace') => {
      clearPending();
      setPicker(false);
      const next = new URLSearchParams(paramsRef.current);
      next.delete('tab');
      if (hash === undefined) next.delete('hash');
      else next.set('hash', String(hash));
      setParams(next, { replace: mode === 'replace' });
    },
    [setParams, clearPending],
  );
  const search = params.toString();
  useEffect(() => {
    if (pending && !pending.searches.includes(search)) clearPending();
  }, [pending, search, clearPending]);

  // Publish the model the left column renders; selection and filters travel in the URL.
  const restoreScope = useCallback(
    (hash: number) => {
      if (scopeRef.current.hashes.has(hash)) return;
      const hashes = new Set(scopeRef.current.hashes);
      hashes.add(hash);
      let failure = '';
      try {
        localStorage.setItem(scopeKey, JSON.stringify([...hashes]));
      } catch {
        failure = 'Could not save restored scope to local storage.';
      }
      setScope({ hashes, error: failure });
    },
    [scopeKey],
  );
  const decisionNow = useRef<(kind: 'open' | 'skipped' | 'no-equivalent', hash: number) => void>();
  decisionNow.current = (kind, hash) => {
    const entry = entryByHash.get(hash);
    if (entry) update((state) => recordDecision(state, hash, entry.evidence, kind));
  };
  const reinclude = useCallback(
    (row: QueueRow) => {
      if (row.excluded === 'local') decisionNow.current?.('open', row.hash);
      else restoreScope(row.hash);
      setMessage(`${row.name}: back in the queue.`);
    },
    [restoreScope],
  );
  useEffect(() => {
    publish({
      rows,
      counts,
      categories,
      model,
      selected: selected?.hash,
      reinclude: rows ? reinclude : undefined,
      error: proposalError,
    });
  }, [publish, rows, counts, categories, model, selected?.hash, reinclude, proposalError]);
  useEffect(() => () => publish({ rows: null, selected: undefined, reinclude: undefined }), [publish]);

  // ---- the selected entry's evidence ----
  const decision = selected && preparedDecisions(prepared).get(selected.hash);
  const proposal = selected && proposals.get(selected.hash);
  const manifestItems = useMemo(
    () => (selected ? (groupManifestItems(editor.items, editor.aliases).get(selected.hash) ?? []) : []),
    [selected, editor.items, editor.aliases],
  );
  const wantsHints = !!selected && (picker || selected.kind === 'candidates' || selected.kind === 'none');
  const hints = useMemo(
    () =>
      wantsHints && selected && selectedEntry
        ? researchSuggestions(selected.hash, source, selectedEntry.category, selectedEntry.name)
        : [],
    [wantsHints, selected, selectedEntry, source],
  );
  const blocks = useMemo(
    () => (selected ? candidateBlocks({ decision, proposal, source, hints }) : []),
    [selected, decision, proposal, source, hints],
  );
  const approved = useMemo(() => {
    if (selected?.kind !== 'changed' || !selectedEntry || !blocks[0]) return undefined;
    return approvalEvidence(selected.hash, selectedEntry.name, selectedEntry.category, blocks[0].match);
  }, [selected, selectedEntry, blocks]);
  // The proposal is highlighted by default; a fuzzy candidate needs an explicit choice.
  const selectedHash = selected?.hash;
  useEffect(() => {
    setHighlight(blocks[0]?.origin === 'proposal' ? 0 : -1);
    setMessage('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHash, blocks.length]);
  const block = blocks[highlight];

  // ---- decisions ----
  const openForDecision =
    !!selected && (openKinds.includes(selected.kind) || selected.kind === 'skipped');
  const advanceFrom = (row: QueueRow) => {
    const next = nextOpenRow(model.steps, row.hash);
    // The decided entry stays open (and listed) until the move, so the pause shows what happened.
    const before = paramsRef.current.toString();
    const held = new URLSearchParams(paramsRef.current);
    if (routeHash !== row.hash) {
      held.set('hash', String(row.hash));
      setParams(held, { replace: true });
    }
    if (advanceMs === 0) {
      select(next?.hash);
      return;
    }
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    setPending({ from: row.hash, next, token: Date.now(), searches: [before, held.toString()] });
    pendingTimer.current = setTimeout(() => {
      pendingTimer.current = undefined;
      setPending(undefined);
      select(next?.hash);
    }, advanceMs);
  };
  const snapshot = (hash: number, links: Undo['links'] = []) =>
    setUndo({ progress, hash, links, revision: editor.bundle.sourceCommit });
  const decide = (kind: 'skipped' | 'no-equivalent') => {
    if (!selected || !selectedEntry || !openForDecision || pending) return;
    snapshot(selected.hash);
    update((state) => recordDecision(state, selected.hash, selectedEntry.evidence, kind));
    setMessage(
      `${selected.name}: ${kind === 'skipped' ? 'skipped' : 'marked not needed'} on this device.`,
    );
    advanceFrom(selected);
  };
  const canConfirm =
    canEdit && openForDecision && !picker && !pending && !!block?.link && block.origin !== 'hint';
  const confirm = () => {
    if (!canConfirm || !selected || !selectedEntry || !block?.link) return;
    const link = block.link;
    snapshot(selected.hash, [
      { base: selectedEntry.base, before: selectedEntry.next.compendium, after: link },
    ]);
    useDraftStore
      .getState()
      .updateDraft(selectedEntry.base, (next) => ({ ...next, compendium: link }));
    update((state) => recordDecision(state, selected.hash, selectedEntry.evidence, 'open'));
    setMessage(`${selected.name}: link drafted, not saved.`);
    advanceFrom(selected);
  };
  const undoLast = () => {
    if (!undo || locked || (undo.links.length > 0 && !canEdit)) return;
    if (
      undo.revision !== editor.bundle.sourceCommit ||
      undo.links.some(
        ({ base, before, after }) =>
          !restoreLink(
            useDraftStore.getState().drafts[base.hash]?.next ?? editor.bundle.tooltips[base.hash] ?? base,
            before as never,
            after as never,
          ),
      )
    ) {
      setMessage('Cannot undo: this link or saved data changed. Inspect the draft first.');
      return;
    }
    useDraftStore.getState().updateDrafts(
      undo.links.map(({ base, before, after }) => ({
        base,
        update: (next) => restoreLink(next, before as never, after as never)!,
      })),
    );
    update(() => undo.progress);
    select(undo.hash);
    setUndo(undefined);
    setMessage('Last decision undone.');
  };

  // ---- keyboard ----
  const handlers = useRef({ confirm, decide, undoLast, select });
  handlers.current = { confirm, decide, undoLast, select };
  const keyState = useRef({ model, selected, stepIndex, blocks, pending, picker, canEdit });
  keyState.current = { model, selected, stepIndex, blocks, pending, picker, canEdit };
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || workspaceShortcutsBlocked(event)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const state = keyState.current;
      const target = event.target instanceof Element ? event.target : undefined;
      const typing = !!target?.closest('input, textarea, select, [contenteditable="true"]');
      const control = !!target?.closest('button, a[href], summary');
      const key = event.key;
      if (key === '/' && !typing) {
        const search = document.querySelector<HTMLInputElement>('[data-compendium-search]');
        if (search) {
          event.preventDefault();
          search.focus();
        }
        return;
      }
      if (typing) return;
      if (key === 'Escape') {
        if (state.picker) return;
        if (state.pending) {
          event.preventDefault();
          clearPending();
        }
        return;
      }
      if (state.picker) return;
      const lower = key.toLowerCase();
      const steps = state.model.steps;
      const move = (to: number) => {
        if (!steps.length) return;
        const row = steps[Math.max(0, Math.min(steps.length - 1, to))];
        event.preventDefault();
        handlers.current.select(row.hash);
      };
      if (state.pending && (key === 'Enter' || key === 'ArrowDown' || lower === 'j')) {
        // Advance now, once, to the entry the bar announced.
        event.preventDefault();
        const next = state.pending.next;
        if (pendingTimer.current) clearTimeout(pendingTimer.current);
        pendingTimer.current = undefined;
        setPending(undefined);
        handlers.current.select(next?.hash);
        return;
      }
      const index = state.stepIndex < 0 ? 0 : state.stepIndex;
      if (key === 'ArrowDown' || lower === 'j') return move(index + 1);
      if (key === 'ArrowUp' || lower === 'k') return move(index - 1);
      if (key === 'Home') return move(0);
      if (key === 'End') return move(steps.length - 1);
      if (key === 'PageDown') return move(index + 10);
      if (key === 'PageUp') return move(index - 10);
      if (state.pending) {
        // Never act on an entry the user has not seen yet.
        if (lower === 'u') {
          event.preventDefault();
          handlers.current.undoLast();
        } else if (['a', 'n', 's', 'p'].includes(lower) || (key >= '1' && key <= '9')) {
          event.preventDefault();
        }
        return;
      }
      if (key >= '1' && key <= '9') {
        if (Number(key) <= state.blocks.length) {
          event.preventDefault();
          setHighlight(Number(key) - 1);
        }
        return;
      }
      if (key === 'Enter' && !control) {
        event.preventDefault();
        handlers.current.confirm();
      } else if (lower === 'a') {
        event.preventDefault();
        handlers.current.confirm();
      } else if (lower === 'p' && state.selected) {
        event.preventDefault();
        setPicker(true);
      } else if (lower === 'n') {
        event.preventDefault();
        handlers.current.decide('no-equivalent');
      } else if (lower === 's') {
        event.preventDefault();
        handlers.current.decide('skipped');
      } else if (lower === 'u') {
        event.preventDefault();
        handlers.current.undoLast();
      }
    }
    // Typing in the queue search during the pause keeps the decided entry: the search commits to
    // the URL only after a short delay, which could land after the move.
    function input(event: Event) {
      const target = event.target instanceof Element ? event.target : undefined;
      if (keyState.current.pending && target?.closest('[data-compendium-search]')) clearPending();
    }
    window.addEventListener('keydown', keydown);
    window.addEventListener('input', input, true);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('input', input, true);
    };
  }, [clearPending]);

  // ---- render ----
  const draftCount = Object.keys(drafts).length;
  const linkedChanges = useMemo(
    () => compendiumChanges(editor.bundle.tooltips, source).length,
    [editor.bundle.tooltips, source],
  );
  const linkTo = (show: string) => {
    const next = new URLSearchParams(params);
    next.set('show', show);
    next.delete('hash');
    return `?${next}`;
  };
  const filtered = filters.show !== 'open' || !!filters.query || !!filters.group;
  const empty = rows !== null && !selected;
  const readOnlyReason = canEdit
    ? undefined
    : 'Viewing only: sign in as an editor to link.';
  const categoryOf = (id: string) => categories.get(id)?.label ?? `Other: ${id}`;
  const fromEditor = model.items.some(
    (item) =>
      item.type === 'row' &&
      item.pinned &&
      item.row.hash === selected?.hash &&
      !decidedKinds.includes(item.row.kind),
  );
  return (
    <>
      <header className={styles.summary}>
        <h1 className="sr-only">Compendium</h1>
        <p className={styles.counts}>
          <Link to={linkTo('open')}>{number.format(counts.open)} to review</Link>
          {' · '}
          <Link to={linkTo('matched')}>
            {number.format(counts.matched)} matched automatically
          </Link>
          {' · '}
          <Link to={linkTo('all')}>{number.format(counts.notNeeded)} not needed</Link>
        </p>
        <Link
          className={styles.linked}
          to={{ search: withTab(params) }}
          aria-label={`Linked sources changed (${linkedChanges})`}
        >
          <span className={styles.long}>Linked sources changed</span>
          <span className={styles.short}>Linked</span> ({linkedChanges})
        </Link>
        <button
          type="button"
          className={styles.save}
          disabled={!apiUrl || !user?.role || !draftCount || locked}
          onClick={openDraftSaveReview}
        >
          Save drafts ({draftCount})
        </button>
      </header>
      {(progressError || scope.error) && (
        <p role="alert" className={styles.alert}>
          {progressError || scope.error}
        </p>
      )}
      {readOnlyReason && rows !== null && <p className={styles.viewerNote}>{readOnlyReason}</p>}
      {rows === null ? (
        <SkeletonStatus>
          <div className={styles.loading}>
            <SkeletonBlock />
          </div>
        </SkeletonStatus>
      ) : selected ? (
        <CompendiumDetail
          row={selected}
          categoryLabel={categoryOf(selected.category)}
          position={stepIndex >= 0 ? { index: stepIndex + 1, total: model.steps.length } : undefined}
          manifest={manifestItems}
          currentText={selectedEntry?.next.text.en?.text}
          blocks={blocks}
          highlight={highlight}
          onHighlight={setHighlight}
          source={source}
          approved={approved}
          stale={selectedEntry?.stale}
          outsideFilter={fromEditor}
          onReinclude={
            selected.kind === 'not-needed' && canEdit !== undefined ? () => reinclude(selected) : undefined
          }
          onStep={(direction) => {
            const to = model.steps[Math.max(0, stepIndex) + direction];
            if (to) select(to.hash);
          }}
        />
      ) : (
        <section className={styles.emptyState} aria-label="Nothing to show">
          {filtered ? (
            <p>
              Nothing matches.{' '}
              <Link to="?">Clear filters</Link>
            </p>
          ) : (
            <p>
              Nothing left to review · {number.format(counts.matched)} matched ·{' '}
              {number.format(counts.notNeeded)} not needed · <Link to="/">Open the Editor</Link>
            </p>
          )}
        </section>
      )}
      {empty ? null : (
        <CompendiumActionBar
          canConfirm={canConfirm}
          canPick={canEdit && !!selected && selected.kind !== 'not-needed' && !pending}
          canDecide={!!selected && openForDecision && !pending}
          canUndo={!!undo && !locked && !(undo.links.length > 0 && !canEdit)}
          readOnlyReason={readOnlyReason}
          message={message}
          advancing={
            pending && { name: pending.next?.name ?? 'end of queue', ms: advanceMs, token: pending.token }
          }
          onConfirm={confirm}
          onPick={() => setPicker(true)}
          onNone={() => decide('no-equivalent')}
          onSkip={() => decide('skipped')}
          onUndo={undoLast}
        />
      )}
      {selected && selectedEntry && (
        <PickerStage open={picker} onBack={() => setPicker(false)}>
          <LinkPicker
            key={selected.hash}
            base={selectedEntry.base}
            name={selectedEntry.name}
            category={selectedEntry.category}
            suggestions={hints}
            readOnly={!canEdit}
            onBeforeLinked={(link) =>
              snapshot(selected.hash, [
                { base: selectedEntry.base, before: selectedEntry.next.compendium, after: link },
              ])
            }
            onLinked={() => {
              update((state) => recordDecision(state, selected.hash, selectedEntry.evidence, 'open'));
              setPicker(false);
              setMessage(`${selected.name}: link drafted, not saved.`);
              advanceFrom(selected);
            }}
          />
        </PickerStage>
      )}
    </>
  );
}

export { advanceHash, confirmCompendiumSelection };
