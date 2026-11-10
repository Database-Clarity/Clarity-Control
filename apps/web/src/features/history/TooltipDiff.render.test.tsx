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

it('names where each Compendium snapshot came from in the sheet, never by raw gid', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  const root = createRoot(host);
  const stamp = { updatedAt: '2026-11-04T00:00:00Z', updatedBy: 'test' };
  const link = (plain: string, extra: object) => ({
    gid: '1662574278',
    rowKey: 'Rampage',
    section: 'Weapon Traits',
    snapshot: { plain, runs: [{ text: plain }] },
    snapshotAt: '2026-11-01T00:00:00.000Z',
    ...extra,
  });
  const tooltip = { hash: 1, associated: [], text: { en: { text: 'Same', ...stamp } } };
  try {
    await act(async () =>
      root.render(
        <TooltipDiff
          raw={false}
          before={{ ...tooltip, compendium: link('Old', {}) }}
          current={{
            ...tooltip,
            compendium: link('New', {
              sourceAnchor: { row: 174, col: 0 },
              cells: [
                { dRow: 0, dCol: 0 },
                { dRow: 0, dCol: 2 },
              ],
            }),
          }}
        />,
      ),
    );
    const refs = [...host.querySelectorAll('[data-source-ref]')];
    expect(refs.map((a) => a.textContent!.split(String.fromCharCode(160)).join(' '))).toEqual([
      expect.stringContaining('Sheet tab · Weapon Traits · position unknown'),
      expect.stringContaining('Sheet tab · Weapon Traits · A174, C174'),
    ]);
    expect(refs[1].getAttribute('href')).toContain('gid=1662574278&range=A174');
    expect(host.textContent).not.toContain('1662574278');
  } finally {
    await act(async () => root.unmount());
  }
});

it('shows a Compendium link that moved even when its snapshot text is unchanged', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  const root = createRoot(host);
  const stamp = { updatedAt: '2026-11-04T00:00:00Z', updatedBy: 'test' };
  const snapshot = { plain: 'Same', runs: [{ text: 'Same' }] };
  const link = (gid: string) => ({
    gid,
    rowKey: 'Rampage',
    snapshot,
    snapshotAt: '2026-11-01T00:00:00.000Z',
    sourceAnchor: { row: 5, col: 0 },
    cells: [{ dRow: 0, dCol: 2 }],
  });
  const tooltip = { hash: 1, associated: [], text: { en: { text: 'Same', ...stamp } } };
  try {
    await act(async () =>
      root.render(
        <TooltipDiff
          raw={false}
          before={{ ...tooltip, compendium: link('77') }}
          current={{ ...tooltip, compendium: link('88') }}
        />,
      ),
    );
    // Same label without the source loaded ("Sheet tab · C5"), but two different places.
    const refs = [...host.querySelectorAll('[data-source-ref]')];
    expect(refs.map((a) => a.getAttribute('href')!.split('#')[1])).toEqual([
      'gid=77&range=C5',
      'gid=88&range=C5',
    ]);
  } finally {
    await act(async () => root.unmount());
  }
});
