import { useEffect, useState } from 'react';
import type { Tooltip } from '@clarity/core';
import { apiUrl } from '../../services/api';
import { getHistory, getVersion, type HistoryCommit } from '../../services/history';
import { errorMessage } from '../../services/http';
import { replaceDraft } from '../../services/save/drafts';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { CommitAuthor } from './CommitAuthor';
import { PanelRow } from '../../ui/PanelRow';
import { When } from '../../ui/When';
import { lastEdit } from './lastEdit';
import { itemFor } from '../navigation/catalog';
import { TooltipDiff } from './TooltipDiff';
import { revertDraft } from './revert';
import styles from './History.module.scss';

/**
 * One collapsed row: "Edited <date> by <author>, n revisions". Expanding it shows the commit list
 * with compare and Revert. The first page of commits loads with the row (it is the count), so
 * opening it is instant.
 */
export function HistoryPanel({ hash, readOnly = false }: { hash: number; readOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<{ count: number; more: boolean }>();
  const user = useAuthStore((state) => state.user);
  const tooltip = useDataStore((state) => state.data?.bundle.tooltips[hash]);
  const draft = useDraftStore((state) => state.drafts[hash]);
  const edit = lastEdit(draft?.next ?? tooltip ?? { hash, text: {}, associated: [] });
  const signedIn = Boolean(apiUrl && user?.role);
  const userId = user?.id;
  useEffect(() => {
    setRevisions(undefined);
    if (!signedIn) return;
    const controller = new AbortController();
    void getHistory(hash, 1, controller.signal).then(
      (result) =>
        !controller.signal.aborted &&
        setRevisions({ count: result.commits.length, more: result.commits.length === 30 }),
      () => undefined,
    );
    return () => controller.abort();
  }, [hash, signedIn, userId]);
  const count = revisions
    ? `${revisions.count}${revisions.more ? '+' : ''} revision${revisions.count === 1 && !revisions.more ? '' : 's'}`
    : undefined;
  return (
    <PanelRow
      label="History"
      open={open}
      onOpenChange={setOpen}
      summary={
        edit.at !== undefined ? (
          <>
            Edited <When value={edit.at} nowrap /> by {edit.by ?? 'unknown author'}
            {count && `, ${count}`}
          </>
        ) : (
          (count ?? 'No recorded edits')
        )
      }
    >
      {!signedIn ? <p>Sign in as a configured member to view this tooltip's history.</p> : null}
      {signedIn && <HistoryContent key={`${hash}:${user?.id}`} hash={hash} readOnly={readOnly} />}
    </PanelRow>
  );
}

function HistoryContent({ hash, readOnly = false }: { hash: number; readOnly?: boolean }) {
  const user = useAuthStore((state) => state.user);
  const base = useDataStore((state) => state.data?.bundle.tooltips[hash]);
  const data = useDataStore((state) => state.data);
  const item = data ? itemFor(hash, data) : undefined;
  const draft = useDraftStore((state) => state.drafts[hash]);
  const hydrated = useDraftStore((state) => state.hydrated);
  const [commits, setCommits] = useState<HistoryCommit[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState<{ commit: string; tooltip: Tooltip }>();
  const [selectedCommit, setSelectedCommit] = useState<string>();
  const [versionLoading, setVersionLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void getHistory(hash, page, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setCommits((previous) =>
          page === 1
            ? result.commits
            : [
                ...previous.filter(
                  (entry) => !result.commits.some((next) => next.commit === entry.commit),
                ),
                ...result.commits,
              ],
        );
        setHasMore(result.commits.length === 30);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(reason));
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [hash, page, attempt]);
  useEffect(() => {
    if (!selectedCommit) return;
    const controller = new AbortController();
    setVersion(undefined);
    setConfirm(false);
    setVersionLoading(true);
    setError(undefined);
    void getVersion(hash, selectedCommit, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) {
          setVersion(result);
          setVersionLoading(false);
        }
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(reason));
          setVersionLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [hash, selectedCommit, attempt]);
  const current = draft?.next ?? base;

  function restore() {
    if (!base || !current || !version || !user || !hydrated) return;
    try {
      replaceDraft(base, revertDraft(current, version.tooltip, user));
      setConfirm(false);
      setNotice(
        'Historical version loaded as a local draft. Review it in the editor and use the normal save flow to commit it; nothing was saved or pushed automatically.',
      );
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  return (
    <section aria-label={`History for ${hash}`}>
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry history
          </button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <ol className={styles.commits}>
        {commits.map((entry) => (
          <li key={entry.commit}>
            <CommitAuthor entry={entry} />
            <div>
              <button
                type="button"
                aria-pressed={selectedCommit === entry.commit}
                onClick={() => {
                  setSelectedCommit(entry.commit);
                  setNotice(undefined);
                }}
              >
                {entry.message} ({entry.commit.slice(0, 8)})
              </button>
            </div>
          </li>
        ))}
      </ol>
      {loading && <p role="status">Loading commits...</p>}
      {!loading && !commits.length && !error && <p>No commits found for this tooltip.</p>}
      {hasMore && !error && (
        <button type="button" disabled={loading} onClick={() => setPage((value) => value + 1)}>
          Load more commits
        </button>
      )}
      {versionLoading && <p role="status">Loading historical version...</p>}
      {version && current && (
        <>
          <h3>Version {version.commit.slice(0, 8)} compared with current draft</h3>
          <TooltipDiff before={version.tooltip} current={current} item={item} />
          <details>
            <summary>View complete historical version</summary>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {JSON.stringify(version.tooltip, null, 2)}
            </pre>
          </details>
          {user?.role === 'translator' && (
            <p>
              Revert restores only your assigned translation languages; other fields stay unchanged.
            </p>
          )}
          {!readOnly &&
            (!confirm ? (
              <button type="button" disabled={!hydrated || !base} onClick={() => setConfirm(true)}>
                Revert to this
              </button>
            ) : (
              <div>
                <p>
                  This replaces {draft ? 'the existing local draft' : 'the editor content'} for this
                  tooltip. It does not save or push.
                </p>
                <button type="button" onClick={restore}>
                  Load this version as draft
                </button>{' '}
                <button type="button" onClick={() => setConfirm(false)}>
                  Cancel revert
                </button>
              </div>
            ))}
        </>
      )}
    </section>
  );
}
