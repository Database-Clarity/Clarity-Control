import React from 'react';
import ReactDOM from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import './ui/global.scss';

// "Moved" build of the old site (VITE_MOVED_MODE=1; off by default, so this block is removed from
// the normal build): shows the moved screen and never starts the editor.
if (import.meta.env.VITE_MOVED_MODE === '1') {
  await import('./features/migrate/movedEntry');
  await new Promise<never>(() => undefined);
}

// Keep vendor initialization and the application/data graph in separate tasks.
// Every entry route follows the same bootstrap; facts resolve before sync consumers run.
// Schema constructors account for most of the application graph's synchronous
// initialization. Evaluate a small schema entry first, then give input/paint a
// turn before evaluating the data schemas and their consumers (even on warm loads).
await import('../../../packages/core/src/languages');
await new Promise<void>((resolve) => setTimeout(resolve, 0));
// Separate the data schemas' own dependencies too: constructing all of them
// together can still exceed the task budget on a throttled, busy machine.
await import('../../../packages/core/src/legacy');
await new Promise<void>((resolve) => setTimeout(resolve, 0));
await import('../../../packages/core/src/compendium/types');
await new Promise<void>((resolve) => setTimeout(resolve, 0));
await import('../../../packages/core/src/schemas');
await new Promise<void>((resolve) => setTimeout(resolve, 0));
await import('../../../packages/core/src/settings');
await new Promise<void>((resolve) => setTimeout(resolve, 0));
await import('../../../packages/core/src/aliasGroups');
await new Promise<void>((resolve) => setTimeout(resolve, 0));
const { routes } = await import('./App');
const [{ startPublisher }, { useSettingsStore }, { watchSystemTheme }, { trackKeyboardInset }] =
  await Promise.all([
    import('./features/review/publisher'),
    import('./stores/settings'),
    import('./ui/theme'),
    import('./ui/useKeyboardInset'),
  ]);

// Resumes stored publish operations on any page; does nothing unless VITE_PUBLISHER_ENABLED=1.
startPublisher();

// The theme is already applied (index.html, then the settings store); this only follows the OS.
watchSystemTheme(() => useSettingsStore.getState().device.theme);

// A touch device's keyboard covers part of the page: sheets and lists fit above it (--app-h).
trackKeyboardInset();

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
