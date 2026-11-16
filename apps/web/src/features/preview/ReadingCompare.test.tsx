// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseMarkup, type MarkupLine } from '@clarity/core';
import { guidedFixture } from '../../../test/guided-fixture';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { ReadingCompare } from './ReadingCompare';
import { ReadingSlots, ReadingTooltip } from './ReadingTooltip';
import { CompareLines } from './PreviewColumn';
import { compareRenders } from './compare';

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const data = guidedFixture().editor;
  data.categories = [
    { id: 'base', label: 'Base', group: 'Weapons', order: 1, legacyType: 'Weapon Trait' },
    {
      id: 'enhanced',
      label: 'Enhanced',
      group: 'Weapons',
      order: 2,
      legacyType: 'Weapon Trait Enhanced',
    },
  ];
  for (const [hash, categoryId] of [
    [7, 'base'],
    [8, 'enhanced'],
  ] as const)
    data.items[hash] = {
      hash,
      categoryId,
      name: 'Example',
      icon: '',
      inGameDescription: '',
      definitionType: 'DestinyInventoryItemDefinition',
    };
  useDataStore.setState({ data });
  useDraftStore.setState({ drafts: {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useDataStore.setState({ data: null });
  useDraftStore.setState({ drafts: {} });
  vi.unstubAllGlobals();
});
const pair = {
  baseText: 'Gain 5 stacks. Damage 10.',
  baseHash: 7,
  enhancedText: 'Gain 5 stacks. Damage 20.',
  enhancedHash: 8,
};

it('keeps default Compare DOM byte-identical when slot data is absent or belongs to another source', async () => {
  await act(async () => root.render(<ReadingCompare {...pair} />));
  const original = host.innerHTML;
  await act(async () =>
    root.render(
      <ReadingSlots.Provider value={undefined}>
        <ReadingCompare {...pair} />
      </ReadingSlots.Provider>,
    ),
  );
  expect(host.innerHTML).toBe(original);
  await act(async () =>
    root.render(
      <ReadingSlots.Provider value={{ text: 'Other 5.', ids: [7] }}>
        <ReadingCompare {...pair} />
      </ReadingSlots.Provider>,
    ),
  );
  expect(host.innerHTML).toBe(original);
});

it('preserves owned source ranges through word slicing and leaves explicit override values plain', async () => {
  await act(async () =>
    root.render(
      <ReadingSlots.Provider value={{ text: pair.baseText, ids: [7, 9] }}>
        <ReadingCompare {...pair} />
      </ReadingSlots.Provider>,
    ),
  );
  expect(host.querySelector('[data-slot="7"]')?.textContent).toBe('5');
  expect(host.querySelector('[data-slot="9"]')?.textContent).toBe('10');
  expect([...host.querySelectorAll('[data-slot]')].some((span) => span.textContent === '20')).toBe(
    false,
  );
  expect(host.textContent).toContain('20');
  await act(async () =>
    root.render(
      <ReadingSlots.Provider value={{ text: pair.baseText, ids: [7, 9] }}>
        <ReadingTooltip text={pair.enhancedText} hash={8} />
      </ReadingSlots.Provider>,
    ),
  );
  expect(host.querySelector('[data-slot]')).toBeNull();
});

it('uses the same source identity for derived base, Compare, and enhanced-only readings', async () => {
  const text = 'Damage ${5+#d}.\nvar d = 0\nenhanced (\nvar d = 5\n)';
  const slots = { text, ids: [21, 22, 23], hash: 7 };
  await act(async () =>
    root.render(
      <ReadingSlots.Provider value={slots}>
        <ReadingCompare
          baseText={text}
          baseHash={7}
          enhancedText={text}
          enhancedHash={8}
          enhancedSourceHash={7}
        />
      </ReadingSlots.Provider>,
    ),
  );
  expect([...host.querySelectorAll('[data-slot="21"]')].map((span) => span.textContent)).toEqual([
    '5',
    '10',
  ]);
  await act(async () =>
    root.render(
      <ReadingSlots.Provider value={slots}>
        <ReadingTooltip text={text} hash={8} sourceHash={7} />
      </ReadingSlots.Provider>,
    ),
  );
  expect(host.querySelector('[data-slot="21"]')?.textContent).toBe('10');
  await act(async () =>
    root.render(
      <ReadingSlots.Provider value={slots}>
        <ReadingTooltip text={text} hash={8} />
      </ReadingSlots.Provider>,
    ),
  );
  expect(host.querySelector('[data-slot]')).toBeNull();
});

it('keeps compare.ts default DOM exact with optional ranges off, and ignores ranges in content equality', () => {
  const before = parseMarkup(pair.baseText).lines,
    after = parseMarkup(pair.enhancedText).lines;
  const off = (lines: MarkupLine[]) =>
    lines.map((line) => ({
      ...line,
      linesContent: line.linesContent?.map((span) => ({
        ...span,
        slots: undefined,
        variables: undefined,
      })),
    }));
  const render = (a: MarkupLine[], b: MarkupLine[]) =>
    renderToStaticMarkup(<CompareLines comparison={compareRenders(a, b)} />);
  expect(render(off(before), off(after))).toBe(render(before, after));
  const text = 'Value 5.\ntitle Info (\nDetails 10.\n)\n<title Details [Info] />';
  const plain = parseMarkup(text).lines,
    indexed = parseMarkup(text, undefined, { slots: [3, 4] }).lines;
  expect(compareRenders(indexed, plain).changes).toBe(0);
  expect(render(indexed, plain)).toContain('data-slot="3"');
});
