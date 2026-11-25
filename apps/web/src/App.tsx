import { LoadingSkeleton, useSkeletonVisible } from './ui/Skeleton';
import { Navigate, useLocation, useParams, useRoutes, type RouteObject } from 'react-router-dom';
import { LazyCompendiumTab } from './features/compendium/LazyCompendiumTab';
import { useDataStore } from './stores/data';
import { navigationGroups } from './features/navigation/catalog';
import { AuthCallback } from './features/auth/AuthCallback';
import { Layout } from './features/navigation/Layout';
import { LazyLostTextPage as LostTextPage } from './features/lost-text/LazyLostTextPage';
import { SettingsRedirect } from './features/settings/SettingsRedirect';
import { PlaceholderPage } from './ui/PlaceholderPage';
import { useAuthStore } from './stores/auth';
import { useEffect } from 'react';
import { canPublishTranslations } from './features/auth/permissions';
import { visibleLinks } from './features/navigation/links';
import { preloadWorkspaces, workspacePage } from './workspacePreload';
import { reviewRoute } from './features/review/route';

import { AppLazyPage } from './AppLazyPage';
import { TooltipPage } from './features/tooltip/TooltipPage';
const loadTranslationsPage = workspacePage(() =>
  import('./features/translations/TranslationsPage').then((module) => ({
    default: module.TranslationsPage,
  })),
);
const TranslationsPage = () => <AppLazyPage load={loadTranslationsPage} />;
const loadArchivePage = workspacePage(() =>
  import('./features/archive/ArchivePage').then((module) => ({ default: module.ArchivePage })),
);
const ArchivePage = () => <AppLazyPage load={loadArchivePage} />;
const loadDriftPage = workspacePage(() =>
  import('./features/drift/DriftPage').then((module) => ({ default: module.DriftPage })),
);
const DriftPage = () => <AppLazyPage load={loadDriftPage} />;
const loadSandboxPerksPage = workspacePage(() =>
  import('./features/sandbox-perks/SandboxPerksPage').then((module) => ({
    default: module.SandboxPerksPage,
  })),
);
const SandboxPerksPage = () => <AppLazyPage load={loadSandboxPerksPage} />;
const loadReviewPage = workspacePage(() =>
  import('./features/review/ReviewPage').then((module) => ({ default: module.ReviewPage })),
);
const ReviewPage = () => <AppLazyPage load={loadReviewPage} />;
const loadAdminPage = workspacePage(() =>
  import('./features/admin/AdminPage').then((module) => ({ default: module.AdminPage })),
);
const AdminPage = () => <AppLazyPage load={loadAdminPage} />;
const loadMigratePage = () =>
  import('./features/migrate/MigratePage').then((module) => ({ default: module.MigratePage }));
const MigratePage = () => <AppLazyPage load={loadMigratePage} />;
// Export pages (spec section 8): their own lazy chunks, never preloaded with the workspaces, so
// the editor's initial graph does not grow.
const loadExportsPage = () =>
  import('./features/exports/ExportsPage').then((module) => ({ default: module.ExportsPage }));
const ExportsPage = () => <AppLazyPage load={loadExportsPage} />;
const loadExportProjectPage = () =>
  import('./features/exports/ProjectPage').then((module) => ({ default: module.ProjectPage }));
const ExportProjectPage = () => <AppLazyPage load={loadExportProjectPage} />;
const loadPublishedTooltipsPage = () =>
  import('./features/exports/TooltipsPage').then((module) => ({ default: module.TooltipsPage }));
const PublishedTooltipsPage = () => <AppLazyPage load={loadPublishedTooltipsPage} />;
// UI gallery (maintainers, no data): its own lazy chunks, never preloaded, so the editor's graph
// does not grow. The frame route sits outside the Layout so the preview loads no workspace data.
const loadGalleryPage = () =>
  import('./features/gallery/GalleryPage').then((module) => ({ default: module.GalleryPage }));
const GalleryPage = () => <AppLazyPage load={loadGalleryPage} />;
const loadGalleryFrame = () =>
  import('./features/gallery/GalleryFrame').then((module) => ({ default: module.GalleryFrame }));
const GalleryFrame = () => <AppLazyPage load={loadGalleryFrame} />;
const ReportPage = () => (
  <AppLazyPage load={() => import('./features/reports/public/ReportPublicPage')} />
);
const workspaceLoaders: Record<string, () => Promise<unknown>> = {
  '/': () => Promise.resolve({ default: TooltipPage }),
  '/review': loadReviewPage,
  '/compendium': () => import('./features/compendium/CompendiumTab'),
  '/translations': loadTranslationsPage,
  '/drift': loadDriftPage,
  '/lost-text': () => import('./features/lost-text/LostTextPage'),
  '/sandbox-perks': loadSandboxPerksPage,
  '/archive': loadArchivePage,
  '/management': loadAdminPage,
};

function WorkspaceRouteLayer() {
  const role = useAuthStore((state) => state.user?.role);
  const translator = useAuthStore((state) => canPublishTranslations(state.user));
  const loading = useAuthStore((state) => state.loading);
  const ready = useDataStore((state) => state.status === 'ready');
  useEffect(() => {
    if (!ready || loading) return;
    return preloadWorkspaces(
      visibleLinks(role ? { ...useAuthStore.getState().user, role } : null)
        .map(({ to }) => workspaceLoaders[to])
        .filter((load) => load !== undefined),
    );
  }, [role, translator, ready, loading]);
  return <Layout />;
}
// Per-entry globals (stable IDs) replace the aggregate list and the /t/1–/t/3 editors only when
// the build turns the switch on; off, these routes and their chunk do not exist.
const loadGlobalEntryRoute = () =>
  import('./features/globals/GlobalEntryRoute').then((module) => ({
    default: module.GlobalEntryRoute,
  }));
