import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { editorData, english } from '../../services/save/fixtures.testSupport';
import type { EditorData } from '../../stores/data';
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
