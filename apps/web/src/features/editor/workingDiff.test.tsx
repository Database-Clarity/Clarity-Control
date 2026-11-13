// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lang, Tooltip } from '@clarity/core';
import { ClarityEditor } from './ClarityEditor';
import { WORKING_DIFF_DELAY } from './WorkingDiffPanel';
import { hasWorkingChanges, inView } from './workingDiff';

const diffWords = vi.hoisted(() => vi.fn());
vi.mock('../../ui/diff/diffWords', async (original) => {
  const actual = await original<typeof import('../../ui/diff/diffWords')>();
  diffWords.mockImplementation(actual.diffWords);
  return { ...actual, diffWords };
});

let host: HTMLDivElement;
let root: Root;
const q = (selector: string) => host.querySelector<HTMLElement>(selector);
const changes = () => q('[data-status-changes]') as HTMLButtonElement;
const panel = () => q('#editor-panel-diff');
const view = () => EditorView.findFromDOM(q('.cm-editor')!)!;
const stamp = { updatedAt: '2026-11-10T00:00:00Z', updatedBy: 'test' };
const tooltip = (hash: number, text: Partial<Record<Lang, string>>): Tooltip => ({
  hash,
  associated: [],
  text: Object.fromEntries(
    Object.entries(text).map(([lang, value]) => [lang, { text: value, ...stamp }]),
  ),
});
const saved = tooltip(10, { en: 'Deals 20% damage.', fr: 'Inflige 20% de dégâts.' });

/** The page in miniature: typing writes a draft; the saved version stays what it was. */
function Harness({
  base = saved,
  start = base,
  lang = 'en',
  stepping = false,
}: {
  base?: Tooltip;
  start?: Tooltip;
  lang?: Lang;
  stepping?: boolean;
}) {
  const [draft, setDraft] = useState({ base, current: start });
  const current = draft.base === base ? draft.current : start;
  if (draft.base !== base) setDraft({ base, current: start });
  return (
    <ClarityEditor
      value={current.text[lang]?.text ?? ''}
      lang={lang}
      globals={{ variables: '', titles: '' }}
      tooltipHash={base.hash}
      stepping={stepping}
      workingDiff={{ saved: base, current }}
      onChange={(text) =>
        setDraft({
          base,
          current:
            text === (base.text[lang]?.text ?? '')
              ? { ...current, text: { ...current.text, [lang]: base.text[lang]! } }
              : { ...current, text: { ...current.text, [lang]: { text, ...stamp } } },
        })
      }
    />
  );
}
const mount = (props: Parameters<typeof Harness>[0] = {}) =>
  act(() => root.render(<Harness {...props} />));
const type = (insert: string, from = view().state.doc.length) =>
  act(() => view().dispatch({ changes: { from, insert } }));
