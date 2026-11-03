import { useEffect, useRef, useState } from 'react';
import { STATUS_FADE_MS, sortNotices, type ShellNotice } from './notices';
import styles from './NoticeStrip.module.scss';

/**
 * Notices as overlays under the header, never rows in the page: nothing below them moves when one
 * appears or goes. Alerts above warnings above statuses. A status fades after six seconds, paused
 * while the pointer or keyboard focus is on it; alerts and warnings stay until dismissed or until
 * the condition resolves. Dismissing hides that occurrence only: it comes back if the condition
 * goes away and returns, and nothing is remembered across a reload.
 */
export function NoticeStrip({ notices }: { notices: ShellNotice[] }) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const key = (notice: ShellNotice) => `${notice.id}\u0000${notice.text}`;
  // A condition that has resolved is forgotten, so its next occurrence shows again.
  const live = notices.map(key).join('\u0001');
  useEffect(() => {
    const current = new Set(live.split('\u0001'));
    setDismissed((previous) => {
      const kept = [...previous].filter((entry) => current.has(entry));
      return kept.length === previous.size ? previous : new Set(kept);
    });
  }, [live]);
  const shown = sortNotices(notices).filter((notice) => !dismissed.has(key(notice)));
  if (!shown.length) return null;
  return (
    <div className={styles.strip} data-notice-strip>
      {shown.map((notice) => (
        <Notice
          key={notice.id}
          notice={notice}
          onDismiss={() => {
            setDismissed((previous) => new Set(previous).add(key(notice)));
            notice.onDismiss?.();
          }}
        />
      ))}
    </div>
  );
}

function Notice({ notice, onDismiss }: { notice: ShellNotice; onDismiss(): void }) {
  const [due, setDue] = useState(!notice.delay);
  const [paused, setPaused] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const { delay, level } = notice;
  useEffect(() => {
    if (due || !delay) return;
    const timer = setTimeout(() => setDue(true), delay);
    return () => clearTimeout(timer);
  }, [due, delay]);
  useEffect(() => {
    if (level !== 'status' || !due || paused) return;
    const timer = setTimeout(() => dismiss.current(), STATUS_FADE_MS);
    return () => clearTimeout(timer);
  }, [level, due, paused, notice.text]);
  if (!due) return null;
  const dismissible = notice.dismissible ?? true;
  return (
    <div
      className={styles.notice}
      data-level={notice.level}
      role={notice.level === 'alert' ? 'alert' : 'status'}
      title={notice.detail}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
      }}
    >
      <span className={styles.text}>{notice.text}</span>
      {notice.actions?.map((action) => (
        <button key={action.label} type="button" onClick={action.onClick}>
          {action.label}
        </button>
      ))}
      {dismissible && (
        <button type="button" className={styles.close} aria-label="Dismiss" onClick={onDismiss}>
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
}
