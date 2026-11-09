/*
 * Device theme: `system` (default) follows the OS, `light` and `dark` override it.
 *
 * The resolved theme lives on <html data-theme="light|dark"> (the CSS token sets key off it) and
 * as `color-scheme`. index.html runs the same resolution inline before first paint, so a reload
 * never flashes the wrong theme; keep the two in step.
 */
export const themePreferences = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof themePreferences)[number];
export type ResolvedTheme = 'light' | 'dark';

/** Chrome colour per theme; also the browser's address-bar colour on phones. */
export const themeColors: Record<ResolvedTheme, string> = { dark: '#1d2024', light: '#c3d3df' };

const lightQuery = '(prefers-color-scheme: light)';

/** Without a usable media query (old browsers, tests) the app's own default, dark, applies. */
export function systemTheme(): ResolvedTheme {
  try {
    return typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(lightQuery).matches
      ? 'light'
      : 'dark';
  } catch {
    return 'dark';
  }
}

export function resolveTheme(
  preference: ThemePreference,
  system: ResolvedTheme = systemTheme(),
): ResolvedTheme {
  return preference === 'system' ? system : preference;
}

/** Applies the preference to the document; safe to call repeatedly and without a DOM. */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const theme = resolveTheme(preference);
  if (typeof document === 'undefined') return theme;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColors[theme]);
  return theme;
}

/**
 * Re-applies the theme when the OS preference changes. Call once at start-up (main.tsx); returns
 * the cleanup. Nothing subscribes at import time, so stores and tests stay listener-free.
 */
export function watchSystemTheme(getPreference: () => ThemePreference): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(lightQuery);
  const onChange = () => {
    if (getPreference() === 'system') applyTheme('system');
  };
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
