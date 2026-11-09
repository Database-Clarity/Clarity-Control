import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../services/http';
import { downloadSnapshot, exportName } from './file';
import { newOrigin, startSender } from './protocol';
import { maxMessageChars, serializeSnapshot, type Snapshot } from './snapshot';
import { movedStart } from './moved';
import { browserIO, clearMoved, collectSnapshot } from './storage';
import styles from './Migrate.module.scss';

type View =
  | { kind: 'checking' }
  | { kind: 'idle'; drafts: number }
  | { kind: 'waiting' }
  | { kind: 'sent' }
  | { kind: 'moved'; stored: Record<string, string[]>; unplaced: number; confirming: boolean }
  | { kind: 'cleared'; removed: number }
  | { kind: 'error'; message: string; drafts: number };

/**
 * Shown by the "moved" build of the old site (VITE_MOVED_MODE=1, off by default). With no local
 * drafts it goes straight to the new site; otherwise the user chooses. Nothing is removed here
 * except through the final, explicit confirmation, and then only drafts the new site confirmed.
 */
export function MovedPage() {
  const [view, setView] = useState<View>({ kind: 'checking' });
  const sent = useRef<Snapshot>();
  const sender = useRef<ReturnType<typeof startSender>>();
  const timer = useRef<number>();
  const sentRef = useRef(false);
  const target = `${newOrigin}/${window.location.hash || '#/'}`;

  useEffect(() => {
    let live = true;
    collectSnapshot(browserIO()).then(
      (collected) => {
        if (!live) return;
        const start = movedStart(collected);
        if (start.kind === 'redirect') window.location.replace(target);
        else if (start.kind === 'idle') setView({ kind: 'idle', drafts: start.drafts });
        else
          setView({
            kind: 'error',
            message:
              'Some drafts in this browser cannot be read, so nothing was moved or removed. Open the new editor yourself if you want to continue.',
            drafts: -1,
          });
      },
      // A browser that cannot read its drafts must not be redirected away from them.
      (error: unknown) =>
        live &&
        setView({
          kind: 'error',
          message: `Cannot read local drafts: ${errorMessage(error)}`,
          drafts: -1,
        }),
    );
    return () => {
      live = false;
      sender.current?.stop();
      window.clearInterval(timer.current);
    };
  }, [target]);

  const prepare = async (): Promise<string> => {
    const { snapshot, unreadable } = await collectSnapshot(browserIO());
    if (unreadable.length)
      throw new Error('Some local drafts cannot be read, so nothing was sent.');
    sent.current = snapshot;
    const result = serializeSnapshot(snapshot, maxMessageChars);
    if (!result.ok || !result.text)
      throw new Error(result.ok ? 'Nothing to send.' : result.message);
    return result.text;
  };

  const move = () => {
    // Opened synchronously inside the click so the browser allows it; this window stays the opener.
    // The query makes a reused window load the page afresh (a hash-only change would not), so a
    // retry always meets a new receiver that announces itself.
    const popup = window.open(`${newOrigin}/?migrate=${Date.now()}#/migrate`, 'clarity-migrate');
    if (!popup) {
      setView({
        kind: 'error',
        message: 'The browser blocked the new window. Allow pop-ups, or export a file instead.',
        drafts: -1,
      });
      return;
    }
    sender.current?.stop();
    window.clearInterval(timer.current);
    sentRef.current = false;
    const started = startSender(window, popup, newOrigin, prepare(), {
      onWaiting: () => setView({ kind: 'waiting' }),
      onSent: () => {
        sentRef.current = true;
        setView({ kind: 'sent' });
      },
      onDone: (stored, unplaced) => setView({ kind: 'moved', stored, unplaced, confirming: false }),
      onRefused: (message) => setView({ kind: 'error', message, drafts: -1 }),
      onClosed: () =>
        setView({
          kind: 'error',
          message: sentRef.current
            ? 'The new window was closed before the merge finished. Nothing was removed here; check the new editor, or try again.'
            : 'The new window was closed before the drafts were sent. Nothing was changed.',
          drafts: -1,
        }),
    });
    sender.current = started;
    timer.current = window.setInterval(() => {
      if (started.checkClosed()) window.clearInterval(timer.current);
    }, 1000);
  };

  const exportFile = async () => {
    try {
      const { snapshot, unreadable } = await collectSnapshot(browserIO());
      if (unreadable.length) throw new Error('Some local drafts cannot be read.');
      downloadSnapshot(snapshot, exportName());
    } catch (error) {
      setView({ kind: 'error', message: errorMessage(error), drafts: -1 });
    }
  };

  const clear = async () => {
    if (view.kind !== 'moved' || !sent.current) return;
    try {
      setView({
        kind: 'cleared',
        removed: await clearMoved(sent.current, view.stored, browserIO()),
      });
    } catch (error) {
      setView({
        kind: 'error',
        message: `Could not remove the drafts: ${errorMessage(error)}`,
        drafts: -1,
      });
    }
  };

  return (
    <section className={styles.page} aria-labelledby="moved-title">
      <h1 id="moved-title">The editor has moved</h1>
      {view.kind === 'checking' && <p role="status">Checking for drafts in this browser…</p>}
      {view.kind === 'idle' && (
        <>
          <p>
            It now lives at <a href={target}>{newOrigin.replace('https://', '')}</a>. This browser
            holds {view.drafts} unsaved draft{view.drafts === 1 ? '' : 's'}, which do not move on
            their own.
          </p>
          <p className={styles.muted}>
            Moving copies them. Drafts already in the new editor are never replaced, and nothing is
            removed here unless you confirm it afterwards.
          </p>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={move}>
              Move my drafts
            </button>
            <button type="button" onClick={() => void exportFile()}>
              Export to file
            </button>
            <a href={target}>Open new editor</a>
          </div>
        </>
      )}
      {view.kind === 'waiting' && <p role="status">Waiting for the new editor window…</p>}
      {view.kind === 'sent' && <p role="status">Sent. Review and merge them in the new window.</p>}
      {view.kind === 'moved' && (
        <>
          <p role="status">
            The new editor now holds your drafts.
            {view.unplaced > 0
              ? ` ${view.unplaced} conflicting draft${view.unplaced === 1 ? ' was' : 's were'} not merged and will stay here.`
              : ''}
          </p>
          <p className={styles.muted}>
            Your drafts here are still in place. Remove them only once you have checked.
          </p>
          <div className={styles.actions}>
            {view.confirming ? (
              <>
                <button type="button" className={styles.danger} onClick={() => void clear()}>
                  Yes, remove the moved drafts here
                </button>
                <button type="button" onClick={() => setView({ ...view, confirming: false })}>
                  Keep them
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => setView({ ...view, confirming: true })}>
                  Remove moved drafts from here…
                </button>
                <a href={target}>Open new editor</a>
              </>
            )}
          </div>
        </>
      )}
      {view.kind === 'cleared' && (
        <>
          <p role="status">
            Removed {view.removed} moved draft{view.removed === 1 ? '' : 's'} from this browser.
          </p>
          <div className={styles.actions}>
            <a href={target}>Open new editor</a>
          </div>
        </>
      )}
      {view.kind === 'error' && (
        <>
          <p role="alert" className={styles.error}>
            {view.message}
          </p>
          <div className={styles.actions}>
            <button type="button" onClick={move}>
              Try again
            </button>
            <button type="button" onClick={() => void exportFile()}>
              Export to file
            </button>
            <a href={target}>Open new editor</a>
          </div>
        </>
      )}
    </section>
  );
}
