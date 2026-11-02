import { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useSettingsPanel } from './panel';

/**
 * The only place /settings is special: it opens the popover over the previous page and replaces
 * its own URL, so the address bar and Back never keep it. To make /settings a full page again
 * (e.g. a "View all settings" link from the popover), point that route in App.tsx at a page that
 * renders <SettingsContent /> instead of this component.
 */
export function SettingsRedirect() {
  const returnTo = useSettingsPanel((state) => state.returnTo);
  useEffect(() => useSettingsPanel.getState().show(), []);
  return <Navigate to={returnTo} replace />;
}

/** Remembers the last real page, which /settings is replaced with. Rendered once by the layout. */
export function RememberRoute() {
  const { pathname, search } = useLocation();
  useEffect(() => {
    if (pathname !== '/settings') useSettingsPanel.getState().remember(`${pathname}${search}`);
  }, [pathname, search]);
  return null;
}
