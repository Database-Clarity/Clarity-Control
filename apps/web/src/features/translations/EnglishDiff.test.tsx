// @vitest-environment jsdom
// The translator's English diff names a tagging-only change "Markup only" (ELEMENT-TAGS-2).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EnglishDiffContent } from './EnglishDiff';

const source = vi.hoisted(() => ({ text: '' }));
vi.mock('../../services/history', () => ({
  getHistory: async () => ({ commits: [{ commit: 'a'.repeat(40) }] }),
  getVersion: async () => ({
    tooltip: {
      hash: 1,
      associated: [],
      text: { en: { text: source.text, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'x' } },
    },
  }),
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function show(before: string, current: string) {
  source.text = before;
  await act(async () =>
    root.render(
      <EnglishDiffContent hash={1} sourceUpdatedAt="2026-01-01T00:00:00Z" current={current} />,
    ),
  );
  await act(async () => {});
}

it('says "Markup only" when only element tags changed', async () => {
  await show('Gain <solar/>Scorch.', 'Gain <solar Scorch />.');
  expect(host.querySelector('[data-markup-only]')?.textContent).toContain('Markup only:');
  // No word diff: it would strike the unchanged words around the markup.
  expect(host.querySelector('del, ins, s, u')).toBeNull();
  expect(host.textContent).toContain('Gain <solar Scorch />.');
});

it('keeps the word diff for a real wording change', async () => {
  await show('Gain <solar/>Scorch.', 'Gain <solar Scorch /> twice.');
  expect(host.querySelector('[data-markup-only]')).toBeNull();
  expect(host.textContent).toContain('English when translated');
});

it('says the English did not change when the source is the current text', async () => {
  await show('Gain <solar Scorch />.', 'Gain <solar Scorch />.');
  expect(host.textContent).toContain('has not changed since this translation');
  expect(host.querySelector('[data-markup-only]')).toBeNull();
});
