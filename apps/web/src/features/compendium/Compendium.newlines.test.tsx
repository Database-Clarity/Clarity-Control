// @vitest-environment jsdom
// Regression: every surface that shows Compendium text keeps its line breaks and blank lines.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompendiumCell, CompendiumData, CompendiumSheet, Tooltip } from '@clarity/core';
import { guidedFixture } from '../../../test/guided-fixture';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useCompendiumStore } from './store';
import { BulkPreview, createBulkPreview } from './BulkPreview';
import { CategoryReview } from './CategoryReview';
import { CellPicker } from './CellPicker';
import { CompendiumDiff } from './CompendiumDiff';
import { CompendiumPanel } from './CompendiumPanel';
import { GuidedPreview } from './GuidedPreview';
import { ProposalContext } from './ProposalContext';
import { reviewQueue } from './reviewQueue';
import { emptyProgress, sourceFingerprint } from './reviewProgress';
import { proposalFor } from './rapidReview';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TEXT = 'line1\nline2\n\nline4';
const cellOf = (text: string): CompendiumCell => ({ plain: text, runs: [{ text }] });
const guided = () => guidedFixture((i) => `Mechanics ${i}\n${TEXT}`);
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});
async function mount(node: React.ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(node));
  return host;
}
const dom = (html: string) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
};
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

  it('CellPicker keeps breaks in the phone list, detail and sheet cells', async () => {
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
    expect(multiline(host, '[aria-label="Description cell list"]').length).toBeGreaterThan(0);
    expect(multiline(host, 'table').length).toBeGreaterThan(0);
    await click(host, 'Row 1, column 2');
    expect(multiline(host, '[aria-label="Cell detail"]')).toHaveLength(1);
  });

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

  it('ProposalContext (match review, bulk preview) keeps breaks in source and nearby cells', () => {
    const f = guided();
    const match = f.proposals.get(100)!.match!;
    match.tab.grid = [{ row: match.row.rowIndex, col: 1, cell: cellOf(TEXT) }] as never;
    const html = renderToStaticMarkup(createElement(ProposalContext, { match, source: f.source }));
    // Source cell + the nearby grid cell (cell text itself carries the "Mechanics" prefix).
    expect(multiline(dom(html))).toHaveLength(2);
  });

  it('BulkPreview keeps breaks in each proposal source', () => {
    const f = guided();
    const entries = reviewQueue(
      f.editor,
      f.source,
      {},
      emptyProgress(),
      sourceFingerprint(f.source.tabs),
    );
    const proposals = new Map(
      entries.map((entry) => [entry.hash, proposalFor(entry.base, f.editor, f.source)]),
    );
    const preview = createBulkPreview(f.editor, f.source, entries, proposals);
    const html = renderToStaticMarkup(
      createElement(BulkPreview, {
        preview,
        page: 0,
        current: true,
        canEdit: true,
        onAccept: vi.fn(),
        onPage: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    expect(multiline(dom(html))).toHaveLength(6);
  });

  it('GuidedPreview keeps breaks in the frozen preview sources', async () => {
    const f = guided();
    const host = await mount(
      createElement(GuidedPreview, { ...f, category: f.categories[0], canEdit: true }),
    );
    await click(host, 'Preview all high');
    expect(multiline(host, '[aria-label="Category acceptance preview"]').length).toBeGreaterThan(0);
  });

  it('CategoryReview sample review keeps breaks in the proposed source', () => {
    const f = guided();
    const guidance = {
      ready: true,
      reloading: false,
      conflict: false,
      saving: false,
      diskSaved: false,
      document: f.document,
      proposalInput: f.document,
      planningRevision: 0,
      persistence: { getSnapshot: () => ({ ready: true, document: f.document }) },
    } as never;
    const html = renderToStaticMarkup(
      createElement(CategoryReview, {
        categories: f.categories,
        editor: f.editor,
        source: f.source,
        proposals: f.proposals,
        guidance,
        onReview: vi.fn(),
      }),
    );
    const sample = dom(html).querySelector('[aria-label="Sample proposed source"]')!;
    expect(multiline(sample)).toHaveLength(1);
  });
});
