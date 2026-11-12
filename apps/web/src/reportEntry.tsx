import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { useEffect } from 'react';
import ReportPublicPage from './features/reports/public/ReportPublicPage';
import { reportAppearance } from './features/reports/public/appearance';
import './ui/global.scss';

reportAppearance();
function EnterEditor() {
  useEffect(() => location.reload(), []);
  return null;
}
const root = document.getElementById('root');
if (!root) throw new Error('The application root element is missing.');
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <HashRouter>
      <Routes>
        <Route path="/report/*" element={<ReportPublicPage />} />
        <Route path="*" element={<EnterEditor />} />
      </Routes>
    </HashRouter>
  </React.StrictMode>,
);
