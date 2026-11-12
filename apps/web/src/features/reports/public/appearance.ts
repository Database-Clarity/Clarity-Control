import { appliedUiScale } from '../../../ui/uiScale';
import { applyTheme, watchSystemTheme, type ThemePreference } from '../../../ui/theme';
/** Public routes need device appearance, not the editor's synced settings machinery. */
export function reportAppearance() {
  let theme: ThemePreference = 'system';
  let scale = 100;
  let touch = 'compact';
  try {
    const stored = JSON.parse(localStorage.getItem('clarity-settings:device:v1') ?? '{}');
    if (stored?.theme === 'light' || stored?.theme === 'dark') theme = stored.theme;
    const value = stored?.uiScale ?? (stored?.textSize === 'large' ? 115 : 100);
    if (typeof value === 'number' && Number.isFinite(value))
      scale = Math.min(150, Math.max(85, Math.round(value)));
    if (stored?.touchSize === 'large') touch = 'large';
  } catch {
    /* Optional storage. */
  }
  const resize = () => {
    const applied = appliedUiScale(scale, innerWidth || 1280);
    document.documentElement.style.fontSize = applied === 100 ? '' : `${applied}%`;
    document.documentElement.dataset.uiScale = String(applied);
    window.dispatchEvent(new Event('clarity-ui-scale'));
  };
  applyTheme(theme);
  document.documentElement.dataset.touch = touch;
  resize();
  window.addEventListener('resize', resize);
  watchSystemTheme(() => theme);
}
