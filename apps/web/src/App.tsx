import { Navigate, useRoutes, type RouteObject } from 'react-router-dom';
import { LazyMatchReviewPage as MatchReviewPage } from './features/compendium/LazyMatchReviewPage';
import { useDataStore } from './stores/data';
import { navigationGroups } from './features/navigation/catalog';
import { AuthCallback } from './features/auth/AuthCallback';
import { Layout } from './features/navigation/Layout';
import { LazyLostTextPage as LostTextPage } from './features/lost-text/LazyLostTextPage';
import { SettingsRedirect } from './features/settings/SettingsRedirect';
import { PlaceholderPage } from './ui/PlaceholderPage';
import { useAuthStore } from './stores/auth';
import { useEffect } from 'react';
import { visibleLinks } from './features/navigation/links';
import { preloadWorkspaces } from './workspacePreload';
import { reviewRoute } from './features/review/route';

import { AppLazyPage } from './AppLazyPage';
const loadTooltipPage = () =>
  import('./features/tooltip/TooltipPage').then((module) => ({ default: module.TooltipPage }));
const TooltipPage = () => <AppLazyPage load={loadTooltipPage} />;
const loadTranslationsPage = () =>
  import('./features/translations/TranslationsPage').then((module) => ({
    default: module.TranslationsPage,
  }));
const TranslationsPage = () => <AppLazyPage load={loadTranslationsPage} />;
const loadArchivePage = () =>
  import('./features/archive/ArchivePage').then((module) => ({ default: module.ArchivePage }));
const ArchivePage = () => <AppLazyPage load={loadArchivePage} />;
const loadDriftPage = () =>
  import('./features/drift/DriftPage').then((module) => ({ default: module.DriftPage }));
const DriftPage = () => <AppLazyPage load={loadDriftPage} />;
const loadReviewPage = () =>
  import('./features/review/ReviewPage').then((module) => ({ default: module.ReviewPage }));
const ReviewPage = () => <AppLazyPage load={loadReviewPage} />;
const loadAdminPage = () =>
  import('./features/admin/AdminPage').then((module) => ({ default: module.AdminPage }));
const AdminPage = () => <AppLazyPage load={loadAdminPage} />;
const workspaceLoaders: Record<string, () => Promise<unknown>> = {
  '/': loadTooltipPage,
  '/review': loadReviewPage,
  '/compendium': () => import('./features/compendium/MatchReviewPage'),
  '/translations': loadTranslationsPage,
  '/drift': loadDriftPage,
  '/lost-text': () => import('./features/lost-text/LostTextPage'),
  '/archive': loadArchivePage,
  '/admin': loadAdminPage,
};

function WorkspaceRouteLayer() {
  const role = useAuthStore((state) => state.user?.role);
  const loading = useAuthStore((state) => state.loading);
  const ready = useDataStore((state) => state.status === 'ready');
  useEffect(() => {
    if (!ready || loading) return;
    return preloadWorkspaces(
      visibleLinks(role ? { role } : null)
        .map(({ to }) => workspaceLoaders[to])
        .filter((load) => load !== undefined),
    );
  }, [role, ready, loading]);
  return <Layout />;
}
const loadGlobalDetailPage = () =>
  import('./features/globals/GlobalsPage').then((module) => ({ default: module.GlobalDetailPage }));
const GlobalDetailPage = () => <AppLazyPage load={loadGlobalDetailPage} />;
const loadGlobalsPage = () =>
  import('./features/globals/GlobalsPage').then((module) => ({ default: module.GlobalsPage }));
const GlobalsPage = () => <AppLazyPage load={loadGlobalsPage} />;

/**
 * Every route in one place, as plain objects: main.tsx hands them to createHashRouter (a data
 * router, which the leave guard's useBlocker needs) and tests hand them to createMemoryRouter.
 * Paths, the index route, the auth callback outside the Layout and the catch-all are unchanged.
 */
export const routes: RouteObject[] = [
  { path: 'auth/callback', element: <AuthCallback /> },
  {
    element: <WorkspaceRouteLayer />,
    children: [
      { index: true, element: <StartPage /> },
      { path: 't/:hash', element: <TooltipPage />, handle: { preload: loadTooltipPage } },
      {
        path: 'review',
        element: <ReviewPage />,
        loader: reviewRoute,
        handle: { preload: loadReviewPage },
      },
      { path: 'compendium/review', element: <MatchReviewPage /> },
      { path: 'compendium', element: <MatchReviewPage /> },
      { path: 'archive', element: <ArchivePage />, handle: { preload: loadArchivePage } },
      { path: 'drift', element: <DriftPage />, handle: { preload: loadDriftPage } },
      { path: 'lost-text', element: <LostTextPage /> },
      {
        path: 'translations',
        element: <TranslationsPage />,
        handle: { preload: loadTranslationsPage },
      },
      { path: 'globals', element: <GlobalsPage />, handle: { preload: loadGlobalsPage } },
      {
        path: 'globals/:kind/:name',
        element: <GlobalDetailPage />,
        handle: { preload: loadGlobalDetailPage },
      },
      { path: 'admin', element: <AdminPage />, handle: { preload: loadAdminPage } },
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

function StartPage() {
  const data = useDataStore((state) => state.data);
  const { user, loading } = useAuthStore();
  if (loading) return <p role="status">Loading your workspace...</p>;
  if (user?.role === 'translator') return <Navigate to="/translations" replace />;
  const first = data && navigationGroups(data, '')[0]?.sections[0]?.items[0];
  return first ? <Navigate to={`/t/${first.hash}`} replace /> : <p>No tooltips available.</p>;
}
