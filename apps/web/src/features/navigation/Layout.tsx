import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { AuthStatus } from '../auth/AuthStatus';
import { SavePanel } from '../../services/save/SavePanel';
import { dockHeightProperty, trackDockHeight } from '../../services/save/dock';
import { TooltipNavigation } from './TooltipNavigation';
import { visibleLinks } from './links';
import { CompendiumSidebarNavigation, ReviewSidebarNavigation } from './SidebarNavigation';
import { CompendiumBadge } from '../compendium/CompendiumBadge';
import styles from './Layout.module.scss';

function workspacePath(pathname: string) {
  if (pathname.startsWith('/t/')) return '/';
  if (pathname.startsWith('/compendium')) return '/compendium';
  if (pathname === '/') return '/';
  return `/${pathname.split('/')[1]}`;
}

export function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const workspaceLinks = visibleLinks(user);
  const [navOpen, setNavOpen] = useState(false);
  const layout = useRef<HTMLDivElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const browseButton = useRef<HTMLButtonElement>(null);
  const skipLink = useRef<HTMLAnchorElement>(null);
  const mainContent = useRef<HTMLElement>(null);
  const lastWorkspaceRoutes = useRef<Record<string, string>>({});
  const navOpenRef = useRef(false);
  const restoreBrowseFocus = useRef(false);
  const { data, status, error, load } = useDataStore();
  const { hydrated, pending, error: draftError, hydrate, retry } = useDraftStore();
  const isEditor = location.pathname.startsWith('/t/');
  const isCompendium = location.pathname.startsWith('/compendium');
  const isReview = location.pathname === '/review';
  useEffect(() => {
    void load();
    void hydrate();
  }, [load, hydrate]);
  useEffect(() => {
    if (!navOpenRef.current) return;
    restoreBrowseFocus.current = true;
    navOpenRef.current = false;
    setNavOpen(false);
  }, [location.pathname, location.search]);
  useEffect(() => {
    const workspace = workspacePath(location.pathname);
    lastWorkspaceRoutes.current[workspace] = `${location.pathname}${location.search}`;
  }, [location.pathname, location.search]);
  useEffect(() => {
    if (!navOpen) {
      if (restoreBrowseFocus.current) {
        browseButton.current?.focus();
        restoreBrowseFocus.current = false;
      }
      return;
    }
    const previousOverflow = document.body.style.overflow;
    const previousInert = [skipLink.current, mainContent.current]
      .filter((element): element is HTMLElement => element !== null)
      .map((element) => ({ element, value: element.getAttribute('inert') }));
    document.body.style.overflow = 'hidden';
    for (const { element } of previousInert) element.setAttribute('inert', '');
    browseButton.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      // A native save/conflict dialog owns focus and Escape above Browse.
      if (document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        restoreBrowseFocus.current = true;
        navOpenRef.current = false;
        setNavOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const drawer = sidebar.current;
      const focusable = drawer
        ? [
            ...drawer.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ].filter((element) => {
            const closedDetails = element.closest('details:not([open])');
            if (
              element.closest('[hidden], [inert], [data-idle="true"]') ||
              (closedDetails && !element.matches('summary'))
            )
              return false;
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden';
          })
        : [];
      const first = focusable[0] ?? browseButton.current;
      const last = focusable.at(-1) ?? browseButton.current;
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!drawer?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => {
      window.removeEventListener('keydown', keydown);
      document.body.style.overflow = previousOverflow;
      for (const { element, value } of previousInert) {
        if (value === null) element.removeAttribute('inert');
        else element.setAttribute('inert', value);
      }
    };
  }, [navOpen]);
  useEffect(() => {
    // Reserve the dock's real height (wrapped notices, large text, safe area) below the content.
    const root = layout.current;
    const dock = root?.querySelector<HTMLElement>(`.${styles.saveDock}`);
    if (!root || !dock) return;
    const stop = trackDockHeight(dock, (height) =>
      root.style.setProperty(dockHeightProperty, height),
    );
    return () => {
      stop();
      root.style.removeProperty(dockHeightProperty);
    };
  }, []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (pending || draftError) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [pending, draftError]);

  return (
    <div
      ref={layout}
      className={`${styles.layout} ${isCompendium ? styles.reviewMode : ''} ${isReview ? styles.reviewMode : ''} ${isEditor ? styles.editorMode : ''}`}
    >
      <a
        ref={skipLink}
        className={styles.skipLink}
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Skip to content
      </a>
      <aside
        id="sidebar"
        ref={sidebar}
        className={styles.sidebar}
        data-open={navOpen}
        role={navOpen ? 'dialog' : undefined}
        aria-modal={navOpen || undefined}
        aria-label={navOpen ? 'Browse' : undefined}
      >
        <header className={styles.brand}>
          <strong>Clarity</strong>
          <span>Description editor v2</span>
        </header>
        <button
          ref={browseButton}
          type="button"
          className={styles.navToggle}
          aria-expanded={navOpen}
          aria-controls="sidebar"
          aria-label={navOpen ? 'Close Browse' : 'Browse'}
          onClick={() => {
            const open = !navOpenRef.current;
            navOpenRef.current = open;
            if (!open) restoreBrowseFocus.current = true;
            setNavOpen(open);
          }}
        >
          {navOpen ? 'Close' : 'Browse'}
        </button>
        <div className={styles.sidebarBody}>
          {data && isEditor && <TooltipNavigation data={data} />}
          {isCompendium && <CompendiumSidebarNavigation />}
          {isReview && <ReviewSidebarNavigation />}
          <label className={styles.pageSelection}>
            Workspace
            <select
              value={
                workspaceLinks.find(({ to }) => to !== '/' && location.pathname.startsWith(to))
                  ?.to ?? '/'
              }
              onChange={(event) =>
                navigate(lastWorkspaceRoutes.current[event.target.value] ?? event.target.value)
              }
            >
              {workspaceLinks.map(({ to, label }) => (
                <option key={to} value={to}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <AuthStatus />
          <SavePanel className={styles.saveDock} />
          <CompendiumBadge />
          <p className={styles.status}>
            {data && `Data revision ${data.bundle.sourceCommit.slice(0, 8)}`}
          </p>
        </div>
      </aside>
      <main
        ref={mainContent}
        className={styles.main}
        id="main-content"
        tabIndex={-1}
        aria-hidden={navOpen || undefined}
      >
        {draftError && (
          <p role="alert">
            {draftError}{' '}
            <button type="button" onClick={() => (hydrated ? retry() : void hydrate())}>
              Retry draft storage
            </button>
          </p>
        )}
        {pending > 0 && <p role="status">Saving local drafts...</p>}
        {status === 'loading' && <p role="status">Loading manifest and tooltip data...</p>}
        {error && (
          <p role="alert">
            {location.pathname === '/archive'
              ? 'Manifest looks incomplete — archive view paused'
              : 'Cannot load editor data'}
            : {error}{' '}
            <button type="button" onClick={() => void load()}>
              Retry data loading
            </button>
          </p>
        )}
        {error && location.pathname === '/archive' && (
          <details>
            <summary>Details</summary>
            <p>{error}</p>
          </details>
        )}
        {!hydrated && !draftError && <p role="status">Recovering local drafts...</p>}
        {status === 'ready' && hydrated && <Outlet />}
      </main>
    </div>
  );
}
