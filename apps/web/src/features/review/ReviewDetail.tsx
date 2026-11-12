import { memo, useEffect, useState } from 'react';
import { getHistory, type HistoryCommit } from '../../services/history';
import { CommitAuthor } from '../history/CommitAuthor';
import { changedFields, changedSummary } from './changedFields';
import { useReviewMarks } from './reviewMarks';
import { useLocation } from 'react-router-dom';
import type { Tooltip } from '@clarity/core';
import { preparedReviewLiveValue, takeReviewLiveRequest } from './liveRequest';
import { errorMessage } from '../../services/http';
import { useAuthStore } from '../../stores/auth';
import { useDraftStore } from '../../stores/drafts';
import { useDataStore } from '../../stores/data';
import { useSaveState } from '../../services/save/state';
import { replaceDraft } from '../../services/save/drafts';
import { revertDraft } from '../history/revert';
import { itemFor } from '../navigation/catalog';
import { TooltipDiff } from '../history/TooltipDiff';
import type { PendingTooltip } from './model';
import { useReviewOpening } from './opening';
import styles from './Review.module.scss';

export const ReviewDetail = memo(function ReviewDetail({
  entry,
  included,
  selectionLocked,
  onInclude,
}: {
  entry: PendingTooltip;
  /** The change is part of the publish selection. */
  included: boolean;
  /** Selection is unavailable (publishing, or nothing publishable here). */
  selectionLocked: boolean;
  onInclude(hash: number): void;
}) {
  const location = useLocation();
  const [live, setLive] = useState<
    { tooltip: Tooltip | null; pushedHash: string | null } | undefined
  >(() => preparedReviewLiveValue(entry.tooltip.hash));
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [saved, setSaved] = useState<HistoryCommit | null>();
  const record = useReviewMarks((state) => state.record);
  const user = useAuthStore((state) => state.user);
  const catalog = useDataStore((state) => state.data);
  const reviewItem = catalog ? itemFor(entry.tooltip.hash, catalog) : undefined;
  const draft = useDraftStore((state) => state.drafts[entry.tooltip.hash]);
  const hydrated = useDraftStore((state) => state.hydrated);
  const locked = useSaveState((state) => state.locked);
  const canLoad =
    !!user?.role &&
    (user.role !== 'translator' || !!user.languages?.length) &&
    hydrated &&
    !locked &&
    !!live?.tooltip &&
    !!live.pushedHash;
  function loadDraft() {
    const currentUser = useAuthStore.getState().user;
    const state = useDraftStore.getState();
    if (
      !currentUser?.role ||
      (currentUser.role === 'translator' && !currentUser.languages?.length) ||
      !state.hydrated ||
      useSaveState.getState().locked ||
      !live?.tooltip ||
      !live.pushedHash
    )
      return;
    try {
      const saved = useDataStore.getState().data?.bundle.tooltips[entry.tooltip.hash];
      if (!saved) throw new Error('The saved tooltip is no longer available.');
      const existing = state.drafts[saved.hash];
      // Rebase only the fields this restore replaces; retain the old merge base
      // for any other local changes, including changes outside translator access.
      const base = revertDraft(existing?.base ?? saved, saved, currentUser);
      replaceDraft(base, revertDraft(existing?.next ?? saved, live.tooltip, currentUser), true);
      setConfirm(false);
      setNotice(
        'Last pushed version loaded as a local draft. Review it in the editor; nothing was saved or pushed.',
      );
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }
  useEffect(() => {
    const { controller, pending, value } = takeReviewLiveRequest(entry.tooltip.hash);
    let stopWaiting: (() => void) | undefined;
    setLive(value);
    setError(undefined);
    void pending.then(
      (result) => {
        if (controller.signal.aborted) return;
        const opening = useReviewOpening.getState();
        if (!opening.warming || opening.limit > 0) setLive(result);
        else {
          // A fast response must not add another comparison render before the
          // local workspace's first paint. Input and the GET remain independent.
          stopWaiting = useReviewOpening.subscribe((state) => {
            if (state.warming && state.limit === 0) return;
            stopWaiting?.();
            if (!controller.signal.aborted) setLive(result);
          });
        }
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      },
    );
    // A filter navigation can stage a new request for the same hash.
    // Consume it after that route commits, and cancel the previous consumer.
    return () => {
      stopWaiting?.();
      controller.abort();
    };
  }, [entry.tooltip.hash, location.key, user, attempt]);
  // The last saver, one request for the open change only (rows ask near the viewport).
  useEffect(() => {
    if (!user?.role) return;
    const controller = new AbortController();
    setSaved(undefined);
    void getHistory(entry.tooltip.hash, 1, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setSaved(result.commits[0] ?? null);
      },
      () => {
        if (!controller.signal.aborted) setSaved(null);
      },
    );
    return () => controller.abort();
  }, [entry.tooltip.hash, user]);
  const fields = live ? changedFields(live.tooltip, entry.tooltip) : undefined;
  useEffect(() => {
    if (fields) record(entry.tooltip.hash, fields);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, entry.tooltip, record]);
  const summary = entry.markerOnly
    ? 'Alias marker only: the saved content equals the live version'
    : live && !live.pushedHash
      ? `${changedSummary(fields!) || 'All saved text'} · never pushed (no live version)`
      : fields
        ? changedSummary(fields) || 'No content differs from the live version'
        : undefined;
  return (
    <section aria-label="Selected change">
      {summary && (
        <p className={styles.changed}>
          <strong>Changed:</strong> {summary}
        </p>
      )}
      {saved && (
        <p className={styles.savedBy}>
          Saved by <CommitAuthor entry={saved} />
        </p>
      )}
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry live comparison
          </button>
        </p>
      )}
      {!live && !error && (
        <div role="status" aria-label="Loading last pushed text" className={styles.liveSkeleton}>
          <span className={styles.readyStatus}>Loading last pushed text...</span>
          <div aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
      )}
      {live && (
        <>
          {!live.pushedHash && !summary && <p>No recorded live version. All saved text is new.</p>}
          <div className={styles.liveDiff}>
            <TooltipDiff
              before={live.tooltip}
              current={entry.tooltip}
              item={reviewItem}
              responsive
            />
          </div>
          {notice && <p role="status">{notice}</p>}
          {user?.role === 'translator' && (
            <p>Only your assigned translation languages will be loaded.</p>
          )}
        </>
      )}
      <div className={styles.actions}>
        <label className={styles.include}>
          <input
            type="checkbox"
            checked={included}
            disabled={selectionLocked}
            onChange={() => onInclude(entry.tooltip.hash)}
          />{' '}
          Include in publish <kbd>Space</kbd>
        </label>
        {live &&
          (!confirm ? (
            <button type="button" disabled={!canLoad} onClick={() => setConfirm(true)}>
              Load last pushed as draft
            </button>
          ) : (
            <>
              <span>
                This replaces {draft ? 'the existing local draft' : 'the editor content'} for this
                tooltip. It does not save or push.
              </span>
              <button type="button" disabled={!canLoad} onClick={loadDraft}>
                Confirm load as draft
              </button>
              <button type="button" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </>
          ))}
      </div>
    </section>
  );
});
