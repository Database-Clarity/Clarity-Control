import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App';
import './ui/global.scss';
import { startPublisher } from './features/review/publisher';

// Resumes stored publish operations on any page; does nothing unless VITE_PUBLISHER_ENABLED=1.
startPublisher();

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
