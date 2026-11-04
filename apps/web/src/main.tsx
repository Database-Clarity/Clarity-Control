import React from 'react';
import ReactDOM from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import './ui/global.scss';

// Keep vendor initialization and the application/data graph in separate tasks.
// Every entry route follows the same bootstrap; facts resolve before sync consumers run.
const { routes } = await import('./App');
const [{ startPublisher }, { useSettingsStore }, { watchSystemTheme }] = await Promise.all([
  import('./features/review/publisher'),
  import('./stores/settings'),
  import('./ui/theme'),
]);

// Resumes stored publish operations on any page; does nothing unless VITE_PUBLISHER_ENABLED=1.
startPublisher();

// The theme is already applied (index.html, then the settings store); this only follows the OS.
watchSystemTheme(() => useSettingsStore.getState().device.theme);

// A data router: the preview leave guard needs `useBlocker`, which the declarative router lacks.
const router = createHashRouter(routes);

// Fetch the selected route alongside workspace data, even while Layout shows its
// loading state. This applies to the actual destination, independent of navigation order.
for (const match of router.state.matches) {
  const preload = match.route.handle?.preload as (() => Promise<unknown>) | undefined;
  void preload?.().catch(() => {
    /* The route's retry boundary reports a failed import. */
  });
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('The application root element is missing.');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
