import { useEffect, useMemo, useState } from 'react';
import type { CompendiumData } from '@clarity/core';
import { apiUrl, save, type SaveConflict } from '../api';
import { loadCompendium } from '../compendium';
import { errorMessage } from '../http';
import { sameUser, useAuthStore } from '../../stores/auth';
import { sessionToken } from '../session';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { ConflictDialog } from '../../features/conflicts/ConflictDialog';
import { CompendiumDiff } from '../../features/compendium/CompendiumDiff';
import { useCompendiumStore } from '../../features/compendium/store';
import { Dialog } from '../../ui/Dialog';
import { acceptSaved } from './drafts';
import { isSaveDockIdle } from './dock';
import { permissionError, prepareChanges, validateChanges } from './pipeline';
import { useSaveState, type SaveReview } from './state';
import { openDraftSaveReview } from './openReview';
import { changedSources, linksCompendium, sourceKey, type ChangedSource } from './compendiumSource';
import { SaveSummary } from './SaveSummary';

export function SavePanel({ className }: { className?: string }) {
  const drafts = useDraftStore((state) => state.drafts);
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
          setNotice(null);
          openDraftSaveReview();
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
  // Linked Compendium cells that changed since they were shown, and the ones the reviewer ticked.
  const [changedSource, setChangedSource] = useState<ChangedSource[]>([]);
  const [acknowledged, setAcknowledged] = useState<string | null>(null);
  const needsAcknowledgement =
    changedSource.length > 0 && acknowledged !== sourceKey(changedSource);
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
    const drafts = useDraftStore.getState();
    const generation = drafts.generation;
    try {
      await drafts.flush();
      if (accountChanged(generation)) return;
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
      // Saving English text on a linked tooltip records the Compendium cell as reviewed. Fetch
      // the current source now; if it differs from what the editor was shown, show the new diff
      // and wait for an explicit tick. What was fetched and ticked is exactly what gets recorded.
      let source: CompendiumData | undefined;
      if (linksCompendium(changes)) {
        source = await loadCompendium(true);
        if (accountChanged(generation)) return;
        const found = changedSources(changes, useCompendiumStore.getState().data, source);
        setChangedSource(found);
        if (found.length && acknowledged !== sourceKey(found)) {
          setError(
            'The Compendium changed since it was last shown. Review the differences below and tick the box to continue; nothing was saved.',
          );
          return;
        }
      }
      const prepared = await prepareChanges(changes, user, data, source);
      if (accountChanged(generation)) return;
      // The request reads the session token when it is sent: refuse unless it is still the one
      // this user was loaded with (another tab may have signed in as someone else meanwhile).
      const auth = useAuthStore.getState();
      if (auth.loading || !sameUser(auth.user, user) || auth.token !== sessionToken())
        throw new Error('Your login changed. Close this review and check your role.');
      const result = await save(prepared, message.trim() || `Update ${changes.length} tooltip(s)`);
      if (accountChanged(generation) && result.kind === 'saved') {
        // Switching accounts already closed this review; report through the dock's notice.
        onSaved(
          `Remote save ${result.commit.slice(0, 8)} succeeded, but you switched accounts meanwhile. The drafts stay with the account that made them: sign back in to it and reload data.`,
        );
        return;
      }
      if (accountChanged(generation)) return;
      if (result.kind === 'conflicts') {
        setChanges(prepared);
        setConflicts(result.conflicts);
      } else if (result.kind === 'retry')
        setError(`${result.error}. Nothing was saved. Retry when ready.`);
      else {
        setRemoteCommit(result.commit);
        // The panel now compares against what was just recorded, not an older fetch.
        if (source) useCompendiumStore.setState({ data: source });
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
            disabled={pending || blocked || !data || Boolean(remoteCommit) || needsAcknowledgement}
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
      {changedSource.length > 0 && data && (
        <section aria-label="Compendium source changed">
          <h3>Compendium source changed</h3>
          <p>
            The Compendium changed after it was last shown to you. Saving records the new text as
            reviewed.
          </p>
          {changedSource.map(({ hash, shown, fresh }) => (
            <section key={hash} aria-label={`Compendium change for ${hash}`}>
              <h4>
                {data.items[hash]?.name ??
                  changes.find((c) => c.hash === hash)?.next.custom?.name ??
                  hash}{' '}
                ({hash})
              </h4>
              <CompendiumDiff before={shown} after={fresh} />
            </section>
          ))}
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
