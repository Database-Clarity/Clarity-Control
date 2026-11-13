import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { STATUS_FADE_MS, sortNotices, type ShellNotice } from './notices';
import styles from './NoticeStrip.module.scss';

/**
 * Notices as compact overlays at the window's bottom-right, never rows in the page: nothing below
 * them moves when one appears or goes, and none spans the window. Each is as wide as its message,
 * with its actions and a close button right beside the text; Esc on a focused notice dismisses it
 * and returns focus to where it came from. An open editor panel (the Working diff, a status bar
 * panel) or the editor's status bar under them lifts them above its top edge (useClearPanels).
 * Alerts above warnings above statuses. A status fades after six seconds, paused
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
  const strip = useRef<HTMLDivElement>(null);
  useClearPanels(strip, shown.length > 0);
  if (!shown.length) return null;
  return (
    <div ref={strip} className={styles.strip} data-notice-strip>
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
  // Where focus was before it entered the notice, so Esc can hand it back.
  const cameFrom = useRef<Element | null>(null);
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
      onFocus={(event) => {
        setPaused(true);
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          cameFrom.current = event.relatedTarget as Element | null;
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !dismissible || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        const back = cameFrom.current;
        onDismiss();
        if (back instanceof HTMLElement && back.isConnected) back.focus();
      }}
    >
      <span className={styles.body}>
        <span className={styles.text}>{notice.text}</span>
        {notice.actions?.map((action) => (
          <button key={action.label} type="button" onClick={action.onClick}>
            {action.label}
          </button>
        ))}
      </span>
      {dismissible && (
        <button type="button" className={styles.close} aria-label="Dismiss" onClick={onDismiss}>
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
}

/** Editor panels that open upward over the text, and the status bar that opens them. */
const PANELS = '[data-editor-overlay], [data-editor-status]';
const GAP = 4;
/** The narrowest column (rem) the notices squeeze into beside a panel instead of rising. */
const NARROWEST = 15;

/**
 * Keeps the notices off an open editor panel (the Working diff, a status bar panel) and the
 * editor's status bar (on a phone it can sit right under them). A panel ending to their left with
 * a column of at least NARROWEST beside it narrows them into that column (--room), in place.
 * One under them otherwise lifts the strip (--clear) until its bottom is just above that panel's
 * top edge, over the text, where it sits anyway with no panel open. It never rises under the header: where the
 * panels leave no room above them (a phone at a large interface scale), it rises only past the
 * ones it can clear. Runs only while a notice is shown; typing in the text is ignored, and
 * positions are read once per frame at most.
 */
function useClearPanels(strip: RefObject<HTMLDivElement | null>, shown: boolean) {
  useLayoutEffect(() => {
    const element = strip.current;
    if (!shown || !element) return;
    const doc = element.ownerDocument;
    const win = doc.defaultView;
    if (!win || typeof ResizeObserver === 'undefined') return;
    let lift = 0;
    let room = 0;
    let frame = 0;
    let panels: Element[] = [];
    const set = (name: string, value: number) => {
      if (value) element.style.setProperty(name, `${value}px`);
      else element.style.removeProperty(name);
    };
    const place = () => {
      frame = 0;
      const notes = [...element.children].map((child) => child.getBoundingClientRect());
      if (!notes.length) return;
      // Where the notices sit without the lift.
      const bottom = Math.max(...notes.map((r) => r.bottom)) + lift;
      const height = bottom - lift - Math.min(...notes.map((r) => r.top));
      const right = Math.max(...notes.map((r) => r.right));
      // As far left as they reach at full width.
      const reach = element.getBoundingClientRect().left;
      const narrowest = NARROWEST * parseFloat(win.getComputedStyle(doc.documentElement).fontSize);
      const boxes = panels
        .map((panel) => panel.getBoundingClientRect())
        .filter((r) => r.width >= 1 && r.height >= 1 && r.right > reach && r.left < right);
      // A panel that ends to their left with a usable column beside it (the Working diff in the
      // editor column, the preview column beside it): they narrow into that column, staying in
      // place, rather than leaping up over the other column's content.
      const beside = boxes.filter(
        (r) => r.right + GAP + narrowest <= right && r.top < bottom && r.bottom > bottom - height,
      );
      const nextRoom = beside.length
        ? Math.floor(right - Math.max(...beside.map((r) => r.right)) - GAP)
        : 0;
      const left = nextRoom ? right - nextRoom : Math.min(...notes.map((r) => r.left));
      const under = boxes.filter((r) => !beside.includes(r) && r.right > left);
      // Rise above each panel still under them; one stacked on top (the Working diff over the
      // status bar) can then be in the way in turn. Never under the header: where the stack
      // leaves no room, they stop at the highest edge that still fits.
      const ceiling = (doc.querySelector('header')?.getBoundingClientRect().bottom ?? 0) + GAP;
      let edge = bottom;
      let fits = bottom;
      for (;;) {
        // The lowest panel in the way first, so each step up is as small as it can be.
        const tops = under
          .filter((r) => r.top - GAP < edge && r.bottom > edge - height)
          .map((r) => r.top - GAP);
        if (!tops.length) break;
        edge = Math.max(...tops);
        if (edge - height >= ceiling) fits = edge;
      }
      const nextLift = Math.round(bottom - fits);
      if (nextRoom !== room) set('--room', (room = nextRoom));
      if (nextLift !== lift) set('--clear', (lift = nextLift));
    };
    const schedule = () => {
      if (!frame) frame = win.requestAnimationFrame(place);
    };
    const sizes = new ResizeObserver(schedule);
    sizes.observe(element);
    const find = () => {
      const now = [...doc.querySelectorAll(PANELS)];
      if (now.length === panels.length && now.every((panel, i) => panel === panels[i])) return;
      for (const panel of panels) sizes.unobserve(panel);
      panels = now;
      for (const panel of panels) sizes.observe(panel);
      schedule();
    };
    find();
    // A panel opening or closing: added or removed, or a kept one (the markup help sheet) gaining
    // or losing its marker. Edits inside the text never add or remove one.
    const added = new MutationObserver((records) => {
      if (records.every((r) => r.target instanceof Element && r.target.closest('.cm-content')))
        return;
      find();
    });
    added.observe(doc.body, {
      childList: true,
      subtree: true,
      attributeFilter: ['data-editor-overlay', 'data-editor-status'],
    });
    const viewport = win.visualViewport;
    const options = { capture: true, passive: true } as const;
    win.addEventListener('resize', schedule);
    win.addEventListener('scroll', schedule, options);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    return () => {
      win.cancelAnimationFrame(frame);
      sizes.disconnect();
      added.disconnect();
      win.removeEventListener('resize', schedule);
      win.removeEventListener('scroll', schedule, options);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
    };
  }, [strip, shown]);
}
