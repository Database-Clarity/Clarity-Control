// @vitest-environment jsdom
// Regression: every surface that shows Compendium text keeps its line breaks and blank lines.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompendiumCell, CompendiumData, CompendiumSheet, Tooltip } from '@clarity/core';
import { guidedFixture } from '../../../test/guided-fixture';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useCompendiumStore } from './store';
import { CellPicker } from './CellPicker';
import { CompendiumDetail } from './CompendiumDetail';
import { matchLocation } from './sourceLocation';
import { MemoryRouter } from 'react-router-dom';
import { CompendiumDiff } from './CompendiumDiff';
import { CompendiumPanel } from './CompendiumPanel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TEXT = 'line1\nline2\n\nline4';
const cellOf = (text: string): CompendiumCell => ({ plain: text, runs: [{ text }] });
const guided = () => guidedFixture((i) => `Mechanics ${i}\n${TEXT}`);
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function mount(node: React.ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(node));
  return host;
}
/** Wrappers flagged multiline (pre-wrap via RichCell.module.scss) whose text keeps TEXT verbatim. */
const multiline = (root: ParentNode, within = '*') =>
  [...root.querySelectorAll<HTMLElement>(`${within} [data-multiline]`)].filter((node) =>
    node.textContent?.includes(TEXT),
  );
const click = async (host: HTMLElement, text: string) => {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text));
  if (!button) throw new Error(`No button: ${text}`);
  await act(async () => button.click());
};

describe('compendium newline preservation per surface', () => {
  it('diff: inline mode and BOTH side-by-side panes keep exact multiline text', async () => {
    const before = cellOf(TEXT);
    const after = cellOf('line1\nline2\n\nline4 changed');
    const host = await mount(createElement(CompendiumDiff, { before, after }));
    expect(host.querySelector('[data-multiline]')).not.toBeNull();
    await click(host, 'Before / After');
    const panes = [...host.querySelectorAll('section section')];
    const snapshot = panes.find((pane) => pane.querySelector('h4')?.textContent === 'Snapshot')!;
    const current = panes.find((pane) => pane.querySelector('h4')?.textContent === 'Current')!;
    expect(snapshot.querySelector('[data-multiline]')?.textContent).toBe(TEXT);
    expect(current.querySelector('[data-multiline]')?.textContent).toBe(after.plain);
  });

  it('CompendiumPanel keeps breaks for the saved snapshot', async () => {
    const tooltip = {
      hash: 5,
      text: {},
      associated: [],
      compendium: {
        gid: 'g1',
        rowKey: 'Name',
        section: '',
        snapshotAt: '2026-11-01T00:00:00Z',
        snapshot: cellOf(TEXT),
      },
    } as unknown as Tooltip;
    useAuthStore.setState({ user: null });
    useDataStore.setState({ data: null });
    useCompendiumStore.setState({ data: { fetchedAt: '2026-11-01T00:00:00Z', tabs: [] } });
    const host = await mount(createElement(CompendiumPanel, { base: tooltip }));
    expect(multiline(host)).toHaveLength(1);
  });

  it.each([true, false])(
    'CellPicker preserves active-layout line breaks with phone=%s',
    async (phone) => {
      vi.stubGlobal('matchMedia', () => ({ matches: phone }));
      const tab = {
        gid: 'g1',
        name: 'Tab',
        rows: [],
        grid: [
          { row: 1, col: 0, cell: cellOf('Anchor') },
          { row: 1, col: 1, cell: cellOf(TEXT) },
        ],
      } as unknown as CompendiumSheet;
      const data: CompendiumData = { fetchedAt: '2026-11-01T00:00:00Z', tabs: [tab] };
      const host = await mount(
        createElement(CellPicker, {
          tab,
          data,
          initial: {
            name: 'Anchor',
            nameNorm: 'anchor',
            rowIndex: 1,
            anchor: { row: 1, col: 0 },
            cell: cellOf('Anchor'),
          },
          onChoose: vi.fn(),
        }),
      );
      const active = phone ? '[aria-label="Description cell list"]' : 'table';
      expect(multiline(host, active).some((node) => node.textContent === TEXT)).toBe(true);
      expect(
        host.querySelector(phone ? 'table' : '[aria-label="Description cell list"]'),
      ).toBeNull();
      if (phone) {
        await click(host, 'Row 1, column 2');
        const detail = multiline(host, '[aria-label="Cell detail"]');
        expect(detail).toHaveLength(1);
        expect(detail[0].textContent).toBe(TEXT);
      }
    },
  );

  it('CellPicker anchor search hits (plain snippets in buttons) keep breaks', async () => {
    const tab = {
      gid: 'g1',
      name: 'Tab',
      rows: [],
      grid: [{ row: 1, col: 0, cell: cellOf(TEXT) }],
    } as unknown as CompendiumSheet;
    const host = await mount(
      createElement(CellPicker, {
        tab,
        data: { fetchedAt: '2026-11-01T00:00:00Z', tabs: [tab] },
        onChoose: vi.fn(),
      }),
    );
    const input = host.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'line1',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(multiline(host, 'ul button')).toHaveLength(1);
  });

  it('CompendiumDetail keeps breaks in candidate cells and lazily opened nearby cells', async () => {
    const f = guided();
    const match = f.proposals.get(100)!.match!;
    match.tab.grid = [{ row: match.row.rowIndex, col: 1, cell: cellOf(TEXT) }] as never;
    const compact = { ...match, tab: { ...match.tab, grid: undefined, rows: [] } };
    const host = await mount(
      createElement(
        MemoryRouter,
        null,
        createElement(CompendiumDetail, {
          row: { hash: 100, name: 'Sample 100', category: 'weapon-trait', kind: 'proposal' },
          categoryLabel: 'Traits',
          manifest: [],
          currentText: TEXT,
          blocks: [
            {
              id: 'proposal',
              origin: 'proposal',
              match: compact,
              location: matchLocation(compact, f.source),
            },
          ],
          highlight: 0,
          onHighlight: vi.fn(),
          source: f.source,
        }),
      ),
    );
    expect(multiline(host)).toHaveLength(1);
    await act(async () => {
      const details = host.querySelector('details')!;
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    expect(multiline(host)).toHaveLength(2);
  });
});
