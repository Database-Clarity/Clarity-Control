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
import { CompendiumBadge } from '../compendium/CompendiumBadge';
import styles from './Layout.module.scss';

export function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const workspaceLinks = visibleLinks(user);
  const [navOpen, setNavOpen] = useState(false);
  const layout = useRef<HTMLDivElement>(null);
  const { data, status, error, load } = useDataStore();
  const { hydrated, pending, error: draftError, hydrate, retry } = useDraftStore();
  useEffect(() => {
    void load();
    void hydrate();
  }, [load, hydrate]);
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);
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
      className={`${styles.layout} ${location.pathname === '/compendium/review' ? styles.reviewMode : ''} ${location.pathname.startsWith('/t/') ? styles.editorMode : ''}`}
    >
      <a
        className={styles.skipLink}
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Skip to content
      </a>
      <aside id="sidebar" className={styles.sidebar} data-open={navOpen}>
        <header className={styles.brand}>
          <strong>Clarity</strong>
          <span>Description editor v2</span>
        </header>
        <button
          type="button"
          className={styles.navToggle}
          aria-expanded={navOpen}
          aria-controls="sidebar"
          onClick={() => setNavOpen((open) => !open)}
        >
          Browse
        </button>
        {data && <TooltipNavigation data={data} />}
        <label className={styles.pageSelection}>
          Workspace
          <select
            value={
              workspaceLinks.find(({ to }) => to !== '/' && location.pathname.startsWith(to))?.to ??
              '/'
            }
            onChange={(event) => navigate(event.target.value)}
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
      </aside>
      <main className={styles.main} id="main-content" tabIndex={-1}>
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
            Cannot load editor data: {error}{' '}
            <button type="button" onClick={() => void load()}>
              Retry data loading
            </button>
          </p>
        )}
        {!hydrated && !draftError && <p role="status">Recovering local drafts...</p>}
        {status === 'ready' && hydrated && <Outlet />}
      </main>
    </div>
  );
}
