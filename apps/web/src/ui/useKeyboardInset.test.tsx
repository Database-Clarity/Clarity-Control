// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackKeyboardInset, useKeyboardInset } from './useKeyboardInset';

const web = join(__dirname, '../..');
const src = join(web, 'src');

class FakeViewport extends EventTarget {
  height = 772;
  offsetTop = 0;
  scale = 1;
}

let viewport: FakeViewport;
let frames: FrameRequestCallback[] = [];
let touch: boolean;
const touchListeners = new Set<() => void>();
let host: HTMLDivElement;
let root: Root;

function flushFrames() {
  const pending = frames;
  frames = [];
  act(() => pending.forEach((callback) => callback(0)));
}

function resize(height: number, offsetTop = 0) {
  viewport.height = height;
  viewport.offsetTop = offsetTop;
  act(() => viewport.dispatchEvent(new Event('resize')));
  flushFrames();
}

const style = () => document.documentElement.style;

beforeEach(() => {
  touch = true;
  vi.stubGlobal('innerHeight', 772);
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return touch && /max-width: 700px|pointer: coarse/.test(query);
    },
    media: query,
    addEventListener: (_: string, listener: () => void) => touchListeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => touchListeners.delete(listener),
  }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  viewport = new FakeViewport();
  vi.stubGlobal('visualViewport', viewport);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  frames = [];
  touchListeners.clear();
  style().removeProperty('--kb-inset');
  style().removeProperty('--kb-room');
  vi.unstubAllGlobals();
});

describe('the page keyboard mode (Gboard cursor swipe in Vivaldi)', () => {
  it('leaves the browser default: no interactive-widget in the viewport meta', () => {
    // resizes-content broke Gboard's space-bar cursor swipe and backspace swipe-select on every
    // field of the site in Vivaldi for Android (2026-11-12); the page fits the keyboard itself.
    const html = readFileSync(join(web, 'index.html'), 'utf8');
    const viewportMeta = html.match(/<meta\s+name="viewport"[^>]*>/)?.[0] ?? '';
    expect(viewportMeta).toContain('width=device-width');
    expect(viewportMeta).not.toMatch(/interactive-widget/);
  });

  it('sizes nothing from a raw viewport height that the keyboard would cover', () => {
    // With the layout viewport no longer shrinking for the keyboard, a height or max-height in dvh
    // would run under it on Android: they read --app-h (ui/global.scss) instead. min-height is fine.
    const allowed = new Set([
      'ui/global.scss', // --app-h itself
      'features/editor/StatusBar.module.scss', // fallback of --visible-h, the visual viewport
    ]);
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.scss')) {
          const file = relative(src, path).replaceAll('\\', '/');
          readFileSync(path, 'utf8')
            .split('\n')
            .forEach((line, index) => {
              if (!/\d+dvh/.test(line) || /^\s*min-height:/.test(line)) return;
              if (allowed.has(file) || allowed.has(`${file}:${index + 1}`)) return;
              found.push(`${file}:${index + 1}: ${line.trim()}`);
            });
        }
      }
    };
    walk(src);
    expect(found).toEqual([]);
  });

  it('centres every modal dialog in what the keyboard leaves of the window', () => {
    // A modal <dialog> centres in the layout viewport, which no longer shrinks for the keyboard:
    // each one's stylesheet lifts its bottom edge by --kb-lift (tablets; phones fill the height).
    const modal: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx$/.test(name) && !name.includes('.test.')) {
          const code = readFileSync(path, 'utf8');
          if (!/\.showModal\(\)/.test(code)) continue;
          const sheet = code.match(/import \w+ from '(\.\/[\w.]+\.module\.scss)'/)?.[1];
          modal.push(relative(src, path).replaceAll('\\', '/'));
          expect(sheet, path).toBeDefined();
          expect(readFileSync(join(dir, sheet!), 'utf8'), path).toMatch(/bottom: var\(--kb-lift\)/);
        }
      }
    };
    walk(src);
    expect(modal.sort()).toEqual(['features/compendium/PickerStage.tsx', 'ui/Dialog.tsx']);
  });
});

describe('trackKeyboardInset', () => {
  it('keeps the keyboard variables on every page of a touch device', () => {
    const stop = trackKeyboardInset();
    flushFrames();
    expect(style().getPropertyValue('--kb-room')).toBe('0px');
    // The keyboard shrinks only the visual viewport.
    resize(472);
    expect(style().getPropertyValue('--kb-room')).toBe('300px');
    expect(style().getPropertyValue('--kb-inset')).toBe('300px');
    stop();
    expect(style().getPropertyValue('--kb-room')).toBe('');
  });

  it('writes nothing on a desktop, and starts when the device turns touch', () => {
    touch = false;
    const stop = trackKeyboardInset();
    flushFrames();
    expect(style().getPropertyValue('--kb-room')).toBe('');
    touch = true;
    touchListeners.forEach((listener) => listener());
    resize(500);
    expect(style().getPropertyValue('--kb-room')).toBe('272px');
    touch = false;
    touchListeners.forEach((listener) => listener());
    expect(style().getPropertyValue('--kb-room')).toBe('');
    stop();
  });

  it('shares one writer with the docked bar: the bar leaving does not clear the page variables', () => {
    const stop = trackKeyboardInset();
    function Bar() {
      useKeyboardInset(true);
      return null;
    }
    act(() => root.render(<Bar />));
    resize(472);
    act(() => root.render(null));
    expect(style().getPropertyValue('--kb-room')).toBe('300px');
    resize(772);
    expect(style().getPropertyValue('--kb-room')).toBe('0px');
    stop();
    expect(style().getPropertyValue('--kb-room')).toBe('');
  });

  it('never changes the page height for a pinch zoom, only for the keyboard', () => {
    const stop = trackKeyboardInset();
    flushFrames();
    // Zoomed 2x, no keyboard: the visible area is half the window in CSS pixels.
    viewport.scale = 2;
    resize(386, 200);
    expect(style().getPropertyValue('--kb-room')).toBe('0px');
    // Zoomed 2x with a 300px keyboard.
    resize(236, 200);
    expect(style().getPropertyValue('--kb-room')).toBe('300px');
    stop();
  });
});
