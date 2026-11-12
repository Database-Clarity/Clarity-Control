// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { SaveSummary } from './SaveSummary';
import { editorData, tooltip } from './fixtures.testSupport';
import { skeletonMinimumMs } from '../../ui/Skeleton';

it('finishes a large summary across frames, and cancels scheduled work on close', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const frame = async () => {
    const batch = [...frames.values()];
    frames.clear();
    await act(async () => batch.forEach((callback) => callback(0)));
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  const changes = Array.from({ length: 100 }, (_, hash) => ({
    hash,
    base: { ...tooltip, hash },
    next: { ...tooltip, hash, associated: [hash + 100] },
  }));
  const render = (rows = changes) =>
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(SaveSummary, { changes: rows, issues: [], data: editorData() }),
      ),
    );
  try {
    await act(async () => render());
    expect(host.querySelectorAll('a')).toHaveLength(10);
    expect(host.textContent).toContain('Preparing save summary...');
    while (frames.size) await frame();
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs));
    await frame(); // End the completed skeleton cycle before starting another summary.
    expect(host.querySelectorAll('a')).toHaveLength(100);
    expect(host.textContent).not.toContain('Preparing save summary...');
    await act(async () => render([...changes]));
    expect(host.querySelectorAll('a')).toHaveLength(10);
    // Summary batching and the skeleton's reveal grace each have one callback.
    expect(frames.size).toBe(2);
  } finally {
    await act(async () => root.unmount());
    expect(host.childElementCount).toBe(0);
    // Summary/reveal work is cancelled; only the required cycle-end frame remains.
    expect(frames.size).toBe(1);
    await frame();
    expect(frames.size).toBe(0);
    expect(host.childElementCount).toBe(0);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
