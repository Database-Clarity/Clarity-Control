import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminPage } from './features/admin/AdminPage';
import { LazyMatchReviewPage as MatchReviewPage } from './features/compendium/LazyMatchReviewPage';
import { TooltipPage } from './features/tooltip/TooltipPage';
import { useDataStore } from './stores/data';
import { navigationGroups } from './features/navigation/catalog';
import { AuthCallback } from './features/auth/AuthCallback';
import { GlobalDetailPage, GlobalsPage } from './features/globals/GlobalsPage';
import { Layout } from './features/navigation/Layout';
import { ReviewPage } from './features/review/ReviewPage';
import { LostTextPage } from './features/lost-text/LostTextPage';
import { SettingsRedirect } from './features/settings/SettingsRedirect';
import { ArchivePage } from './features/archive/ArchivePage';
import { DriftPage } from './features/drift/DriftPage';
import { TranslationsPage } from './features/translations/TranslationsPage';
import { PlaceholderPage } from './ui/PlaceholderPage';
import { useAuthStore } from './stores/auth';

export function App() {
  return (
    <Routes>
      <Route path="auth/callback" element={<AuthCallback />} />
      <Route element={<Layout />}>
        <Route index element={<StartPage />} />
        <Route path="t/:hash" element={<TooltipPage />} />
        <Route path="review" element={<ReviewPage />} />
        <Route path="compendium/review" element={<MatchReviewPage />} />
        <Route path="compendium" element={<MatchReviewPage />} />
        <Route path="archive" element={<ArchivePage />} />
        <Route path="drift" element={<DriftPage />} />
        <Route path="lost-text" element={<LostTextPage />} />
        <Route path="translations" element={<TranslationsPage />} />
        <Route path="globals" element={<GlobalsPage />} />
        <Route path="globals/:kind/:name" element={<GlobalDetailPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="settings" element={<SettingsRedirect />} />
        <Route
          path="*"
          element={
            <PlaceholderPage title="Page not found">
              Choose a page from the navigation to continue.
            </PlaceholderPage>
          }
        />
      </Route>
    </Routes>
  );
}

function StartPage() {
  const data = useDataStore((state) => state.data);
  const { user, loading } = useAuthStore();
  if (loading) return <p role="status">Loading your workspace...</p>;
  if (user?.role === 'translator') return <Navigate to="/translations" replace />;
  const first = data && navigationGroups(data, '')[0]?.sections[0]?.items[0];
  return first ? <Navigate to={`/t/${first.hash}`} replace /> : <p>No tooltips available.</p>;
}
