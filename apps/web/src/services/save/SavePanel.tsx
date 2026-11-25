import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { resolveCompendiumLink, type CompendiumData } from '@clarity/core';
import { apiUrl, type User } from '../api';
import { loadCompendium } from '../compendium';
import { errorMessage } from '../http';
import { sameUser, useAuthStore } from '../../stores/auth';
import { sessionToken } from '../session';
import { useDataStore } from '../../stores/data';
import {
  useConflictStore,
  useOpenConflicts,
  usePausedForOtherTab,
  type BeginResult,
} from '../../stores/conflicts';
import { useDraftStore } from '../../stores/drafts';
import { usePreviewReviewStore } from '../../stores/previewReview';
import { publishLanguages } from '../../features/auth/permissions';
import { CompendiumDiff } from '../../features/compendium/CompendiumDiff';
import { SourceRef } from '../../features/compendium/SourceRef';
import { linkLocation, matchLocation } from '../../features/compendium/sourceLocation';
import { useCompendiumStore } from '../../features/compendium/store';
import { Dialog } from '../../ui/Dialog';
import styles from './SavePanel.module.scss';
import { saveCurrent, saveRemainder } from './currentSave';
import { useSaveNotice } from './notice';
import { startSaveRecovery } from './recovery';
import { permissionError, prepareChanges } from './pipeline';
import { requestSaveValidation } from './validationWorker';
import { liveFallback, noImpactAvailable } from './fallback';
import type { TooltipValidationIssue } from '@clarity/core';
import { useSaveProgress, useSaveState, type SaveReview } from './state';
import { openDraftSaveReview } from './openReview';
import { changedSources, linksCompendium, sourceKey, type ChangedSource } from './compendiumSource';
import { SaveSummary } from './SaveSummary';
import type { Destination } from '../../features/review/batches/saveDestination';

// Scheduled changes (P3a): the Destination row and the batch save path. The build-switch test is
// inline on the import, so a switch-OFF build has neither (I6).
const destinationChunk = () =>
  import.meta.env.VITE_SCHEDULED_ENABLED === '1'
    ? import('../../features/review/batches/Destination')
    : Promise.reject(new Error('Scheduled changes are off'));
const DestinationRow =
  import.meta.env.VITE_SCHEDULED_ENABLED === '1'
    ? lazy(() => destinationChunk().then((module) => ({ default: module.DestinationRow })))
    : null;

/**
 * The save session controller: always mounted by the Layout, independent of any popover, so
 * closing the drafts popover never loses a conflict, the submitted snapshot, or a result.
 */
export function SaveController() {
  const review = useSaveState((state) => state.review);
  const generation = useDraftStore((state) => state.generation);
  const showNotice = useSaveNotice((state) => state.show);
  // Conflict rows and their saved copy follow the drafts of the signed-in account.
  useEffect(() => useConflictStore.getState().start(), []);
  useEffect(startSaveRecovery, []);
  useEffect(() => {
    // A review lists one account's drafts: switching accounts closes it, keeping the drafts.
    return () => {
      if (useSaveState.getState().review) useSaveState.getState().close();
    };
  }, [generation]);
  return review ? <SaveSession review={review} onSaved={showNotice} /> : null;
}

/**
 * The drafts popover or sheet body: how many drafts, the last save result, the `children` (the
 * draft rows) and the one primary action, Review and save. The review itself is the controller's;
 * `onReview` lets the host close its overlay before the native dialog opens.
 */
