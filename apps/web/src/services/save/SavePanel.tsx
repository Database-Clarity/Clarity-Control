import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiUrl, save } from '../api';
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
import { Dialog } from '../../ui/Dialog';
import { acceptSaved } from './drafts';
import { useSaveNotice } from './notice';
import { permissionError, prepareChanges, validateChanges } from './pipeline';
import { useSaveState, type SaveReview } from './state';
import { openDraftSaveReview } from './openReview';
import { SaveSummary } from './SaveSummary';

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
  return (
    <section aria-label="Save drafts" className={className}>
      <p data-summary>
        {count === 0
          ? 'No local drafts'
          : `${count} local ${count === 1 ? 'draft' : 'drafts'} kept in this browser`}
      </p>
      {unpreviewed > 0 && (
        <p data-unpreviewed>
          {unpreviewed === 1 ? '1 change' : `${unpreviewed} changes`} not previewed. You can still
          save.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {children}
      {open > 0 ? (
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
      )}
    </section>
  );
}

/** What the user is told when somebody else saved the same tooltips first. */
export function conflictNotice(outcome: BeginResult): string {
  const tooltips = outcome.tooltips === 1 ? '1 tooltip' : `${outcome.tooltips} tooltips`;
  const open = outcome.markers + outcome.rows;
  const merged = outcome.merged
    ? ` ${outcome.merged} text${outcome.merged === 1 ? '' : 's'} merged automatically.`
    : '';
  return open > 0
    ? `Nothing was saved: ${tooltips} changed on the server meanwhile. Resolve ${open === 1 ? '1 conflict' : `${open} conflicts`} in the editor, then review and save again.${merged}`
    : `Nothing was saved: ${tooltips} changed on the server meanwhile.${merged || ' Your edits were merged.'} Review and save again.`;
}

const accountChanged = (generation: number) => useDraftStore.getState().generation !== generation;

function SaveSession({ review, onSaved }: { review: SaveReview; onSaved(message: string): void }) {
  const data = useDataStore((state) => state.data);
  const user = useAuthStore((state) => state.user);
  const close = useSaveState((state) => state.close);
  const changes = review.changes;
  const openConflicts = useOpenConflicts();
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [remoteCommit, setRemoteCommit] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const validation = useMemo(() => {
    try {
      return { issues: data ? validateChanges(changes, data) : [], error: null };
    } catch (error) {
      return { issues: [], error: errorMessage(error) };
    }
  }, [changes, data]);
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
    validation.error ||
    validation.issues.some((issue) => issue.severity === 'error') ||
    changes.length > 100,
  );
  async function submit() {
    if (!data || !user || pending || blocked || remoteCommit) return;
    setPending(true);
    setError(null);
    const drafts = useDraftStore.getState();
    const generation = drafts.generation;
    try {
      await drafts.flush();
      if (accountChanged(generation)) return;
      if (useDraftStore.getState().error)
        throw new Error(
          'Local drafts are not safely stored. Close this review and retry draft storage.',
        );
      const prepared = await prepareChanges(changes, user, data);
      if (accountChanged(generation)) return;
      // The request reads the session token when it is sent: refuse unless it is still the one
      // this user was loaded with (another tab may have signed in as someone else meanwhile).
      const auth = useAuthStore.getState();
      if (auth.loading || !sameUser(auth.user, user) || auth.token !== sessionToken())
        throw new Error('Your login changed. Close this review and check your role.');
      const result = await save(prepared, message.trim() || `Update ${changes.length} tooltip(s)`);
      if (accountChanged(generation) && result.kind === 'saved') {
        // Switching accounts already closed this review; report through the save notice.
        onSaved(
          `Remote save ${result.commit.slice(0, 8)} succeeded, but you switched accounts meanwhile. The drafts stay with the account that made them: sign back in to it and reload data.`,
        );
        return;
      }
      if (accountChanged(generation)) return;
      if (result.kind === 'conflicts') {
        // Nothing was saved. Rebase the drafts on the server's versions and resolve in the editor.
        const conflicted = new Set(result.conflicts.map((conflict) => conflict.hash));
        const outcome = useConflictStore.getState().begin(
          result.conflicts,
          prepared.filter((change) => !conflicted.has(change.hash)),
        );
        onSaved(conflictNotice(outcome));
        close();
      } else if (result.kind === 'retry')
        setError(`${result.error}. Nothing was saved. Retry when ready.`);
      else {
        setRemoteCommit(result.commit);
        const expected = new Set(prepared.map(({ hash }) => hash));
        if (
          result.tooltips.length !== expected.size ||
          result.tooltips.some(({ hash }) => !expected.delete(hash))
        ) {
          throw new Error(
            `Remote save ${result.commit} succeeded, but returned an incomplete tooltip set. Drafts are retained; close this dialog and reload data before continuing.`,
          );
        }
        try {
          acceptSaved(review.submitted, result.tooltips, result.commit);
        } catch (error) {
          throw new Error(
            `Remote save ${result.commit} succeeded, but local reconciliation failed: ${errorMessage(error).replace(/\.+$/, '')}. Drafts are retained; close this dialog and reload data before continuing.`,
          );
        }
        onSaved(`Saved ${result.tooltips.length} tooltip(s) in ${result.commit.slice(0, 8)}.`);
        close();
      }
    } catch (error) {
      if (!accountChanged(generation)) setError(errorMessage(error));
    } finally {
      if (!accountChanged(generation)) setPending(false);
    }
  }
  return (
    <Dialog
      title="Review save"
      busy={pending}
      onClose={close}
      footer={
        <>
          <button
            type="button"
            disabled={pending || blocked || !data || Boolean(remoteCommit)}
            onClick={() => void submit()}
          >
            {pending ? 'Saving...' : 'Save changes'}
          </button>
          <button type="button" disabled={pending} onClick={close}>
            Cancel; keep local drafts
          </button>
        </>
      }
    >
      {data && <SaveSummary changes={changes} issues={validation.issues} data={data} />}
      {(denied || validation.error || error) && (
        <p role="alert">{denied || validation.error || error}</p>
      )}
      {unresolved && <p role="alert">Resolve the open conflicts before saving.</p>}
      {paused && (
        <p role="alert">Another tab changed your drafts. Choose Reload or Keep mine first.</p>
      )}
      {changes.length > 100 && (
        <p role="alert">At most 100 tooltips can be saved at once. Reduce your drafts first.</p>
      )}
      {validation.issues.some((issue) => issue.severity === 'warning') && (
        <p>Warnings do not block saving.</p>
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
