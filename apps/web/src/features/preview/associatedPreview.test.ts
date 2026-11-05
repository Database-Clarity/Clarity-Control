// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { editorData, english } from '../../services/save/fixtures.testSupport';
import type { EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { parseMarkup } from '@clarity/core';
vi.mock('@clarity/core', async (original) => {
  const core = await original<typeof import('@clarity/core')>();
  return { ...core, parseMarkup: vi.fn(core.parseMarkup) };
});
const shared = vi.hoisted(() => ({ data: null as EditorData | null }));
vi.mock('../../stores/data', () => ({
  useDataStore: (select: (state: { data: EditorData | null }) => unknown) => select(shared),
}));
import { TooltipPreview } from './TooltipPreview';

afterEach(() => {
  shared.data = null;
});

test('associated previews retain full descriptions under ordinary headings', () => {
  const data = editorData();
  data.bundle.tooltips[123] = { ...data.bundle.tooltips[123], associated: [321] };
  data.items[321] = { ...data.items[123], hash: 321, name: 'Associated' };
  data.bundle.tooltips[321] = {
    hash: 321,
    associated: [],
    text: { de: { ...english, text: '<weapons Sword>\nBody\n</weapons>' } },
  };
  shared.data = data;
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      {},
      createElement(TooltipPreview, {
        text: 'Main',
        lang: 'de',
        name: 'Parent',
        tooltipHash: 123,
        globals: { variables: '', titles: '' },
      }),
    ),
  );
  expect(html).toContain('Associated tooltip previews');
  expect(html).toContain('Sword');
  expect(html).toContain('Body');
  expect(html).not.toContain('<select');
});

test('typing leaves associated previews alone while their own text and membership stay live', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const original = useDraftStore.getState();
  const data = editorData();
  const parent = { ...data.bundle.tooltips[123], associated: [321] };
  const related = {
    hash: 321,
    associated: [],
    text: { en: { ...english, text: 'Associated body' } },
  };
  data.bundle.tooltips[123] = parent;
  data.bundle.tooltips[321] = related;
  data.items[321] = { ...data.items[123], hash: 321, name: 'Associated' };
  shared.data = data;
  useDraftStore.setState({ drafts: {} });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(
          MemoryRouter,
          {},
          createElement(TooltipPreview, {
            text: 'Parent body',
            lang: 'en',
            name: 'Parent',
            tooltipHash: 123,
            globals: { variables: '', titles: '' },
          }),
        ),
      ),
    );
    expect(host.textContent).toContain('Associated body');
    vi.mocked(parseMarkup).mockClear();
    await act(async () =>
      useDraftStore.setState({
        drafts: {
          123: {
            base: parent,
            next: { ...parent, text: { en: { ...english, text: 'Parent typed' } } },
          },
        },
      }),
    );
    expect(parseMarkup).not.toHaveBeenCalled();
    await act(async () =>
      useDraftStore.setState({
        drafts: {
          ...useDraftStore.getState().drafts,
          321: {
            base: related,
            next: { ...related, text: { en: { ...english, text: 'Updated related body' } } },
          },
        },
      }),
    );
    expect(host.textContent).toContain('Updated related body');
    await act(async () =>
      useDraftStore.setState({
        drafts: {
          ...useDraftStore.getState().drafts,
          123: { base: parent, next: { ...parent, associated: [] } },
        },
      }),
    );
    expect(host.querySelector('[aria-label="Associated tooltip previews"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    useDraftStore.setState(original);
  }
});