export function SavePanel({
  className,
  onReview,
  onResolve,
  children,
}: {
  className?: string;
  onReview?: () => void;
  /** Takes the user to a tooltip that still has conflicts to resolve. */
  onResolve?: (hash: number) => void;
  children?: ReactNode;
}) {
  const drafts = useDraftStore((state) => state.drafts);
  const user = useAuthStore((state) => state.user);
  const review = useSaveState((state) => state.review);
  const notice = useSaveNotice((state) => state.notice);
  const dismiss = useSaveNotice((state) => state.dismiss);
  const count = Object.keys(drafts).length;
  const conflicts = useOpenConflicts();
  const paused = usePausedForOtherTab();
  const open = conflicts.reduce((sum, conflict) => sum + conflict.total, 0);
  // Edits no Base/Enhanced preview has shown yet. Saving stays allowed: this only says so.
  const unpreviewed = usePreviewReviewStore(
    (state) => Object.values(state.entries).filter((entry) => entry.dirty > entry.reviewed).length,
  );
  const action =
    open > 0 ? (
      // Saving waits until every conflict is resolved; this takes the user to the next one.
      <button
        type="button"
        data-autofocus
        data-drafts-resolve
        onClick={() => {
          onReview?.();
          onResolve?.(conflicts[0]!.hash);
        }}
      >
        {open === 1 ? 'Resolve 1 conflict' : `Resolve ${open} conflicts`}
      </button>
    ) : (
      <button
        type="button"
        data-autofocus
        data-drafts-review
        disabled={!apiUrl || !user?.role || !count || Boolean(review) || paused}
        onClick={() => {
          dismiss();
          onReview?.();
          openDraftSaveReview();
        }}
      >
        {count > 1 ? `Review and save ${count} drafts` : 'Review and save draft'}
      </button>
    );
  // The count and the one primary action share the pinned head line, above any list, so the
  // action is reachable without scrolling at any draft count.
  return (
    <section aria-label="Save drafts" className={className}>
      <div className={styles.head}>
        <p data-summary>
          {count === 0 ? 'No local drafts' : `${count} local ${count === 1 ? 'draft' : 'drafts'}`}
        </p>
        {action}
      </div>
      {unpreviewed > 0 && (
        <p data-unpreviewed>
          {unpreviewed === 1 ? '1 change' : `${unpreviewed} changes`} not previewed. You can still
          save.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {children}
    </section>
  );
}

/** What the user is told when somebody else saved the same tooltips first. */
export function conflictNotice(outcome: BeginResult, saved = 0): string {
  const tooltips = outcome.tooltips === 1 ? '1 tooltip' : `${outcome.tooltips} tooltips`;
  const open = outcome.markers + outcome.rows;
  const merged = outcome.merged
    ? ` ${outcome.merged} text${outcome.merged === 1 ? '' : 's'} merged automatically.`
    : '';
  const prefix = saved
    ? `Saved ${saved} tooltip(s). The remaining drafts were kept.`
    : 'Nothing was saved:';
  const changed = `${prefix} ${tooltips} changed on the server meanwhile.`;
  return open > 0
    ? `${changed} Resolve ${open === 1 ? '1 conflict' : `${open} conflicts`} in the editor, then review and save again.${merged}`
    : `${changed}${merged || ' Your edits were merged.'} Review and save again.`;
}

/**
 * The chunked-save progress bar, in the pinned review footer above Save. The Save button names the
 * step ("Saving 200 of 415", "Staging ...", "Retry") and the alert line carries a failure, so the
 * bar is only the picture of how far a multi-part save has got.
 */
function SaveProgressBar() {
  const progress = useSaveState((state) => state.progress);
  if (progress.total < 2 || (progress.phase !== 'saving' && progress.phase !== 'staging'))
    return null;
  return (
    <progress
      className={styles.progress}
      max={progress.total}
      value={progress.done}
      aria-hidden="true"
    />
  );
}

const accountChanged = (generation: number) => useDraftStore.getState().generation !== generation;

/** The Review row of the first translation a save changed that this account can publish. */
function savedTranslation(changes: SaveReview['changes'], user: User | null): string | undefined {
  for (const { hash, base, next, translationRevisions } of changes)
    for (const lang of publishLanguages(user))
      if (
        translationRevisions?.[lang] !== undefined ||
        base?.text[lang]?.text !== next.text[lang]?.text
      )
        return `/review?hash=${encodeURIComponent(`${hash}:${lang}`)}`;
}

function SaveSession({
  review,
  onSaved,
}: {
  review: SaveReview;
  onSaved(message: string, review?: string): void;
}) {
  const data = useDataStore((state) => state.data);
  const user = useAuthStore((state) => state.user);
  const close = useSaveState((state) => state.close);
  const changes = review.changes;
  const openConflicts = useOpenConflicts();
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progress = useSaveProgress();
  // Where this save goes: Current, or a batch (maintainers and editors, switch ON only).
  const [destination, setDestination] = useState<Destination>({ kind: 'current' });
  // A scheduled-batch refusal the Destination row can foresee.
  const [destinationBlocked, setDestinationBlocked] = useState<string | null>(null);
  // Maintainers and editors only (root 2026-11-14: translators get no Destination row until the
  // later destination task; trials get no batch access, Q3). The Worker stays the guard.
  const batchSaver = user?.role === 'maintainer' || user?.role === 'editor';
  const batchAvailable =
    batchSaver && !changes.some(({ translationRevisions }) => translationRevisions);
  const batchTarget =
    DestinationRow && batchAvailable && destination.kind !== 'current' ? destination : null;
  // "No translation impact" (TR3): editors and maintainers, direct saves only, and only when an
  // English wording change on a translated tooltip would otherwise stamp a new English revision.
  // The Worker enforces the role and records the tick in History.
  const [noImpact, setNoImpact] = useState(false);
  const impactChoice = useMemo(() => noImpactAvailable(changes), [changes]);
  const showImpact = batchSaver && !batchTarget && impactChoice;
  const noTranslationImpact = showImpact && noImpact;
  // The languages whose live output this save turns into the English fallback (validated).
  const fallback = useMemo(
    () =>
      liveFallback(changes, new Date().toISOString(), noTranslationImpact, data?.bundle.tooltips),
    [changes, noTranslationImpact, data?.bundle.tooltips],
  );
  // Linked Compendium cells that changed since they were shown, and the ones the reviewer ticked.
  const [changedSource, setChangedSource] = useState<ChangedSource[]>([]);
  const [freshSource, setFreshSource] = useState<CompendiumData | null>(null);
  const [acknowledged, setAcknowledged] = useState<string | null>(null);
  const needsAcknowledgement =
    changedSource.length > 0 && acknowledged !== sourceKey(changedSource);
  const validationKey = useMemo(
    () => `${JSON.stringify(changes)}\n${JSON.stringify(fallback)}`,
    [changes, fallback],
  );
  const [validated, setValidated] = useState<{
    data: typeof data;
    key: string;
    issues: TooltipValidationIssue[];
    error: string | null;
  } | null>(null);
  const validation =
    validated?.data === data && validated?.key === validationKey ? validated : null;
  useEffect(() => {
    let current = true;
    if (data) {
      void requestSaveValidation(changes, data, fallback).then(
        (issues) => {
          if (current) setValidated({ data, key: validationKey, issues, error: null });
        },
        (error: unknown) => {
          if (current)
            setValidated({ data, key: validationKey, issues: [], error: errorMessage(error) });
        },
      );
    }
    return () => {
      current = false;
    };
  }, [changes, data, fallback, validationKey]);
  const denied = permissionError(changes, user);
  // Marker blocks are also caught by validation; this covers a conflict's non-text rows.
  const unresolved = openConflicts.some((conflict) =>
    changes.some((change) => change.hash === conflict.hash),
  );
  const paused = usePausedForOtherTab();
  const blocked = Boolean(
    denied ||
    unresolved ||
    paused ||
    !validation ||
    validation?.error ||
    validation?.issues.some((issue) => issue.severity === 'error') ||
    (!changes.length && !batchTarget) ||
    (batchTarget?.kind === 'new' && !batchTarget.name.trim()) ||
    (batchTarget && destinationBlocked),
  );
  async function submit() {
    if (!data || !user || pending || blocked || reloadRequired) return;
    setPending(true);
    setError(null);
    const drafts = useDraftStore.getState();
    const generation = drafts.generation;
    let checkedSources = changedSource;
    let staged: { id: string; confirmed: ReadonlySet<number>; total: number } | undefined;
    const retainRemainder = (accepted: ReadonlySet<number>) => {
      if (!accepted.size) return;
      const remainingSources = checkedSources.filter(({ hash }) => !accepted.has(hash));
      if (acknowledged === sourceKey(checkedSources)) setAcknowledged(sourceKey(remainingSources));
      setChangedSource(remainingSources);
      useSaveState.setState({ review: saveRemainder(review, accepted) });
    };
    try {
      await drafts.flush();
      if (accountChanged(generation)) return;
      if (useDraftStore.getState().error)
        throw new Error(
          'Local drafts are not safely stored. Close this review and retry draft storage.',
        );
      // Saving English text on a linked tooltip records the Compendium cell as reviewed. Fetch
      // the current source now; if it differs from what the editor was shown, show the new diff
      // and wait for an explicit tick. What was fetched and ticked is exactly what gets recorded.
      let source: CompendiumData | undefined;
      if (linksCompendium(changes)) {
        source = await loadCompendium(true);
        if (accountChanged(generation)) return;
        const found = changedSources(changes, useCompendiumStore.getState().data, source);
        checkedSources = found;
        setChangedSource(found);
        setFreshSource(source);
        if (found.length && acknowledged !== sourceKey(found)) {
          setError(
            'The Compendium changed since it was last shown. Review the differences below and tick the box to continue; nothing was saved.',
          );
          return;
        }
      }
      // A catalogue refresh during storage/source awaits invalidates the reviewed verdict.
      if (useDataStore.getState().data !== data || useSaveState.getState().review !== review)
        throw new Error('The save snapshot changed. Review the current validation before saving.');
      const prepared = await prepareChanges(changes, user, data, source, {
        noTranslationImpact,
      });
      if (useDataStore.getState().data !== data || useSaveState.getState().review !== review)
        throw new Error('The save snapshot changed. Review the current validation before saving.');
      if (accountChanged(generation)) return;
      // The request reads the session token when it is sent: refuse unless it is still the one
      // this user was loaded with (another tab may have signed in as someone else meanwhile).
      const auth = useAuthStore.getState();
      if (auth.loading || !sameUser(auth.user, user) || auth.token !== sessionToken())
        throw new Error('Your login changed. Close this review and check your role.');
      const token = auth.token;
      const sameSession = () => {
        if (accountChanged(generation)) return false;
        const now = useAuthStore.getState();
        return (
          !now.loading &&
          sameUser(now.user, user) &&
          now.token === token &&
          sessionToken() === token
        );
      };
      if (batchTarget) {
        // A batch save is several requests: each one goes out only while the session is still
        // the one checked above (settled auth, same user, same token; the draft generation lags
        // a token change while /me loads). Asked before create, after awaits, and per chunk.
        const { saveReviewToBatch } = await destinationChunk();
        const notice = await saveReviewToBatch(
          batchTarget,
          prepared,
          message.trim() || `Update ${changes.length} tooltip(s)`,
          review.submitted,
          sameSession,
          (staged) => prepareChanges(staged, user, data, source),
          undefined,
          (id, confirmed, total, uploaded) => {
            staged = { id, confirmed, total };
            if (sameSession() && useSaveState.getState().review === review)
              useSaveState.setState({
                progress: {
                  phase: uploaded === undefined ? 'saving' : 'staging',
                  done: progress.done + (uploaded ?? confirmed.size),
                  total: progress.done + total,
                  failed: null,
                },
              });
          },
        );
        if (accountChanged(generation)) return;
        if (source) useCompendiumStore.setState({ data: source });
        onSaved(notice);
        close();
        return;
      }
      const result = await saveCurrent({
        prepared,
        review,
        data,
        message: message.trim() || `Update ${progress.total || changes.length} tooltip(s)`,
        noTranslationImpact,
        sameSession,
        accountChanged: () => accountChanged(generation),
      });
      if (result.kind === 'interrupted') {
        if (result.commit && accountChanged(generation))
          onSaved(
            `Remote save ${result.commit.slice(0, 8)} succeeded, but you switched accounts meanwhile. The drafts stay with the account that made them: sign back in to it and reload data.`,
          );
        return;
      }
      if (accountChanged(generation) || useSaveState.getState().review !== review) return;
      const saved = progress.done + result.accepted.size;
      if (result.kind === 'conflicts') {
        const outcome = useConflictStore
          .getState()
          .begin(result.result.conflicts, result.kept, result.result.serverAt);
        onSaved(conflictNotice(outcome, saved));
        close();
      } else if (result.kind === 'failed') {
        retainRemainder(result.accepted);
        setReloadRequired(!!result.reload);
        const status = saved
          ? `Saved ${saved} of ${saved + changes.length - result.accepted.size} tooltips. Remaining drafts were kept.`
          : 'Nothing was confirmed saved.';
        setError(`${result.error}. ${status}${result.reload ? '' : ' Retry when ready.'}`);
      } else {
        if (source) useCompendiumStore.setState({ data: source });
        const skipped = result.skippedConfirmations;
        onSaved(
          `Saved ${saved} tooltip(s). Latest commit ${result.commit.slice(0, 8)}.${
            skipped
              ? ` Skipped ${skipped} translation confirmation(s). Check whether the tooltip was archived or needs a number updated.`
              : ''
          }`,
          savedTranslation(changes, user),
        );
        close();
      }
    } catch (error) {
      if (!accountChanged(generation) && useSaveState.getState().review === review) {
        const failure = errorMessage(error);
        if (staged) {
          retainRemainder(staged.confirmed);
          setDestination({ kind: 'batch', id: staged.id });
          useSaveState.setState({
            progress: {
              phase: 'failed',
              done: progress.done + staged.confirmed.size,
              total: progress.done + staged.total,
              failed: failure,
            },
          });
        }
        setError(failure);
      }
    } finally {
      if (!accountChanged(generation)) setPending(false);
    }
  }
  return (
    <Dialog
      title="Review save"
      className={styles.review}
      busy={pending}
      onClose={close}
      footer={
        <>
          <SaveProgressBar />
          <button
            type="button"
            disabled={pending || blocked || !data || reloadRequired || needsAcknowledgement}
            onClick={() => void submit()}
          >
            {pending
              ? progress.phase === 'landing'
                ? 'Edits are landing (usually about a minute)'
                : progress.phase === 'staging'
                  ? progress.done === progress.total
                    ? 'Staged edits are still landing'
                    : `Staging ${progress.done} of ${progress.total}`
                  : progress.phase === 'saving' && progress.total > 1
                    ? `Saving ${progress.done} of ${progress.total}`
                    : 'Saving...'
              : !validation && data
                ? 'Validating...'
                : batchTarget
                  ? progress.phase === 'failed'
                    ? 'Retry'
                    : 'Save to batch'
                  : progress.phase === 'failed' && !reloadRequired
                    ? 'Retry'
                    : 'Save changes'}
          </button>
          <button type="button" disabled={pending} onClick={close}>
            Cancel; keep local drafts
          </button>
        </>
      }
    >
      {DestinationRow && batchAvailable && (
        <Suspense fallback={null}>
          <DestinationRow
            value={destination}
            changes={changes}
            disabled={pending}
            onChange={setDestination}
            onBlocked={setDestinationBlocked}
          />
        </Suspense>
      )}
      {!validation && data && <p role="status">Validating save...</p>}
      {data && <SaveSummary changes={changes} issues={validation?.issues ?? []} data={data} />}
      {changedSource.length > 0 && data && (
        <section aria-label="Compendium source changed">
          <h3>Compendium source changed</h3>
          <p>
            The Compendium changed after it was last shown to you. Saving records the new text as
            reviewed.
          </p>
          {changedSource.map(({ hash, shown, fresh }) => {
            const link = changes.find((change) => change.hash === hash)?.next.compendium;
            const resolved = link && freshSource && resolveCompendiumLink(link, freshSource);
            const location =
              link &&
              (resolved && 'row' in resolved
                ? matchLocation(resolved, freshSource)
                : linkLocation(link, freshSource, { stale: true }));
            return (
              <section key={hash} aria-label={`Compendium change for ${hash}`}>
                <h4>
                  {data.items[hash]?.name ??
                    changes.find((c) => c.hash === hash)?.next.custom?.name ??
                    hash}{' '}
                  ({hash})
                </h4>
                {location && (
                  <p>
                    Compendium source: <SourceRef location={location} />
                  </p>
                )}
                <CompendiumDiff before={shown} after={fresh} />
              </section>
            );
          })}
          <label>
            <input
              type="checkbox"
              checked={!needsAcknowledgement}
              disabled={pending}
              onChange={(event) =>
                setAcknowledged(event.target.checked ? sourceKey(changedSource) : null)
              }
            />{' '}
            I have reviewed these Compendium changes
          </label>
        </section>
      )}
      {(denied || validation?.error || error) && (
        <p role="alert">{denied || validation?.error || error}</p>
      )}
      {unresolved && <p role="alert">Resolve the open conflicts before saving.</p>}
      {paused && (
        <p role="alert">Another tab changed your drafts. Choose Reload or Keep mine first.</p>
      )}
      {validation?.issues.some((issue) => issue.severity === 'warning') && (
        <p>Warnings do not block saving.</p>
      )}
      {showImpact && (
        <div className={styles.impact}>
          <input
            id="save-no-impact"
            type="checkbox"
            checked={noImpact}
            disabled={pending}
            aria-describedby="save-no-impact-hint"
            onChange={(event) => setNoImpact(event.target.checked)}
          />
          <label htmlFor="save-no-impact">No translation impact</label>
          <p id="save-no-impact-hint">
            For wording fixes that keep the meaning: translations stay current, and this change does
            not count toward their 90-day English fallback. History marks this save.
          </p>
        </div>
      )}
      <details>
        <summary>Add commit message</summary>
        <label>
          Optional commit message
          <textarea
            maxLength={500}
            value={message}
            disabled={pending}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
      </details>
    </Dialog>
  );
}
