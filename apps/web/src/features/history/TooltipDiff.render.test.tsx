// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TooltipDiff } from './TooltipDiff';

it('finishes every language without leaving offscreen text hidden', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const frames: FrameRequestCallback[] = [];
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const host = document.createElement('div');
  const root = createRoot(host);
  const stamp = { updatedAt: '2026-11-04T00:00:00Z', updatedBy: 'test' };
  try {
    await act(async () =>
      root.render(
        <TooltipDiff
          before={null}
          raw={false}
          current={{
            hash: 1,
            associated: [],
            text: {
              en: { text: 'English comparison', ...stamp },
              ko: { text: '한국어 비교', ...stamp },
              'zh-chs': { text: '中文比较', ...stamp },
            },
          }}
        />,
      ),
    );
    expect(host.textContent).toContain('한국어 비교');
    expect(host.textContent).toContain('中文比较');
    expect(host.querySelectorAll('[data-pending-render]')).toHaveLength(2);
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => {
      frames.shift()!(0);
      vi.runOnlyPendingTimers();
    });
    expect(host.querySelectorAll('[data-pending-render]')).toHaveLength(1);
    await act(async () => {
      frames.shift()!(0);
      vi.runOnlyPendingTimers();
    });
    expect(host.querySelector('[data-pending-render]')).toBeNull();
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(host.textContent).toContain('한국어 비교');
    expect(host.textContent).toContain('中文比较');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
