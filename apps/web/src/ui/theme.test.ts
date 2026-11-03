// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, resolveTheme, systemTheme, themeColors, watchSystemTheme } from './theme';

function mockMatchMedia(light: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: light,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => query });
  return {
    listeners,
    set(next: boolean) {
      query.matches = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { matchMedia?: unknown }).matchMedia;
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = '';
  document.head.innerHTML = '';
});

const chrome = () => document.querySelector('meta[name="theme-color"]')?.getAttribute('content');

describe('theme', () => {
  it('resolves system from the OS and lets an explicit choice win', () => {
    expect(resolveTheme('system', 'light')).toBe('light');
    expect(resolveTheme('system', 'dark')).toBe('dark');
    expect(resolveTheme('light', 'dark')).toBe('light');
    expect(resolveTheme('dark', 'light')).toBe('dark');
  });

  it('falls back to the dark app default without matchMedia', () => {
    expect(systemTheme()).toBe('dark');
  });

  it('applies data-theme, color-scheme and the browser chrome colour', () => {
    document.head.innerHTML = '<meta name="theme-color" content="#000">';
    mockMatchMedia(true);
    expect(applyTheme('system')).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(chrome()).toBe(themeColors.light);
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(chrome()).toBe(themeColors.dark);
  });

  it('follows live system changes only while the preference is system, and cleans up', () => {
    const media = mockMatchMedia(false);
    let preference: 'system' | 'light' | 'dark' = 'system';
    const stop = watchSystemTheme(() => preference);
    expect(media.listeners.size).toBe(1);
    applyTheme('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
    media.set(true);
    expect(document.documentElement.dataset.theme).toBe('light');
    preference = 'dark';
    applyTheme('dark');
    media.set(false);
    media.set(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    stop();
    expect(media.listeners.size).toBe(0);
  });

  it('does nothing when matchMedia is unavailable', () => {
    expect(() => watchSystemTheme(() => 'system')()).not.toThrow();
  });
});
