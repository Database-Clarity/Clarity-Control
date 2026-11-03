import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { usePreviewReviewStore } from '../../stores/previewReview';
import { SaveController } from '../../services/save/SavePanel';
import { workspaceShortcutsBlocked } from '../../ui/interaction';
import { PaneDivider } from '../../ui/PaneDivider';
import { usePaneDivider } from '../../ui/usePaneDivider';
import { compactQuery, laptopQuery, phoneQuery, useMedia } from '../../ui/useMedia';
import { Header } from './Header';
import { NoticeStrip } from './NoticeStrip';
import { PhoneHeader } from './PhoneHeader';
import { PreviewLeaveGuard } from './PreviewLeaveGuard';
import { ShellColumnContext, type ShellColumn } from './ShellColumnContext';
import { ShellSlotHost, ShellSlotsProvider } from './ShellSlots';
import { ShellStatus } from './ShellStatus';
import { TooltipNavigation } from './TooltipNavigation';
import { canonicalHash, itemFor } from './catalog';
import { documentTitle } from './documentTitle';
import { links, workspacePath } from './links';
import { count } from './notices';
import { useShellNotices } from './useShellNotices';
import { CompendiumSidebarNavigation, ReviewSidebarNavigation } from './SidebarNavigation';
import { SettingsSync } from '../settings/SettingsSync';
import { SettingsPopover } from '../settings/SettingsPopover';
import { RememberRoute } from '../settings/SettingsRedirect';
import styles from './Layout.module.scss';

export function Layout() {
  return (
    <ShellSlotsProvider>
      <LayoutContent />
    </ShellSlotsProvider>
  );
}

/** Left column limits: it sizes 280–480 and the page beside it keeps at least 480. */
const COLUMN_MIN = 280;
const COLUMN_MAX = 480;
const MAIN_MIN = 480;

