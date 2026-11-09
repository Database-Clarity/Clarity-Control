import React from 'react';
import ReactDOM from 'react-dom/client';
import { MovedPage } from './MovedPage';

const root = document.getElementById('root');
if (!root) throw new Error('The application root element is missing.');
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <MovedPage />
  </React.StrictMode>,
);
