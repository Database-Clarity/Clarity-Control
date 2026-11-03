import React from 'react';
import ReactDOM from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import { routes } from './App';
import './ui/global.scss';
import { useSettingsStore } from './stores/settings';
import { watchSystemTheme } from './ui/theme';

// The theme is already applied (index.html, then the settings store); this only follows the OS.
watchSystemTheme(() => useSettingsStore.getState().device.theme);

// A data router: the preview leave guard needs `useBlocker`, which the declarative router lacks.
const router = createHashRouter(routes);

const root = document.getElementById('root');

if (!root) {
  throw new Error('The application root element is missing.');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
