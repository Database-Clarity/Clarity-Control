// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TooltipDiff } from './TooltipDiff';

it('defaults to rendered, synchronizes switches, and remembers Raw across remounts', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    clear: () => storage.clear(),
  });
  localStorage.clear();
  const host = document.createElement('div'),
    root = createRoot(host);
  const tooltip = (text: string) => ({
    hash: 10,
    associated: [],
    text: { en: { text, updatedBy: 'test', updatedAt: '2026-11-11' } },
  });
  const diff = <TooltipDiff before={tooltip('<pve Old />')} current={tooltip('<pvp New />')} />;
  try {
    await act(async () =>
      root.render(
        <>
          {diff}
          {diff}
        </>,
      ),
    );
    expect(host.querySelector('pre')).toBeNull();
    expect(host.querySelector('del')?.textContent).toBe('Old');
    const switches = host.querySelectorAll<HTMLInputElement>('[role="switch"]');
    expect(switches[0].checked).toBe(false);
    await act(async () => switches[0].click());
    expect(switches[1].checked).toBe(true);
    expect(host.querySelector('pre')?.textContent).toBe('<pve Old />');
    await act(async () => root.render(null));
    await act(async () => root.render(diff));
    expect(host.querySelector<HTMLInputElement>('[role="switch"]')?.checked).toBe(true);
    await act(async () => host.querySelector<HTMLInputElement>('[role="switch"]')!.click());
    expect(host.querySelector('pre')).toBeNull();
    expect(host.querySelector('ins')?.textContent).toBe('New');
    vi.stubGlobal('localStorage', {
      getItem: () => 'false',
      setItem: () => {
        throw new Error('quota');
      },
      clear: () => {},
    });
    await act(async () => host.querySelector<HTMLInputElement>('[role="switch"]')!.click());
    expect(host.querySelector<HTMLInputElement>('[role="switch"]')?.checked).toBe(true);
    expect(host.querySelector('pre')?.textContent).toBe('<pve Old />');
    await act(async () => host.querySelector<HTMLInputElement>('[role="switch"]')!.click());
  } finally {
    await act(async () => root.unmount());
    localStorage.clear();
    vi.unstubAllGlobals();
  }
});
