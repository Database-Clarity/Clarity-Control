// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { SaveSummary } from './SaveSummary';
import { editorData, tooltip } from './fixtures.testSupport';

it('finishes a large summary across frames, and cancels scheduled work on close', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
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
    while (frames.size) {
      const [id, callback] = frames.entries().next().value!;
      frames.delete(id);
      await act(async () => callback(0));
    }
    expect(host.querySelectorAll('a')).toHaveLength(100);
    expect(host.textContent).not.toContain('Preparing save summary...');
    await act(async () => render([...changes]));
    expect(host.querySelectorAll('a')).toHaveLength(10);
    expect(frames.size).toBe(1);
  } finally {
    await act(async () => root.unmount());
    expect(frames.size).toBe(0);
    vi.unstubAllGlobals();
  }
});