const settle = () => act(() => vi.advanceTimersByTime(WORKING_DIFF_DELAY + 50));
const key = (init: KeyboardEventInit) =>
  act(() => {
    q('.cm-content')!.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  diffWords.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('working diff (changes since the last save)', () => {
  it('keeps its control in place: disabled until the first edit, the same element after', () => {
    mount();
    const control = changes();
    expect(control.disabled).toBe(true);
    const label = control.innerHTML;
    expect(control.getAttribute('aria-label')).toBe('Changes since the last save');
    type(' More.');
    expect(changes()).toBe(control);
    expect(control.disabled).toBe(false);
    expect(control.innerHTML).toBe(label);
    expect(q('[data-editor-status]')!.firstElementChild).toBe(control);
  });

  it('does no diff work while closed, and compares only after typing pauses while open', () => {
    mount();
    type(' One.');
    type(' Two.');
    type(' Three.');
    act(() => vi.advanceTimersByTime(2000));
    expect(panel()).toBeNull();
    expect(diffWords).not.toHaveBeenCalled();

    act(() => changes().click());
    const raw = panel()?.querySelector('[aria-label="Raw diff"]');
    expect(raw).not.toBeNull();
    expect(raw?.closest('[data-overlay-scroll]')).toBeNull();
    expect(panel()?.textContent).toContain('Saved');
    expect(panel()?.textContent).toContain('Unsaved');
    expect(panel()?.querySelector('ins')?.textContent).toBe('One. Two. Three.');
    expect(panel()?.textContent).toContain('Deals 20% damage. One. Two. Three.');
    const opened = diffWords.mock.calls.length;
    expect(opened).toBeGreaterThan(0);

    type(' Four.');
    type(' Five.');
    expect(diffWords).toHaveBeenCalledTimes(opened);
    expect(q('[data-working-diff]')?.getAttribute('aria-busy')).toBe('true');
    expect(panel()?.querySelector('ins')?.textContent).toBe('One. Two. Three.');
    settle();
    // Enough added ink promotes the comparison to a whole-line rewrite.
    expect(panel()?.querySelector('ins')?.textContent).toBe(
      'Deals 20% damage. One. Two. Three. Four. Five.',
    );
    expect(q('[data-working-diff]')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('compares only the language in view, never a hidden one', () => {
    const start = tooltip(10, { en: 'Deals 25% damage.', fr: 'Inflige 99% de dégâts.' });
    mount({ start });
    act(() => changes().click());
    expect(panel()?.textContent).toContain('25%');
    expect(panel()?.textContent).not.toContain('99%');
    expect(panel()?.textContent).not.toContain('Inflige');
    expect(inView(start, 'en').text).toEqual({ en: start.text.en });
    // A change in a hidden language alone is not a change of this view.
    const french = tooltip(10, { en: 'Deals 20% damage.', fr: 'Inflige 99% de dégâts.' });
    expect(hasWorkingChanges(saved, french, 'en')).toBe(false);
    expect(hasWorkingChanges(saved, french, 'fr')).toBe(true);
  });

  it('counts and lists a field edited in the same view (an association) without a text change', () => {
    mount({ start: { ...saved, associated: [42] } });
    expect(changes().disabled).toBe(false);
    act(() => changes().click());
    expect(panel()?.textContent).toContain('Associated tooltips: (none) → 42');
    expect(panel()?.querySelector('ins, del')).toBeNull();
  });

  it('opens and closes with Ctrl+K, D and closes with Escape; the keys do nothing with no change', () => {
    mount();
    key({ key: 'k', ctrlKey: true });
    key({ key: 'd' });
    expect(panel()).toBeNull();
    expect(view().state.doc.toString()).toBe('Deals 20% damage.');
    type(' More.');
    key({ key: 'k', ctrlKey: true });
    key({ key: 'd' });
    expect(panel()).not.toBeNull();
    expect(changes().getAttribute('aria-expanded')).toBe('true');
    expect(view().state.doc.toString()).toBe('Deals 20% damage. More.');
    key({ key: 'k', ctrlKey: true });
    key({ key: 'd', ctrlKey: true });
    expect(panel()).toBeNull();
    act(() => changes().click());
    key({ key: 'Escape' });
    expect(panel()).toBeNull();
    // Esc on a bar item closes it too (Tab leaves the panel into the bar).
    act(() => changes().click());
    act(() => {
      changes().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(panel()).toBeNull();
  });

  it('gives the text room below its last line only while the view is open', () => {
    // The open view covers the bottom of the text; without room the end could not scroll clear.
    mount();
    type(' More.');
    const area = () => q('.cm-editor')!.parentElement!.parentElement!;
    expect(area().style.getPropertyValue('--overlay-room')).toBe('');
    act(() => changes().click());
    expect(area().style.getPropertyValue('--overlay-room')).toBe('0px');
    act(() => changes().click());
    expect(area().style.getPropertyValue('--overlay-room')).toBe('');
    expect(area().style.maxHeight).toBe('');
  });

  it('says so when the text is back at the saved version, and stays closable', () => {
    mount();
    type('!');
    act(() => changes().click());
    const end = view().state.doc.length;
    act(() => view().dispatch({ changes: { from: end - 1, to: end } }));
    settle();
    expect(panel()?.textContent).toContain('No changes since the last save.');
    expect(changes().disabled).toBe(false);
    act(() => changes().click());
    expect(panel()).toBeNull();
    expect(changes().disabled).toBe(true);
  });

  it('closes when another entry or language loads, and when stepping starts', () => {
    const start = tooltip(10, { en: 'Deals 25% damage.', fr: 'Inflige 99% de dégâts.' });
    mount({ start });
    act(() => changes().click());
    expect(panel()).not.toBeNull();
    mount({ start, lang: 'fr' });
    expect(panel()).toBeNull();
    act(() => changes().click());
    expect(panel()?.textContent).toContain('99%');
    const other = tooltip(11, { fr: 'Autre.' });
    const edited = tooltip(11, { fr: 'Autre texte.' });
    mount({ base: other, start: edited, lang: 'fr' });
    expect(panel()).toBeNull();
    // The first step of a navigation burst closes it, before the next entry has loaded.
    act(() => changes().click());
    expect(panel()).not.toBeNull();
    mount({ base: other, start: edited, lang: 'fr', stepping: true });
    expect(panel()).toBeNull();
  });
});