const GlobalEntryRoute = () => <AppLazyPage load={loadGlobalEntryRoute} />;
const loadGlobalNameRoute = () =>
  import('./features/globals/GlobalEntryRoute').then((module) => ({
    default: module.GlobalNameRoute,
  }));
const GlobalNameRoute = () => <AppLazyPage load={loadGlobalNameRoute} />;
const loadGlobalHandOff = () =>
  import('./features/globals/GlobalEntryRoute').then((module) => ({
    default: module.GlobalAggregateHandOff,
  }));
/** With globals on, the exports, variables, and titles hand off to their per-entry editor. */
function TooltipRoute() {
  const { hash } = useParams<'hash'>();
  return hash === '1' || hash === '2' || hash === '3' ? (
    <AppLazyPage load={loadGlobalHandOff} />
  ) : (
    <TooltipPage />
  );
}
// Inline (not the shared constant) so the bundler folds it and drops the off branch's imports.
const globalRoutes: RouteObject[] =
  import.meta.env.VITE_GLOBALS_ENABLED === '1'
    ? [
        {
          path: 'globals',
          element: <GlobalEntryRoute />,
          handle: { preload: loadGlobalEntryRoute },
        },
        {
          path: 'globals/:id',
          element: <GlobalEntryRoute />,
          handle: { preload: loadGlobalEntryRoute },
        },
        { path: 'globals/:kind/:name', element: <GlobalNameRoute /> },
      ]
    : [];

/**
 * Every route in one place, as plain objects: main.tsx hands them to createHashRouter (a data
 * router, which the leave guard's useBlocker needs) and tests hand them to createMemoryRouter.
 * Paths, the index route, the auth callback outside the Layout and the catch-all are unchanged.
 */
export const routes: RouteObject[] = [
  { path: 'auth/callback', element: <AuthCallback /> },
  // Receives drafts from the old site; outside the Layout so it loads no data and is inert alone.
  { path: 'migrate', element: <MigratePage /> },
  { path: 'report/*', element: <ReportPage /> },
  { path: 'management/ui/frame', element: <GalleryFrame /> },
  {
    element: <WorkspaceRouteLayer />,
    children: [
      { index: true, element: <StartPage /> },
      {
        path: 't/:hash',
        element: import.meta.env.VITE_GLOBALS_ENABLED === '1' ? <TooltipRoute /> : <TooltipPage />,
        handle: { preload: () => Promise.resolve({ default: TooltipPage }) },
      },
      {
        path: 'review',
        element: <ReviewPage />,
        loader: reviewRoute,
        handle: { preload: loadReviewPage },
      },
      { path: 'compendium/review', element: <RetiredCompendiumRoute /> },
      { path: 'compendium', element: <CompendiumRoute /> },
      { path: 'archive', element: <ArchivePage />, handle: { preload: loadArchivePage } },
      { path: 'drift', element: <DriftPage />, handle: { preload: loadDriftPage } },
      { path: 'lost-text', element: <LostTextPage /> },
      {
        path: 'sandbox-perks',
        element: <SandboxPerksPage />,
        handle: { preload: loadSandboxPerksPage },
      },
      {
        path: 'translations',
        element: <TranslationsPage />,
        handle: { preload: loadTranslationsPage },
      },
      ...globalRoutes,
      { path: 'management', element: <AdminPage />, handle: { preload: loadAdminPage } },
      { path: 'management/ui', element: <GalleryPage /> },
      { path: 'exports', element: <ExportsPage /> },
      { path: 'exports/:project', element: <ExportProjectPage /> },
      { path: 'tooltips', element: <PublishedTooltipsPage /> },
      { path: 'settings', element: <SettingsRedirect /> },
      {
        path: '*',
        element: (
          <PlaceholderPage title="Page not found">
            Choose a page from the navigation to continue.
          </PlaceholderPage>
        ),
      },
    ],
  },
];

/** The routes as an element, for rendering inside an existing data router (tests, fixtures). */
export function App() {
  return useRoutes(routes);
}

/** The old sample and guidance pages are gone; their links land on the Compendium tab, keeping `hash`. */
function RetiredCompendiumRoute() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const next = new URLSearchParams();
  if (params.get('hash')) next.set('hash', params.get('hash')!);
  // Old category links named `catalog:<id>`; the tab names the bare category id.
  const group = params.get('group')?.replace(/^catalog:/, '');
  if (group) next.set('group', decodeURIComponent(group));
  const search = next.toString();
  return <Navigate to={{ pathname: '/compendium', search: search ? `?${search}` : '' }} replace />;
}

function CompendiumRoute() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  return (
    <LazyCompendiumTab
      shape={params.has('hash') || params.get('tab') === 'linked' ? 'page' : 'none'}
    />
  );
}

function StartPage() {
  const data = useDataStore((state) => state.data);
  const { user, loading } = useAuthStore();
  const loadingSkeleton = useSkeletonVisible(loading, 'Loading your workspace...', true);
  if (loading || loadingSkeleton)
    return (
      <LoadingSkeleton label="Loading your workspace..." shape="page" visible={loadingSkeleton} />
    );
  if (user?.role === 'translator') return <Navigate to="/translations" replace />;
  // Export partners land on their project (spec section 8).
  if (!user?.role && user?.projects?.length) return <Navigate to="/exports" replace />;
  const first = data && navigationGroups(data, '')[0]?.sections[0]?.items[0];
  return first ? <Navigate to={`/t/${first.hash}`} replace /> : <p>No tooltips available.</p>;
}
