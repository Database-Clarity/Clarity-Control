import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App';
import './ui/global.scss';
import { useSettingsStore } from './stores/settings';
import { watchSystemTheme } from './ui/theme';

// The theme is already applied (index.html, then the settings store); this only follows the OS.
watchSystemTheme(() => useSettingsStore.getState().device.theme);

const root = document.getElementById('root');

if (!root) {
  throw new Error('The application root element is missing.');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
