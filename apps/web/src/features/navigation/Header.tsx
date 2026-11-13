import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { workspacePath, type MenuUser } from './links';
import { sessionToken } from '../../services/session';
import { useAuthStore } from '../../stores/auth';
import {
  compactQuery,
  driftTabQuery,
  laptopQuery,
  managementTabQuery,
  useMedia,
} from '../../ui/useMedia';
import { Brand } from './Brand';
import { DraftButton } from './DraftButton';
import { IdentityMenu } from './IdentityMenu';
import { SettingsButton } from './SettingsButton';
import { WorkspaceTabs } from './WorkspaceTabs';
import styles from './Header.module.scss';

/**
 * The desktop header, 36px: lockup, workspace tabs for the role, the workspace's finder, drafts,
 * the Settings gear, identity. Below 1100px the finder drops to its own 32px band under the bar so the tabs keep
 * their room. The phone has its own header (PhoneHeader). The lockup gives way to the diamond mark
 * (same height) whenever the bar is too tight to leave the finder its room: decided from the
 * measured width of the bar, never from the device.
 */
export function Header({
  user,
  pathname,
  routeFor,
  finder,
  overlay,
}: {
  user: MenuUser | null | undefined;
  pathname: string;
  routeFor(to: string): string;
  /** The finder slot content; rendered in the bar, or in the band when compact. */
  finder: ReactNode;
  /** Notices that hang from the header's lower edge without taking space. */
  overlay?: ReactNode;
}) {
  const compact = useMedia(compactQuery);
  // The tab layout band (which workspaces fold or promote) and the workspace (whether the finder
  // sits in the bar): the header's settled widths are remembered for each pair.
  const band = `${+useMedia(laptopQuery)}${+useMedia(driftTabQuery)}${+useMedia(managementTabQuery)}`;
  const bar = useRef<HTMLDivElement>(null);
  const tight = useTightBar(bar, compact, `${band}|${workspacePath(pathname)}`);
  return (
    <header className={styles.header} data-compact={compact || undefined}>
      <div ref={bar} className={styles.bar}>
        <Brand className={styles.brand} compact={compact || tight} />
        <WorkspaceTabs user={user} pathname={pathname} routeFor={routeFor} />
        {!compact && <div className={styles.finder}>{finder}</div>}
        <div className={styles.end}>
          <DraftButton />
          <SettingsButton />
          <IdentityMenu />
        </div>
      </div>
      {compact && <div className={`${styles.finder} ${styles.band}`}>{finder}</div>}
      {overlay}
    </header>
  );
}

/** The lockup's own proportions (viewBox 6005 x 1020) at the header's 1.75rem height. */
const LOCKUP_ASPECT = 6005 / 1020;
const LOCKUP_HEIGHT_REM = 1.75;
/**
 * The finder slot holds the category select (12rem) and the field (14rem preferred, 12rem at
 * least) with its position readout: below this the field is under ~14rem.
 */
const FINDER_MIN_REM = 25;
/**
 * With the finder present the slot needs room for the category, the weapon, activity, or artifact select
 * (another 12rem and a gap), the field and the readout, or the readout would sit under the field;
 * the lockup gives way first. It does not depend on the open category, so the header never moves
 * when the category changes.
 */
const FINDER_MIN_WITH_FINDER_REM = 41;
const finderSelector = 'section[aria-label="Tooltip navigation"]';

const settledKey = 'clarity-header-settled:v1';
/**
 * A signed-in header as it last settled, in rem: the tabs plus the account end, and the narrowest
 * window that leaves the finder its room beside the lockup.
 */
type Settled = { reserve: number; fits: number };

function readSettled(): Record<string, Settled> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(settledKey) ?? '{}');
    return stored && typeof stored === 'object' ? (stored as Record<string, Settled>) : {};
  } catch {
    return {};
  }
}

/**
 * The remembered signed-in header, while the bar waits for that account: a stored session being
 * checked, or an account already known. Until /me answers, the bar shows the signed-out tabs and
 * Sign in; a returning account then grows the tabs, which used to swap the lockup for the mark
 * one paint after landing. While the check runs, the remembered widths stand in for the live ones.
 */
function remembered(key: string): Settled | undefined {
  const { loading, user } = useAuthStore.getState();
  if (!user) {
    if (!loading) return undefined;
    try {
      if (!sessionToken()) return undefined;
    } catch {
      return undefined;
    }
  }
  const entry = readSettled()[key];
  return entry && Number.isFinite(entry.reserve) && Number.isFinite(entry.fits) ? entry : undefined;
}

