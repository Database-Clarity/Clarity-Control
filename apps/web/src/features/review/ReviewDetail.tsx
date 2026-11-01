import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Tooltip } from '@clarity/core';
import { getPushedVersion } from '../../services/history';
import { errorMessage } from '../../services/http';
import { useAuthStore } from '../../stores/auth';
import { useDraftStore } from '../../stores/drafts';
import { useDataStore } from '../../stores/data';
import { useSaveState } from '../../services/save/state';
import { replaceDraft } from '../../services/save/drafts';
import { revertDraft } from '../history/revert';
import { TooltipDiff } from '../history/TooltipDiff';
import type { PendingTooltip } from './model';
import styles from './Review.module.scss';

export function ReviewDetail({ entry }: { entry: PendingTooltip }) {
  const [live, setLive] = useState<{ tooltip: Tooltip | null; pushedHash: string | null }>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState<string>();
  const user = useAuthStore((state) => state.user);
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
      replaceDraft(
        base,
        revertDraft(
          existing?.next ?? saved,
          live.tooltip,
          currentUser,
        ),
        true,
      );
      setConfirm(false);
      setNotice(
        'Last pushed version loaded as a local draft. Review it in the editor; nothing was saved or pushed.',
      );
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setLive(undefined);
    setError(undefined);
    void getPushedVersion(entry.tooltip.hash, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setLive(result);
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      },
    );
    return () => controller.abort();
  }, [entry.tooltip.hash, attempt]);
  return (
    <section aria-label="Selected change">
      <p className={styles.detailIdentity}>
        {entry.category} <small>· {entry.categoryId} · #{entry.tooltip.hash}</small>
      </p>
      <h2>{entry.name}</h2>
      <Link to={`/t/${entry.tooltip.hash}`}>Open tooltip editor and history</Link>
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry live comparison
          </button>
        </p>
      )}
      {!live && !error && <p role="status">Loading last pushed text...</p>}
      {live && (
        <>
          {!live.pushedHash && <p>No recorded live version. All saved text is new.</p>}
          <TooltipDiff before={live.tooltip} current={entry.tooltip} />
          {notice && <p role="status">{notice}</p>}
          {user?.role === 'translator' && (
            <p>Only your assigned translation languages will be loaded.</p>
          )}
          {!confirm ? (
            <button type="button" disabled={!canLoad} onClick={() => setConfirm(true)}>
              Load last pushed as draft
            </button>
          ) : (
            <div>
              <p>
                This replaces {draft ? 'the existing local draft' : 'the editor content'} for this
                tooltip. It does not save or push.
              </p>
              <button type="button" disabled={!canLoad} onClick={loadDraft}>
                Confirm load as draft
              </button>{' '}
              <button type="button" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
