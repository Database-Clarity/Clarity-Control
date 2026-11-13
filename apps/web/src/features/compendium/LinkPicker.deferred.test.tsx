// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompendiumData, Tooltip } from '@clarity/core';
import { LinkPicker, openLinkPickerSoon } from './LinkPicker';
import { useCompendiumStore } from './store';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => useCompendiumStore.setState({ data: null }));

const text = (plain: string) => ({ plain, runs: [{ text: plain }] });
const source: CompendiumData = {
  fetchedAt: '2026-11-12T00:00:00Z',
  tabs: [
    {
      gid: '7',
      name: 'Armor Mods',
      rows: [
        {
          rowIndex: 3,
          name: 'Alpha',
          nameNorm: 'alpha',
          anchor: { row: 3, col: 0 },
          cell: text('a'),
        },
        {
          rowIndex: 9,
          name: 'Beta',
          nameNorm: 'beta',
          anchor: { row: 9, col: 0 },
          cell: text('b'),
        },
      ],
      grid: Array.from({ length: 30 }, (_, index) => ({
        row: index + 1,
        col: 0,
        cell: text(index === 2 ? 'Alpha' : index === 8 ? 'Beta' : `Row ${index + 1}`),
      })),
    },
  ],
};

async function drain() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it('mounts each anchor sheet after the input task, keeping the shown sheet until then', async () => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  useCompendiumStore.setState({ data: source });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const picker = () => host.querySelector('section[aria-label="Link a Compendium row"]')!;
  const sheets = () =>
    [...host.querySelectorAll('section[aria-label="Pick description cells"]')].map((sheet) => ({
      sheet,
      visible: !sheet.closest('[hidden]'),
    }));
  try {
    act(() =>
      root.render(
        createElement(LinkPicker, {
          base: { hash: 1, text: {}, associated: [] } as unknown as Tooltip,
          name: 'Alpha',
          category: 'armor-mod-general',
          onLinked: () => {},
          onReference: () => {},
        }),
      ),
    );
    // The opening commit carries the controls and rows, not the sheet.
    expect(picker().getAttribute('aria-busy')).toBe('true');
    expect(sheets()).toHaveLength(0);
    await drain();
    expect(picker().getAttribute('aria-busy')).toBe('false');
    expect(sheets()).toHaveLength(1);
    expect(sheets()[0].visible).toBe(true);
    const alpha = sheets()[0].sheet;
    expect(alpha.textContent).toContain('Name anchor: Alpha');

    // Another row: until its sheet commits, the current one stays visible and busy is set.
    // Search all rows so both anchors are listed.
    const query = host.querySelector<HTMLInputElement>(
      'section[aria-label="Link a Compendium row"] > label > input',
    )!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(query, 'Beta');
      query.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const pick = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Pick description cells near this name'),
    )!;
    act(() => pick.click());
    expect(picker().getAttribute('aria-busy')).toBe('true');
    expect(sheets()).toHaveLength(1);
    expect(sheets()[0].visible).toBe(true);
    await drain();
    expect(picker().getAttribute('aria-busy')).toBe('false');
    expect(sheets()).toHaveLength(2);
    expect(
      sheets()
        .filter((entry) => entry.visible)
        .map((entry) => entry.sheet.textContent),
    ).toEqual([expect.stringContaining('Name anchor: Beta')]);
    // The earlier anchor's sheet (and its selection state) is retained, hidden.
    expect(alpha.isConnected).toBe(true);
    expect(alpha.closest('[hidden]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it('renders the first 12 rows with the input, commits the sheet, then the remaining rows', async () => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const many: CompendiumData = {
    ...source,
    tabs: [
      {
        ...source.tabs[0],
        rows: Array.from({ length: 40 }, (_, index) => ({
          rowIndex: index + 1,
          name: `Entry ${String(index + 1).padStart(2, '0')}`,
          nameNorm: `entry ${index + 1}`,
          anchor: { row: index + 1, col: 0 },
          cell: text('x'),
        })),
      },
    ],
  };
  useCompendiumStore.setState({ data: many });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const rows = () => host.querySelectorAll('section[aria-label="Link a Compendium row"] > ul > li');
  const picker = () => host.querySelector('section[aria-label="Link a Compendium row"]')!;
  let rowsAtSheet: number | undefined;
  const observer = new MutationObserver(() => {
    if (
      rowsAtSheet === undefined &&
      host.querySelector('section[aria-label="Pick description cells"]')
    )
      rowsAtSheet = rows().length;
  });
  observer.observe(host, { childList: true, subtree: true });
  try {
    act(() =>
      root.render(
        createElement(LinkPicker, {
          base: { hash: 1, text: {}, associated: [] } as unknown as Tooltip,
          name: 'Unlisted',
          category: 'armor-mod-general',
          onLinked: () => {},
          onReference: () => {},
        }),
      ),
    );
    expect(rows()).toHaveLength(12);
    expect(picker().getAttribute('data-sheet-pending')).toBe('true');
    await drain();
    expect(rowsAtSheet).toBe(12);
    expect(rows()).toHaveLength(40);
    expect(picker().getAttribute('data-sheet-pending')).toBe('false');
    expect(picker().getAttribute('aria-busy')).toBe('false');
  } finally {
    observer.disconnect();
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it('opens a picker after the input, once its lookups have run, unless cancelled first', async () => {
  useCompendiumStore.setState({ data: source });
  const open = vi.fn();
  openLinkPickerSoon('armor-mod-general', 'Alpha', open);
  expect(open).not.toHaveBeenCalled();
  const cancelled = vi.fn();
  openLinkPickerSoon('armor-mod-general', 'Alpha', cancelled)();
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(open).toHaveBeenCalledOnce();
  expect(cancelled).not.toHaveBeenCalled();
});