/**
 * The first render's answer, before anything is laid out: the remembered narrowest window for the
 * lockup against the window's width, through a media query (no layout read). A media query's em
 * is the browser's default font size, which the interface scale multiplies into the rem.
 */
function initialTight(key: string, compact: boolean): boolean {
  if (compact || typeof window === 'undefined' || typeof window.matchMedia !== 'function')
    return false;
  const entry = remembered(key);
  if (!entry) return false;
  const scale = (Number(document.documentElement.dataset.uiScale) || 100) / 100;
  return !window.matchMedia(`(min-width: ${entry.fits * scale}em)`).matches;
}

/** Rounds to an eighth of a rem, the precision the remembered widths keep. */
const eighth = (rem: number) => Math.round(rem * 8) / 8;

/**
 * Whether the lockup would leave the finder under its minimum. Measured from the parts that do not
 * depend on the brand (the bar, the tabs, the account end), so switching the artwork can never feed
 * back into the decision. It measures in a resize observer's callback, which comes after the
 * browser lays the bar out and before that frame paints, and renders a change at once; the first
 * render starts from the remembered answer, so the first layout is already right without laying
 * the page out early inside the render that mounts it. Both artworks are always the same height:
 * the swap moves only what is to the right of the brand.
 */
function useTightBar(
  bar: RefObject<HTMLDivElement | null>,
  compact: boolean,
  key: string,
): boolean {
  const [tight, setTight] = useState(() => initialTight(key, compact));
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element || compact) {
      setTight(false);
      return;
    }
    let present = false;
    const measure = (apply: (next: boolean) => void) => {
      const tabs = element.querySelector('nav');
      const end = element.lastElementChild;
      // Not laid out (a test DOM, a hidden tab): nothing to measure, keep the lockup.
      if (!tabs || !end || element.clientWidth === 0) return;
      const style = getComputedStyle(element);
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const gap = parseFloat(style.columnGap) || 0;
      const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const brand = element.firstElementChild as HTMLElement | null;
      const brandMargin = brand ? parseFloat(getComputedStyle(brand).marginRight) || 0 : 0;
      const lockup = LOCKUP_HEIGHT_REM * rem * LOCKUP_ASPECT;
      const fixed = padding + lockup + brandMargin + gap * 3;
      const live = tabs.getBoundingClientRect().width + end.getBoundingClientRect().width;
      present = element.querySelector(finderSelector) !== null;
      const finderMin = (present ? FINDER_MIN_WITH_FINDER_REM : FINDER_MIN_REM) * rem;
      const { loading, user } = useAuthStore.getState();
      if (user && !loading) {
        // Settled: remember it for the next landing (written only when it changes).
        const outside = window.innerWidth - element.clientWidth;
        const settled = {
          reserve: eighth(live / rem),
          fits: eighth((outside + fixed + live + finderMin) / rem),
        };
        const known = readSettled();
        const before = known[key];
        if (before?.reserve !== settled.reserve || before.fits !== settled.fits) {
          try {
            localStorage.setItem(settledKey, JSON.stringify({ ...known, [key]: settled }));
          } catch {
            /* Storage is optional: the next landing measures as before. */
          }
        }
        apply(element.clientWidth - fixed - live < finderMin);
        return;
      }
      const reserve = (remembered(key)?.reserve ?? 0) * rem;
      apply(element.clientWidth - fixed - Math.max(live, reserve) < finderMin);
    };
    if (typeof ResizeObserver === 'undefined') {
      measure(setTight);
      return;
    }
    // Outside React's own work, so the change is rendered before the frame paints.
    const observer = new ResizeObserver(() => measure((next) => flushSync(() => setTight(next))));
    const watch = () => {
      observer.observe(element);
      for (const child of element.children) observer.observe(child);
    };
    watch();
    // The finder comes and goes with the workspace: measure again, after the next layout, when it
    // does (observing the bar afresh reports it again even at the same size).
    const mutations =
      typeof MutationObserver === 'undefined'
        ? undefined
        : new MutationObserver(() => {
            if ((element.querySelector(finderSelector) !== null) === present) return;
            observer.disconnect();
            watch();
          });
    mutations?.observe(element, { subtree: true, childList: true });
    // The session check settles the tabs and the account end: measure again then, even when
    // nothing resized (remembered widths that did not come true).
    const auth = useAuthStore.subscribe((state, previous) => {
      if (state.loading === previous.loading && state.user === previous.user) return;
      observer.disconnect();
      watch();
    });
    return () => {
      observer.disconnect();
      mutations?.disconnect();
      auth();
    };
  }, [bar, compact, key]);
  return tight;
}
