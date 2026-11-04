import { Navigate, useRoutes, type RouteObject } from 'react-router-dom';
import { AdminPage } from './features/admin/AdminPage';
import { LazyMatchReviewPage as MatchReviewPage } from './features/compendium/LazyMatchReviewPage';
import { TooltipPage } from './features/tooltip/TooltipPage';
import { useDataStore } from './stores/data';
import { navigationGroups } from './features/navigation/catalog';
import { AuthCallback } from './features/auth/AuthCallback';
import { GlobalDetailPage, GlobalsPage } from './features/globals/GlobalsPage';
import { Layout } from './features/navigation/Layout';
import { ReviewPage } from './features/review/ReviewPage';
import { LazyLostTextPage as LostTextPage } from './features/lost-text/LazyLostTextPage';
import { SettingsRedirect } from './features/settings/SettingsRedirect';
import { ArchivePage } from './features/archive/ArchivePage';
import { DriftPage } from './features/drift/DriftPage';
import { TranslationsPage } from './features/translations/TranslationsPage';
import { PlaceholderPage } from './ui/PlaceholderPage';
import { useAuthStore } from './stores/auth';

/**
 * Every route in one place, as plain objects: main.tsx hands them to createHashRouter (a data
 * router, which the leave guard's useBlocker needs) and tests hand them to createMemoryRouter.
 * Paths, the index route, the auth callback outside the Layout and the catch-all are unchanged.
 */
export const routes: RouteObject[] = [
  { path: 'auth/callback', element: <AuthCallback /> },
  {
    element: <Layout />,
    children: [
      { index: true, element: <StartPage /> },
      { path: 't/:hash', element: <TooltipPage /> },
      { path: 'review', element: <ReviewPage /> },
      { path: 'compendium/review', element: <MatchReviewPage /> },
      { path: 'compendium', element: <MatchReviewPage /> },
      { path: 'archive', element: <ArchivePage /> },
      { path: 'drift', element: <DriftPage /> },
      { path: 'lost-text', element: <LostTextPage /> },
      { path: 'translations', element: <TranslationsPage /> },
      { path: 'globals', element: <GlobalsPage /> },
      { path: 'globals/:kind/:name', element: <GlobalDetailPage /> },
      { path: 'admin', element: <AdminPage /> },
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
