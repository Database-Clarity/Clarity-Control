import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { workspacePath, type MenuUser, type WorkspaceMenu } from './links';
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
import { WorkspaceTabs, useWorkspaceItems } from './WorkspaceTabs';
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
  const workspace = workspacePath(pathname);
  const tight = useTightBar(bar, compact, user, `${band}|${workspace}`, workspace);
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

const memoryKey = 'clarity-header-settled:v2';
/** A header as it settled, in rem: the tabs plus the account end, and the narrowest window that fits the lockup. */
type Settled = { reserve: number; fits: number };
/**
 * What the header remembers of the last signed-in account on this device, in rem: the account's
 * role, how its tabs compared with the estimate below, the window's width outside the bar (a
 * scrollbar), which workspaces put the finder in the bar, and the exact widths for each tab band
 * and workspace it settled in.
 */
type Memory = {
  account?: { role: string | null; projects: boolean };
  ratio?: number;
  outside?: number;
  finder?: Record<string, boolean>;
  exact?: Record<string, Settled>;
};

function readMemory(): Memory {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(memoryKey) ?? '{}');
    return stored && typeof stored === 'object' ? (stored as Memory) : {};
  } catch {
    return {};
  }
}

/**
 * Header items at a 16px rem with the shipped labels and font (tab, Reports, More; the account end
 * as signed in): the estimate for a band or workspace the account has not settled in yet. Only a
 * starting point: the remembered ratio corrects it, and the bar's own measurement decides.
 */
const ITEM_REM: Record<string, number> = {
  '/': 3.6,
  '/review': 7.2,
  '/compendium': 6.1,
  '/translations': 5.65,
  '/drift': 5.35,
  '/management': 6,
  '/exports': 4.5,
  '/tooltips': 4.75,
  reports: 5.6,
  more: 4,
};
const ITEM_FALLBACK_REM = 5.5;
const ACCOUNT_END_REM = 8.05;
/** The tab list's 2px gap. */
const TAB_GAP_REM = 2 / 16;
/** Bar padding, the lockup, its margin, and the bar's three gaps (Header.module.scss). */
const BAR_FIXED_REM = 2 * 0.5 + LOCKUP_HEIGHT_REM * LOCKUP_ASPECT + 0.25 + 3 * 0.5;
/** With no account remembered (a first sign-in, cleared storage), plan for an editor's tabs. */
const DEFAULT_ACCOUNT: MenuUser = { role: 'editor' } as MenuUser;

function menuAccount(account: NonNullable<Memory['account']>): MenuUser {
  return { role: account.role, projects: account.projects ? [''] : [] } as unknown as MenuUser;
}

/** The estimated tabs plus account end for these items, in rem (WorkspaceTabs' order). */
function estimateReserve({ primary, more }: WorkspaceMenu, account: MenuUser): number {
  const ids = primary.map(({ to }) => to);
  if (account.role) {
    const at = ids.indexOf('/compendium');
    ids.splice(at === -1 ? ids.length : at + 1, 0, 'reports');
  }
  if (more.length) ids.push('more');
  const tabs = ids.reduce((sum, id) => sum + (ITEM_REM[id] ?? ITEM_FALLBACK_REM), 0);
  return tabs + Math.max(0, ids.length - 1) * TAB_GAP_REM + ACCOUNT_END_REM;
}

/** Whether a stored session is being checked (signed-out tabs until /me answers). */
function waitingForAccount(): boolean {
  const { loading, user } = useAuthStore.getState();
  if (user || !loading) return false;
  try {
    return sessionToken() !== null;
  } catch {
    return false;
  }
}

/** Rounds to an eighth of a rem, the precision the remembered widths keep. */
const eighth = (rem: number) => Math.round(rem * 8) / 8;

/**
 * What the header expects once the account settles, for this band and workspace: the exact widths
 * where it settled before, otherwise the estimate for the remembered (or an editor's) tabs.
 */
function useExpected(
  user: MenuUser | null | undefined,
  key: string,
  workspace: string,
): { expected: Settled; estimate: number } {
  const [memory] = useState(readMemory);
  const account = user ?? (memory.account ? menuAccount(memory.account) : DEFAULT_ACCOUNT);
  const items = useWorkspaceItems(account);
  const estimate = estimateReserve(items, account);
  const exact = memory.exact?.[key];
  if (exact) return { expected: exact, estimate };
  const reserve = estimate * (memory.ratio ?? 1);
  const present = memory.finder?.[workspace] ?? workspace === '/';
  const finderMin = present ? FINDER_MIN_WITH_FINDER_REM : FINDER_MIN_REM;
  return {
    expected: { reserve, fits: (memory.outside ?? 0) + BAR_FIXED_REM + reserve + finderMin },
    estimate,
  };
}

/** Records the settled header for later landings; writes only when something changed. */
function remember(
  user: MenuUser,
  key: string,
  workspace: string,
  values: {
    live: number;
    fits: number;
    outside: number;
    present: boolean;
    estimate: number;
  },
) {
  const memory = readMemory();
  const next: Memory = {
    account: { role: user.role ?? null, projects: Boolean(user.projects?.length) },
    ratio: values.estimate > 0 ? Math.round((values.live / values.estimate) * 1000) / 1000 : 1,
    outside: eighth(values.outside),
    finder: { ...memory.finder, [workspace]: values.present },
    exact: { ...memory.exact, [key]: { reserve: eighth(values.live), fits: eighth(values.fits) } },
  };
  const text = JSON.stringify(next);
  if (text === JSON.stringify(memory)) return;
  try {
    localStorage.setItem(memoryKey, text);
  } catch {
    /* Storage is optional: the next landing estimates as before. */
  }
}

/**
 * Whether the lockup would leave the finder under its minimum. Measured from the parts that do not
 * depend on the brand (the bar, the tabs, the account end), so switching the artwork can never feed
 * back into the decision. It measures in a resize observer's callback, which comes after the
 * browser lays the bar out and before that frame paints, and renders a change at once.
 *
 * Until /me answers, the bar shows the signed-out tabs and Sign in; a returning account then grows
 * the tabs, which used to swap the lockup for the mark one paint after landing. While a stored
 * session is checked, the expected account widths stand in for the live ones, and the first render
 * starts from them through one media query (no layout read: a media query's em is the browser's
 * default font size, which the interface scale multiplies into the rem). When the check ends the
 * bar measures live again.
 */
function useTightBar(
  bar: RefObject<HTMLDivElement | null>,
  compact: boolean,
  user: MenuUser | null | undefined,
  key: string,
  workspace: string,
): boolean {
  const plan = useExpected(user, key, workspace);
  const latest = useRef(plan);
  const [tight, setTight] = useState(() => {
    if (compact || typeof window === 'undefined' || typeof window.matchMedia !== 'function')
      return false;
    if (!waitingForAccount()) return false;
    const scale = (Number(document.documentElement.dataset.uiScale) || 100) / 100;
    return !window.matchMedia(`(min-width: ${plan.expected.fits * scale}em)`).matches;
  });
  useLayoutEffect(() => {
    latest.current = plan;
  });
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
      const { loading, user: account } = useAuthStore.getState();
      if (account && !loading) {
        const outside = window.innerWidth - element.clientWidth;
        remember(account, key, workspace, {
          live: live / rem,
          fits: (outside + fixed + live + finderMin) / rem,
          outside: outside / rem,
          present,
          estimate: latest.current.estimate,
        });
      }
      const reserve = waitingForAccount() ? latest.current.expected.reserve * rem : 0;
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
    // nothing resized (expected widths that did not come true).
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
  }, [bar, compact, key, workspace]);
  return tight;
}
