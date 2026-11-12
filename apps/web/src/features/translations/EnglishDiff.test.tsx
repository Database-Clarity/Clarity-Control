// @vitest-environment jsdom
// The translator's English diff names a tagging-only change "Markup only" (ELEMENT-TAGS-2), renders
// it with the new tags outlined, and steps through the same words in the translation (ELEMENT-TAGS-3).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { EnglishDiffContent } from './EnglishDiff';
import { newlyTagged } from './MarkupOnlyEnglish';
import { suggestConfiguration, suggestExtension, suggestState } from '../editor/suggest/state';

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
  // The current English renders (no raw markup), with the newly tagged span outlined.
  const rendered = host.querySelector<HTMLElement>('[data-markup-only-text]')!;
  expect(rendered.textContent).toContain('Gain Scorch.');
  expect(rendered.textContent).not.toContain('<solar');
  expect([...rendered.querySelectorAll('[data-new-tag]')].map((span) => span.textContent)).toEqual([
    'Scorch',
  ]);
  expect(host.querySelector('[data-tag-here]')?.textContent).toBe('Tag the same words here');
});

it('outlines only the spans that are new, not ones tagged before', async () => {
  await show(
    'Gain <solar Scorch /> and <solar/>Scorch, <arc/>Jolt.',
    'Gain <solar Scorch /> and <solar Scorch />, <arc Jolt />.',
  );
  const outlined = [...host.querySelectorAll('[data-markup-only-text] [data-new-tag]')];
  expect(outlined.map((span) => span.textContent)).toEqual(['Scorch', 'Jolt']);
  // The second Scorch is the new one (the first was already tagged).
  const scorches = [...host.querySelectorAll('[data-markup-only-text] *')].filter(
    (span) => span.children.length === 0 && span.textContent === 'Scorch',
  );
  expect(scorches.length).toBe(2);
  expect(scorches[0]!.closest('[data-new-tag]')).toBeNull();
  expect(scorches[1]!.closest('[data-new-tag]')).not.toBeNull();
});

it('"Tag the same words here" steps through the matching pairs in the translation', async () => {
  const view = new EditorView({
    state: EditorState.create({
      doc: 'Gewinne <solar/>Glut und <arc/>Blitz.\nDann <solar/> Brand.',
      extensions: [
        suggestExtension(),
        suggestConfiguration({ globals: { variables: '', titles: '' } }),
      ],
    }),
    parent: document.body,
  });
  view.dom.dataset.tooltipHash = '1';
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((run) => {
    run(0);
    return 0;
  });
  try {
    await show('Gain <solar/>Scorch.', 'Gain <solar Scorch />.');
    const step = () => act(() => host.querySelector<HTMLButtonElement>('[data-tag-here]')!.click());
    const selected = () =>
      view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    step();
    // The joined pair: its word is selected and Ctrl+Space starts on the Solar wrap.
    expect(selected()).toBe('Glut');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('1 of 2');
    const menu = suggestState(view.state)!;
    expect(menu.items[menu.index]).toMatchObject({ id: 'icon:solar', wrap: true });
    expect(menu.items[menu.index]!.insert).toBe('<solar Glut />');
    expect(menu.aside).toBe('1 of 2 in the translation');
    // Nothing changes until the translator decides.
    expect(view.state.doc.toString()).toContain('<solar/>Glut');
    step();
    // The spaced pair: the caret at its word, and the menu on "Group with icon" (it asks first).
    expect(selected()).toBe('');
    expect(view.state.selection.main.head).toBe(view.state.doc.toString().indexOf('Brand'));
    const spaced = suggestState(view.state)!;
    expect(spaced.items[spaced.index]).toMatchObject({ group: 'spaced' });
    expect(spaced.aside).toBe('2 of 2 in the translation');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('2 of 2');
    step();
    expect(selected()).toBe('Glut');
  } finally {
    frames.mockRestore();
    view.destroy();
  }
});

it('says so when the translation has no matching pair', async () => {
  const view = new EditorView({
    state: EditorState.create({ doc: 'Gewinne <arc/>Blitz.' }),
    parent: document.body,
  });
  view.dom.dataset.tooltipHash = '1';
  try {
    await show('Gain <solar/>Scorch.', 'Gain <solar Scorch />.');
    act(() => host.querySelector<HTMLButtonElement>('[data-tag-here]')!.click());
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      'No untagged Solar icon before a word in the translation.',
    );
    expect(view.state.selection.main.empty).toBe(true);
  } finally {
    view.destroy();
  }
});

it('newlyTagged: a changed element counts as new; a moved-but-same tag does not', () => {
  expect(newlyTagged('<solar/>A <arc B />', '<solar A /> <arc B />').map((t) => t.text)).toEqual([
    'A',
  ]);
  expect(newlyTagged('<arc A />', '<solar A />').map((t) => t.element)).toEqual(['solar']);
  expect(newlyTagged('<arc A /> x', '<arc A /> x')).toEqual([]);
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

it('says "Markup only" after the last tag is unwrapped too', async () => {
  await show('Gain <solar Scorch />.', 'Gain <solar/>Scorch.');
  expect(host.querySelector('[data-markup-only]')?.textContent).toContain('Markup only:');
});
