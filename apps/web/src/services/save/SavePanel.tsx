import { useEffect, useMemo, useState } from 'react';
import { apiUrl, save, type SaveConflict } from '../api';
import { errorMessage } from '../http';
import { sameUser, useAuthStore } from '../../stores/auth';
import { sessionToken } from '../session';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { ConflictDialog } from '../../features/conflicts/ConflictDialog';
import { Dialog } from '../../ui/Dialog';
import { acceptSaved } from './drafts';
import { isSaveDockIdle } from './dock';
import { permissionError, prepareChanges, validateChanges } from './pipeline';
import { reviewSaveChanges, useSaveState, type SaveReview } from './state';
import { SaveSummary } from './SaveSummary';

export function SavePanel({ className }: { className?: string }) {
  const drafts = useDraftStore((state) => state.drafts);
  const data = useDataStore((state) => state.data);
  const user = useAuthStore((state) => state.user);
  const review = useSaveState((state) => state.review);
  const generation = useDraftStore((state) => state.generation);
  const [notice, setNotice] = useState<string | null>(null);
  const count = Object.keys(drafts).length;
  useEffect(() => {
    // A review lists one account's drafts: switching accounts closes it, keeping the drafts.
    return () => {
      if (useSaveState.getState().review) useSaveState.getState().close();
    };
  }, [generation]);
  return (
    <section
      aria-label="Save drafts"
      className={className}
      data-idle={isSaveDockIdle({ count, notice, review })}
    >
      <p>{count} local draft(s)</p>
      <button
        type="button"
        disabled={!apiUrl || !user?.role || !count || Boolean(review)}
        onClick={() => {
          if (!data) return;
          setNotice(null);
          const submitted = useDraftStore.getState().drafts;
          reviewSaveChanges(
            Object.values(submitted).map(({ base, next }) => ({
              hash: next.hash,
              base: data.bundle.tooltips[next.hash] ? base : null,
              next,
            })),
            submitted,
          );
        }}
      >
        Review and save drafts
      </button>
      {notice && <p role="status">{notice}</p>}
      {review && <SaveSession review={review} onSaved={(message) => setNotice(message)} />}
    </section>
  );
}

const accountChanged = (generation: number) => useDraftStore.getState().generation !== generation;

function SaveSession({ review, onSaved }: { review: SaveReview; onSaved(message: string): void }) {
  const data = useDataStore((state) => state.data);
  const user = useAuthStore((state) => state.user);
  const close = useSaveState((state) => state.close);
  const [changes, setChanges] = useState(review.changes);
  const [conflicts, setConflicts] = useState<SaveConflict[] | null>(null);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [deleted, setDeleted] = useState<number[]>([]);
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
  const blocked = Boolean(
    denied ||
    validation.error ||
    validation.issues.some((issue) => issue.severity === 'error') ||
    changes.length > 100,
  );
  async function submit() {
    if (!data || !user || pending || blocked || remoteCommit) return;
    setPending(true);
    setError(null);
    try {
      const drafts = useDraftStore.getState();
      const generation = drafts.generation;
      await drafts.flush();
      if (useDraftStore.getState().error)
        throw new Error(
          'Local drafts are not safely stored. Close this review and retry draft storage.',
        );
      if (!changes.length) {
        acceptSaved(review.submitted, [], undefined, deleted);
        onSaved('Accepted server deletions. No remote changes were needed.');
        close();
        return;
      }
      const prepared = await prepareChanges(changes, user, data);
      // The request reads the session token when it is sent: refuse unless it is still the one
      // this user was loaded with (another tab may have signed in as someone else meanwhile).
      const auth = useAuthStore.getState();
      if (
        auth.loading ||
        !sameUser(auth.user, user) ||
        auth.token !== sessionToken() ||
        accountChanged(generation)
      )
        throw new Error('Your login changed. Close this review and check your role.');
      const result = await save(prepared, message.trim() || `Update ${changes.length} tooltip(s)`);
      if (accountChanged(generation) && result.kind === 'saved') {
        // Switching accounts already closed this review; report through the dock's notice.
        onSaved(
          `Remote save ${result.commit.slice(0, 8)} succeeded, but you switched accounts meanwhile. The drafts stay with the account that made them: sign back in to it and reload data.`,
        );
        return;
      }
      if (result.kind === 'conflicts') {
        setChanges(prepared);
        setConflicts(result.conflicts);
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
          acceptSaved(review.submitted, result.tooltips, result.commit, deleted);
        } catch (error) {
          throw new Error(
            `Remote save ${result.commit} succeeded, but local reconciliation failed: ${errorMessage(error)}. Drafts are retained; close this dialog and reload data before continuing.`,
          );
        }
        onSaved(`Saved ${result.tooltips.length} tooltip(s) in ${result.commit.slice(0, 8)}.`);
        close();
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }
  if (conflicts)
    return (
      <ConflictDialog
        changes={changes}
        conflicts={conflicts}
        onClose={close}
        onResolve={(resolved) => {
          setChanges(resolved.changes);
          setDeleted((previous) => [...new Set([...previous, ...resolved.deleted])]);
          setConflicts(null);
        }}
      />
    );
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
      {deleted.length > 0 && (
        <p>
          Accept server deletion and discard the submitted local draft(s): {deleted.join(', ')}.
        </p>
      )}
      {(denied || validation.error || error) && (
        <p role="alert">{denied || validation.error || error}</p>
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
