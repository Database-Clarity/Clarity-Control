import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { MenuUser } from './links';
import { compactQuery, useMedia } from '../../ui/useMedia';
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
  const bar = useRef<HTMLDivElement>(null);
  const tight = useTightBar(bar, compact);
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

/**
 * Whether the lockup would leave the finder under its minimum. Measured from the parts that do not
 * depend on the brand (the bar, the tabs, the account end), so switching the artwork can never feed
 * back into the decision, and done in a layout effect so the first paint is already right. Both
 * artworks are always the same height: the swap moves only what is to the right of the brand.
 */
function useTightBar(bar: RefObject<HTMLDivElement | null>, compact: boolean): boolean {
  const [tight, setTight] = useState(false);
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element || compact) {
      setTight(false);
      return;
    }
    let present = false;
    const measure = () => {
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
      const used =
        padding +
        lockup +
        brandMargin +
        tabs.getBoundingClientRect().width +
        end.getBoundingClientRect().width +
        gap * 3;
      present = element.querySelector(finderSelector) !== null;
      setTight(
        element.clientWidth - used < (present ? FINDER_MIN_WITH_FINDER_REM : FINDER_MIN_REM) * rem,
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    // The finder comes and goes with the workspace: measure again when it does.
    const mutations =
      typeof MutationObserver === 'undefined'
        ? undefined
        : new MutationObserver(() => {
            if ((element.querySelector(finderSelector) !== null) !== present) measure();
          });
    mutations?.observe(element, { subtree: true, childList: true });
    return () => {
      observer.disconnect();
      mutations?.disconnect();
    };
  }, [bar, compact]);
  return tight;
}
