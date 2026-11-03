import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { SaveController } from '../../services/save/SavePanel';
import { useSaveNotice } from '../../services/save/notice';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import { Header } from './Header';
import { PhoneHeader } from './PhoneHeader';
import { PreviewLeaveGuard } from './PreviewLeaveGuard';
import { ShellSlotHost, ShellSlotsProvider } from './ShellSlots';
import { TooltipNavigation } from './TooltipNavigation';
import { itemFor } from './catalog';
import { documentTitle } from './documentTitle';
import { links, workspacePath } from './links';
import { CompendiumSidebarNavigation, ReviewSidebarNavigation } from './SidebarNavigation';
import { SettingsNotice } from '../settings/SettingsChoice';
import { SettingsSync } from '../settings/SettingsSync';
import { SettingsPopover } from '../settings/SettingsPopover';
import { RememberRoute } from '../settings/SettingsRedirect';
import { useSettingsPanel } from '../settings/panel';
import styles from './Layout.module.scss';

export function Layout() {
  return (
    <ShellSlotsProvider>
      <LayoutContent />
    </ShellSlotsProvider>
  );
}

function LayoutContent() {
  const location = useLocation();
  const user = useAuthStore((state) => state.user);
  const phone = useMedia(phoneQuery);
  const layout = useRef<HTMLDivElement>(null);
  const lastWorkspaceRoutes = useRef<Record<string, string>>({});
  const { data, status, error, load } = useDataStore();
  const authLoading = useAuthStore((state) => state.loading);
  const userId = user?.id;
  const {
    hydrated,
    pending,
    error: draftError,
    previousAccountError,
    dismissPreviousAccountError,
    hydrate,
    activate,
    retry,
    unowned,
    adopt,
    keepSeparate,
  } = useDraftStore();
  const [adoptNote, setAdoptNote] = useState<string | null>(null);
  const saveNotice = useSaveNotice((state) => state.notice);
  const dismissSaveNotice = useSaveNotice((state) => state.dismiss);
  const settingsOpen = useSettingsPanel((state) => state.open);
  const isEditor = location.pathname.startsWith('/t/');
  const isCompendium = location.pathname.startsWith('/compendium');
  const isReview = location.pathname === '/review';
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

  // A workspace tab returns to the page last open there; the current workspace keeps its page.
  const routeFor = (to: string) =>
    to === workspacePath(location.pathname)
      ? `${location.pathname}${location.search}`
      : (lastWorkspaceRoutes.current[to] ?? to);
  const contextual = isCompendium || isReview;
  // The editor's finder is the tooltip combobox; Compendium and Review keep their queue lists.
  const finder = (
    <>
      {data && isEditor && <TooltipNavigation data={data} variant={phone ? 'sheet' : 'bar'} />}
      {phone && isCompendium && <CompendiumSidebarNavigation />}
      {phone && isReview && <ReviewSidebarNavigation />}
      <ShellSlotHost name="finder" className={styles.slotHost} />
    </>
  );

  return (
    <>
      <div
        id="shell-root"
        ref={layout}
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
          />
        ) : (
          <Header user={user} pathname={location.pathname} routeFor={routeFor} finder={finder} />
        )}
        <div className={styles.body}>
          {!phone && contextual && (
            <aside className={styles.context} aria-label="Context">
              {isCompendium && <CompendiumSidebarNavigation />}
              {isReview && <ReviewSidebarNavigation />}
            </aside>
          )}
          <main className={styles.main} id="main-content" tabIndex={-1}>
            <SettingsSync />
            <RememberRoute />
            {!settingsOpen && <SettingsNotice />}
            {draftError && (
              <p role="alert">
                {draftError}{' '}
                <button type="button" onClick={() => (hydrated ? retry() : void hydrate())}>
                  Retry draft storage
                </button>
              </p>
            )}
            {hydrated && unowned > 0 && (
              <p role="status">
                {unowned} local draft(s) on this browser were made while signed out or before drafts
                were tied to accounts. Add them to your account?{' '}
                <button
                  type="button"
                  onClick={() =>
                    void adopt().then(
                      ({ adopted, left }) =>
                        setAdoptNote(
                          adopted === 0
                            ? 'No drafts were added. Check draft storage and retry, or keep them separate.'
                            : `Added ${adopted} draft(s) to your account.${left ? ` ${left} conflicting draft(s) stayed separate.` : ''}`,
                        ),
                      (error: unknown) =>
                        setAdoptNote(
                          `Could not add drafts: ${error instanceof Error ? error.message : String(error)}`,
                        ),
                    )
                  }
                >
                  Add to my account
                </button>{' '}
                <button type="button" onClick={keepSeparate}>
                  Keep separate
                </button>
              </p>
            )}
            {adoptNote && <p role="status">{adoptNote}</p>}
            {saveNotice && (
              <p role="status">
                {saveNotice}{' '}
                <button type="button" onClick={dismissSaveNotice}>
                  Dismiss
                </button>
              </p>
            )}
            {previousAccountError && (
              <p role="alert">
                {previousAccountError}{' '}
                <button type="button" onClick={dismissPreviousAccountError}>
                  Dismiss
                </button>
              </p>
            )}
            {pending > 0 && <p role="status">Saving local drafts...</p>}
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
        </div>
        {/* Places routes publish into (left column, identity, status); empty until they do. */}
        <ShellSlotHost name="left" className={styles.slotHost} />
        <ShellSlotHost name="identity" className={styles.slotHost} />
        <ShellSlotHost name="status" className={styles.slotHost} />
      </div>
      {/* Outside the inert-able shell root: native dialogs and the save session must stay usable. */}
      <SettingsPopover layout={layout} />
      <PreviewLeaveGuard />
      <SaveController />
    </>
  );
}
