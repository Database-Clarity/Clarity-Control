import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { completeWeaponTypeLabels } from '@clarity/core';
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

test('associated previews use the localized catalog labels', () => {
  const data = editorData();
  data.weaponTypeLabels = completeWeaponTypeLabels({ Sword: { en: 'Sword', de: 'Schwert' } });
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
        weaponTypeLabels: data.weaponTypeLabels,
      }),
    ),
  );
  expect(html).toContain('Associated tooltip previews');
  expect(html).toContain('>Schwert</option>');
});