function LayoutContent() {
  const location = useLocation();
  const user = useAuthStore((state) => state.user);
  const phone = useMedia(phoneQuery);
  const compact = useMedia(compactQuery);
  const laptop = useMedia(laptopQuery);
  const layout = useRef<HTMLDivElement>(null);
  const aside = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const lastWorkspaceRoutes = useRef<Record<string, string>>({});
  const { data, status, error, load } = useDataStore();
  const authLoading = useAuthStore((state) => state.loading);
  const userId = user?.id;
  const { hydrated, pending, error: draftError, activate } = useDraftStore();
  const notices = useShellNotices();
  const isEditor = location.pathname.startsWith('/t/');
  const isCompendium = location.pathname.startsWith('/compendium');
  const isReview = location.pathname === '/review';
  const contextual = isCompendium || isReview;
  // The left column is the editor's preview, or the Compendium / Review queue list. A phone has
  // neither: the preview is a view of the page and the lists live in the Find sheet.
  const hasColumn = !phone && (isEditor || contextual);
  const previewColumn = hasColumn && isEditor;
  const itemHash = isEditor ? Number(location.pathname.split('/')[2]) : null;
  const pageName =
    itemHash !== null
      ? data?.items
        ? itemFor(itemHash, data)?.name
        : undefined
      : links.find(({ to }) => to === workspacePath(location.pathname))?.label;
  useEffect(() => {
    document.title = documentTitle(pageName);
  }, [pageName]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    // Drafts belong to one account: switch buckets with the signed-in user, never before auth settles.
    if (authLoading) return;
    void activate(userId === undefined ? null : userId);
  }, [authLoading, userId, activate]);
  useEffect(() => {
    const workspace = workspacePath(location.pathname);
    lastWorkspaceRoutes.current[workspace] = `${location.pathname}${location.search}`;
  }, [location.pathname, location.search]);
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
  // Sticky page columns sit under the header, whatever height it has at this width.
  useEffect(() => {
    const element = layout.current;
    const header = element?.querySelector('header');
    if (!element || !header) return;
    const measure = () =>
      element.style.setProperty('--header-h', `${header.getBoundingClientRect().height}px`);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, [phone]);

  const pane = usePaneDivider({
    storeKey: isEditor ? 'editor:left' : isCompendium ? 'compendium:list' : 'review:list',
    sizes: 'start',
    min: COLUMN_MIN,
    max: COLUMN_MAX,
    reserve: MAIN_MIN,
    defaultWidth: laptop ? 304 : 336,
    collapsible: previewColumn,
    // Compact windows start with the preview hidden; opening it pushes the page (the editor is
    // never covered). That is not a saved choice, so the desktop widths are left as they were.
    defaultCollapsed: previewColumn && compact,
    persist: !phone && !(previewColumn && compact),
  });
  const columnCollapsed = previewColumn && pane.collapsed;

  // Actions are stable for the column's lifetime; they read the latest pane through a ref.
  const latest = useRef({ pane, collapsed: columnCollapsed });
  latest.current = { pane, collapsed: columnCollapsed };
  const focusAfterExpand = useRef(false);
  const [actions] = useState(() => ({
    show() {
      const { pane: current, collapsed } = latest.current;
      if (collapsed) {
        focusAfterExpand.current = true;
        current.expand();
      } else aside.current?.focus();
    },
    toggle() {
      const { pane: current, collapsed } = latest.current;
      if (collapsed) {
        focusAfterExpand.current = true;
        current.expand();
        return;
      }
      // Focus leaves before the column is hidden, or it would be lost with it.
      if (aside.current?.contains(document.activeElement)) toggle.current?.focus();
      current.collapse();
    },
  }));
  useEffect(() => {
    if (columnCollapsed || !focusAfterExpand.current) return;
    focusAfterExpand.current = false;
    aside.current?.focus();
  }, [columnCollapsed]);
  useLayoutEffect(() => {
    if (columnCollapsed && aside.current?.contains(document.activeElement)) toggle.current?.focus();
  }, [columnCollapsed]);
  // Alt+P, unless a dialog, sheet or open list owns the keyboard.
  useEffect(() => {
    if (!previewColumn) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.code !== 'KeyP' && event.key.toLowerCase() !== 'p') return;
      if (workspaceShortcutsBlocked(event)) return;
      event.preventDefault();
      actions.toggle();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewColumn, actions]);
  const column = useMemo<ShellColumn | null>(
    () =>
      previewColumn
        ? { collapsed: columnCollapsed, show: actions.show, toggle: actions.toggle }
        : null,
    [previewColumn, columnCollapsed, actions],
  );
  const canonical =
    previewColumn && itemHash !== null && data?.items ? canonicalHash(itemHash, data) : undefined;
  const unreviewed = usePreviewReviewStore(
    useCallback(
      (state) =>
        canonical === undefined
          ? 0
          : Object.values(state.entries).filter(
              (entry) => entry.canonical === canonical && entry.dirty > entry.reviewed,
            ).length,
      [canonical],
    ),
  );

  // A workspace tab returns to the page last open there; the current workspace keeps its page.
  const routeFor = (to: string) =>
    to === workspacePath(location.pathname)
      ? `${location.pathname}${location.search}`
      : (lastWorkspaceRoutes.current[to] ?? to);
  // The editor's finder is the tooltip combobox; Compendium and Review keep their queue lists.
  const finder = (
    <>
      {data && isEditor && <TooltipNavigation data={data} variant={phone ? 'sheet' : 'bar'} />}
      {phone && isCompendium && <CompendiumSidebarNavigation />}
      {phone && isReview && <ReviewSidebarNavigation />}
      <ShellSlotHost name="finder" className={styles.slotHost} />
    </>
  );
  const overlay = <NoticeStrip notices={notices} />;
  const collapseLabel = columnCollapsed
    ? `Show preview column${unreviewed ? `, ${count(unreviewed, 'change')} not reviewed` : ''}`
    : 'Collapse preview column';

  return (
    <ShellColumnContext.Provider value={column}>
      <div
        id="shell-root"
        ref={layout}
        data-fixed={!phone && isEditor ? '' : undefined}
        className={`${styles.layout} ${isCompendium ? styles.reviewMode : ''} ${isReview ? styles.reviewMode : ''} ${isEditor ? styles.editorMode : ''}`}
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
        {phone ? (
          <PhoneHeader
            user={user}
            pathname={location.pathname}
            routeFor={routeFor}
            title={pageName ?? 'Clarity Control'}
            finder={finder}
            hasFinder={isEditor || contextual}
            overlay={overlay}
          />
        ) : (
          <Header
            user={user}
            pathname={location.pathname}
            routeFor={routeFor}
            finder={finder}
            overlay={overlay}
          />
        )}
        <div
          ref={pane.containerRef}
          className={styles.body}
          data-column={hasColumn ? '' : undefined}
          style={hasColumn ? ({ '--left-w': `${pane.width}px` } as CSSProperties) : undefined}
        >
          {hasColumn && (
            <>
              <aside
                id="shell-left"
                ref={aside}
                tabIndex={-1}
                className={styles.left}
                data-list={contextual || undefined}
                aria-label={previewColumn ? 'Preview' : 'Context'}
                hidden={columnCollapsed}
              >
                {previewColumn && <ShellSlotHost name="left" className={styles.leftHost} />}
                {isCompendium && <CompendiumSidebarNavigation />}
                {isReview && <ReviewSidebarNavigation />}
              </aside>
              <div className={styles.dividerCell} data-collapsed={columnCollapsed || undefined}>
                <PaneDivider
                  {...pane.divider}
                  className={styles.divider}
                  label={previewColumn ? 'Resize preview column' : 'Resize list column'}
                  controls="shell-left"
                />
                {previewColumn && (
                  <button
                    ref={toggle}
                    type="button"
                    className={styles.toggle}
                    aria-label={collapseLabel}
                    title={`${columnCollapsed ? 'Show' : 'Collapse'} preview (Alt+P)`}
                    aria-expanded={!columnCollapsed}
                    aria-controls="shell-left"
                    onClick={actions.toggle}
                  >
                    <span aria-hidden="true">{columnCollapsed ? '›' : '‹'}</span>
                    {columnCollapsed && unreviewed > 0 && (
                      <span className={styles.dot} aria-hidden="true" />
                    )}
                  </button>
                )}
              </div>
            </>
          )}
          <div className={styles.mainCol}>
            <main className={styles.main} id="main-content" tabIndex={-1}>
              <SettingsSync />
              <RememberRoute />
              {/* These replace the page while it cannot be shown, so they take space nothing else is using. */}
              {status === 'loading' && <p role="status">Loading manifest and tooltip data...</p>}
              {error && location.pathname === '/archive' && <h1>Archive</h1>}
              {error && (
                <p role="alert">
                  Cannot load editor data: {error}{' '}
                  <button type="button" onClick={() => void load()}>
                    Retry data loading
                  </button>
                </p>
              )}
              {!hydrated && !draftError && <p role="status">Recovering local drafts...</p>}
              {/* A failed draft recovery must not hide read-only browsing; edit actions stay gated on `hydrated`. */}
              {status === 'ready' && (hydrated || Boolean(draftError)) && <Outlet />}
            </main>
            <ShellStatus />
          </div>
        </div>
        {/* Places routes publish into (identity, status); empty until they do. */}
        <ShellSlotHost name="identity" className={styles.slotHost} />
        <ShellSlotHost name="status" className={styles.slotHost} />
      </div>
      {/* Outside the inert-able shell root: native dialogs and the save session must stay usable. */}
      <SettingsPopover layout={layout} />
      <PreviewLeaveGuard />
      <SaveController />
    </ShellColumnContext.Provider>
  );
}
