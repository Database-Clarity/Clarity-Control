import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { errorMessage } from '../../services/http';
import { downloadSnapshot, exportName, readSnapshotFile } from './file';
import { type PostTarget, senderOrigins, startReceiver, stamp } from './protocol';
import { draftCount, snapshotVersion, type Snapshot } from './snapshot';
import { applySnapshot, browserIO, previewMerge, type ApplyResult } from './storage';
import styles from './Migrate.module.scss';

type Preview = Awaited<ReturnType<typeof previewMerge>>;
type View =
  | { kind: 'idle' }
  | { kind: 'review'; snapshot: Snapshot; preview: Preview; fromWindow: boolean }
  | { kind: 'applying' }
  | { kind: 'done'; result: ApplyResult }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };

/**
 * `#/migrate` on the new site: receives drafts and device preferences from the old site (window
 * handshake) or from an exported file. Nothing is written until "Merge" is clicked, an existing
 * draft is never replaced, and nothing is removed on either side here.
 */
export function MigratePage() {
  const [view, setView] = useState<View>({ kind: 'idle' });
  const viewRef = useRef(view);
  viewRef.current = view;
  const receiver = useRef<ReturnType<typeof startReceiver>>();
  const hasOpener = typeof window !== 'undefined' && !!window.opener;

  const review = async (snapshot: Snapshot, fromWindow: boolean) => {
    try {
      setView({
        kind: 'review',
        snapshot,
        preview: await previewMerge(snapshot, browserIO()),
        fromWindow,
      });
    } catch {
      const message =
        "Cannot read this browser's drafts. Nothing was removed. Restore this browser's drafts from a backup, and try again.";
      // Tell the old site too, or its page would wait on "Sent" for ever.
      if (fromWindow) receiver.current?.reply({ ...stamp, type: 'refused', reason: message });
      setView({ kind: 'error', message });
    }
  };

  useEffect(() => {
    const opener = window.opener as PostTarget | null;
    if (!opener) return;
    const started = startReceiver(window, opener, senderOrigins, {
      // A second snapshot while one is being reviewed or applied is ignored, not queued.
      onSnapshot: (snapshot) => {
        if (viewRef.current.kind === 'idle' || viewRef.current.kind === 'done')
          void review(snapshot, true);
      },
      onRefused: (message) => setView({ kind: 'error', message }),
      onAbort: (reason) => setView({ kind: 'error', message: reason }),
    });
    receiver.current = started;
    return () => started.stop();
  }, []);

  const merge = async () => {
    if (view.kind !== 'review') return;
    const { snapshot, fromWindow } = view;
    setView({ kind: 'applying' });
    try {
      const result = await applySnapshot(snapshot, browserIO());
      setView({ kind: 'done', result });
      if (fromWindow)
        receiver.current?.reply({
          ...stamp,
          type: 'done',
          stored: result.outcome.stored,
          unplaced: Object.values(result.outcome.unplaced).reduce(
            (sum, drafts) => sum + Object.keys(drafts).length,
            0,
          ),
        });
    } catch {
      const message =
        'The merge stopped because this browser could not store the drafts. Nothing was removed. Check your browser storage, and start over to try again.';
      if (fromWindow) receiver.current?.reply({ ...stamp, type: 'refused', reason: message });
      setView({ kind: 'error', message });
    }
  };

  const startOver = () => {
    setView({ kind: 'idle' });
    receiver.current?.announce();
  };

  const cancel = () => {
    if (view.kind === 'review' && view.fromWindow)
      receiver.current?.reply({ ...stamp, type: 'refused', reason: 'Cancelled on the new site.' });
    setView({ kind: 'cancelled' });
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const parsed = await readSnapshotFile(file).catch((error: unknown) => ({
      ok: false as const,
      message: errorMessage(error),
    }));
    if (parsed.ok) await review(parsed.snapshot, false);
    else setView({ kind: 'error', message: parsed.message });
  };

  const unplaced = view.kind === 'done' ? view.result.outcome.unplaced : {};
  const unplacedCount = Object.values(unplaced).reduce((sum, d) => sum + Object.keys(d).length, 0);
  const picker = (
    <label className={styles.file}>
      Import file
      <input
        type="file"
        accept="application/json,.json"
        onChange={(event) => void chooseFile(event)}
      />
    </label>
  );

  return (
    <section className={styles.page} aria-labelledby="migrate-title">
      <h1 id="migrate-title">Move drafts to this editor</h1>
      {view.kind === 'idle' && (
        <>
          <p>
            {hasOpener
              ? 'Waiting for the old editor to send your drafts…'
              : 'Open this page from “Move my drafts” in the old editor, or import a file exported from it.'}
          </p>
          <p className={styles.muted}>
            Drafts already in this editor are never replaced, and nothing is removed from the old
            editor.
          </p>
          <div className={styles.actions}>{picker}</div>
        </>
      )}
      {view.kind === 'review' && (
        <>
          <p>
            {draftCount(view.snapshot)} draft{draftCount(view.snapshot) === 1 ? '' : 's'} and{' '}
            {Object.keys(view.snapshot.prefs).length} device setting
            {Object.keys(view.snapshot.prefs).length === 1 ? '' : 's'} received. Nothing has been
            written yet.
          </p>
          <dl className={styles.summary}>
            <dt>New drafts</dt>
            <dd>{view.preview.outcome.added}</dd>
            <dt>Already here</dt>
            <dd>{view.preview.outcome.identical}</dd>
            <dt>Differ from yours</dt>
            <dd>
              {view.preview.outcome.keptSeparate +
                Object.values(view.preview.outcome.unplaced).reduce(
                  (sum, drafts) => sum + Object.keys(drafts).length,
                  0,
                )}{' '}
              (yours are kept; theirs are set aside)
            </dd>
            <dt>New settings</dt>
            <dd>
              {Object.keys(view.preview.prefs.writes).length} (existing settings here are kept)
            </dd>
          </dl>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={() => void merge()}>
              Merge into this browser
            </button>
            <button type="button" onClick={cancel}>
              Cancel
            </button>
          </div>
        </>
      )}
      {view.kind === 'applying' && <p role="status">Merging…</p>}
      {view.kind === 'done' && (
        <>
          <p role="status">
            Merged: {view.result.outcome.added} new draft
            {view.result.outcome.added === 1 ? '' : 's'}, {view.result.outcome.identical} already
            here, {view.result.outcome.keptSeparate} set aside to keep separate,{' '}
            {view.result.prefsAdded} setting{view.result.prefsAdded === 1 ? '' : 's'} added.
          </p>
          {view.result.outcome.keptSeparate > 0 && (
            <p className={styles.muted}>
              Set-aside drafts appear as signed-out drafts; choose Keep separate or Adopt in the
              editor.
            </p>
          )}
          {unplacedCount > 0 && (
            <p className={styles.error}>
              {unplacedCount} draft{unplacedCount === 1 ? '' : 's'} conflict with drafts you already
              have and could not be set aside. Download them to keep a copy; they also stay in the
              old editor.
            </p>
          )}
          <p className={styles.muted}>
            Return to the old editor tab to remove its copy, if you want.
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              onClick={() => {
                window.location.hash = '#/';
                window.location.reload();
              }}
            >
              Open editor
            </button>
            {unplacedCount > 0 && (
              <button
                type="button"
                onClick={() =>
                  downloadSnapshot(
                    { version: snapshotVersion, buckets: unplaced, prefs: {} },
                    exportName(),
                  )
                }
              >
                Download unmerged drafts
              </button>
            )}
            {picker}
          </div>
        </>
      )}
      {view.kind === 'error' && (
        <>
          <p role="alert" className={styles.error}>
            {view.message}
          </p>
          <div className={styles.actions}>
            <button type="button" onClick={startOver}>
              Start over
            </button>
            {picker}
          </div>
        </>
      )}
      {view.kind === 'cancelled' && (
        <>
          <p role="status">Cancelled. Nothing was changed here or in the old editor.</p>
          <div className={styles.actions}>
            <button type="button" onClick={startOver}>
              Start over
            </button>
          </div>
        </>
      )}
    </section>
  );
}
