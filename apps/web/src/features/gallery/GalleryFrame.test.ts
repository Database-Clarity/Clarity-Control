import { describe, expect, it } from 'vitest';
import { isolateStorage } from './GalleryFrame';

/** A Map-backed Storage (Node and jsdom here expose no usable window storage). */
function storage(entries: Record<string, string>): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
  };
}

describe('isolateStorage', () => {
  it('reads the real storage but never writes it (demo toggles stay in the frame)', () => {
    const real = storage({
      'clarity-diff-raw:v1': 'false',
      'clarity-settings:device:v1': '{"remembered":{"compendiumSurface":"sheet"}}',
    });
    const session = storage({ 'clarity-editor-session': 'token' });
    const win = { localStorage: real, sessionStorage: session } as unknown as Window;
    isolateStorage(win);
    expect(win.localStorage).not.toBe(real);
    expect(win.localStorage.getItem('clarity-diff-raw:v1')).toBe('false');
    expect(win.sessionStorage.getItem('clarity-editor-session')).toBe('token');
    win.localStorage.setItem('clarity-diff-raw:v1', 'true');
    win.localStorage.setItem(
      'clarity-settings:device:v1',
      '{"remembered":{"compendiumSurface":"editor"}}',
    );
    win.sessionStorage.removeItem('clarity-editor-session');
    expect(win.localStorage.getItem('clarity-diff-raw:v1')).toBe('true');
    expect(real.getItem('clarity-diff-raw:v1')).toBe('false');
    expect(real.getItem('clarity-settings:device:v1')).toContain('"sheet"');
    expect(session.getItem('clarity-editor-session')).toBe('token');
    // A second call keeps the same copy.
    const copy = win.localStorage;
    isolateStorage(win);
    expect(win.localStorage).toBe(copy);
  });
});
