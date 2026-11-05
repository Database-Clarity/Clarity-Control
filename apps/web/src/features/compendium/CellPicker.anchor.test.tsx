// @vitest-environment jsdom
import { act, createElement, Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompendiumData } from '@clarity/core';
import { LinkPicker } from './LinkPicker';
import { useCompendiumStore } from './store';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.unstubAllGlobals());

it('keeps the Arc > Siphon row 11/column 2 replacement complete while ready stays true', () => {
  const cell = (plain: string) => ({ plain, runs: [{ text: plain }] });
  const source: CompendiumData = {
    fetchedAt: '2026-11-05T00:00:00Z',
    tabs: [
      {
        gid: '1934379638',
        name: 'Armor Mods',
        rows: [
          {
            name: 'Arc Targeting',
            nameNorm: 'arc targeting',
            rowIndex: 13,
            anchor: { row: 13, col: 1 },
            cell: cell('Arc description'),
          },
          {
            name: 'Siphon',
            nameNorm: 'siphon',
            rowIndex: 11,
            anchor: { row: 11, col: 1 },
            cell: cell('Siphon description'),
          },
        ],
        grid: Array.from({ length: 25 }, (_, index) =>
          Array.from({ length: 3 }, (_, col) => ({
            row: index + 1,
            col,
            cell: cell(
              col === 1 && index === 12
                ? 'Arc Targeting'
                : col === 1 && index === 10
                  ? 'Siphon'
                  : `Row ${index + 1}, column ${col + 1}`,
            ),
          })),
        ).flat(),
      },
    ],
  };
  const previous = useCompendiumStore.getState().data;
  useCompendiumStore.setState({ data: source });
  let resize: ResizeObserverCallback;
  const channels: { deliver(): void }[] = [];
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1: { onmessage: (() => void) | null; close(): void } = { onmessage: null, close() {} };
      port2 = { postMessage() {}, close() {} };
      constructor() {
        channels.push({ deliver: () => this.port1.onmessage?.() });
      }
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    onReference = vi.fn();
  let capture = false;
  const commits: { ready: string | undefined; complete: string | undefined; rows: number }[] = [];
  const record = () => {
    if (!capture) return;
    commits.push({
      ready: host.querySelector<HTMLElement>('[data-picker-ready]')?.dataset.pickerReady,
      complete: host.querySelector<HTMLElement>('[data-grid-complete]')?.dataset.gridComplete,
      rows: host.querySelectorAll('tr').length,
    });
  };
  try {
    act(() =>
      root.render(
        createElement(
          Profiler,
          { id: 'picker', onRender: record },
          createElement(LinkPicker, {
            base: { hash: 967052942, text: {}, associated: [] },
            name: 'Arc Targeting',
            category: 'armor-mod-general',
            retainPrevious: true,
            onLinked() {},
            onReference,
          }),
        ),
      ),
    );
    act(() => channels[0].deliver());
    const region = host.querySelector<HTMLElement>('[role="region"]')!;
    const body = region.firstElementChild!;
    const notify = (height: number) =>
      act(() =>
        resize!(
          [
            { target: body, contentRect: { height } },
            { target: region, contentRect: { height: 100 } },
          ] as ResizeObserverEntry[],
          {} as ResizeObserver,
        ),
      );
    notify(40);
    act(() => channels[1].deliver());
    notify(80);
    act(() => channels[1].deliver());
    notify(120);
    expect(host.querySelector<HTMLElement>('[data-picker-ready]')!.dataset.pickerReady).toBe(
      'true',
    );
    const oldCell = host.querySelector('button[data-row="5"][data-col="0"]');
    const input = host.querySelector<HTMLInputElement>(
      'section[aria-label="Pick description cells"] input',
    )!;
    act(() => {
      input.value = 'Siphon';
      Simulate.change(input);
    });
    const choice = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Use anchor at row 11, column 2:'),
    )!;
    expect(choice).toBeDefined();
    capture = true;
    act(() => choice.click());
    expect(commits.length).toBeGreaterThan(0);
    expect(
      commits.every(
        (commit) => commit.ready === 'true' && commit.complete === 'true' && commit.rows === 17,
      ),
    ).toBe(true);
    expect(host.querySelector('button[data-row="5"][data-col="0"]')).toBe(oldCell);
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe('Siphon');
    expect(host.textContent).toContain('Name anchor: Siphon.');
    act(() =>
      (host.querySelector('button[data-row="12"][data-col="2"]') as HTMLButtonElement).click(),
    );
    const use = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Use selected cells (local reference)',
    )!;
    expect(use.disabled).toBe(false);
    act(() => use.click());
    expect(onReference).toHaveBeenCalledOnce();
    expect(onReference.mock.calls[0][0]).toMatchObject({
      row: { anchor: { row: 11, col: 1 } },
      cells: [{ dRow: 1, dCol: 1 }],
    });
  } finally {
    act(() => root.unmount());
    host.remove();
    useCompendiumStore.setState({ data: previous });
  }
});
