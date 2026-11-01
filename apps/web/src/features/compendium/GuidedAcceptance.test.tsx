// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { GuidedPreview } from './GuidedPreview';
import { guidedDecisions, guidedRevision, type GuidedDecision } from './guidedDecisions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('accepts exactly displayed high links, cancels without action, and blocks a stale frozen preview', async () => {
  const f = guidedFixture();
  const host = document.createElement('div');
  const root = createRoot(host);
  const onAccept = vi.fn<(entries: GuidedDecision[], revision: string) => void>();
  let props = { ...f, category: f.categories[0], canEdit: true, onAccept };
  const render = async () => {
    await act(async () => root.render(createElement(GuidedPreview, props)));
  };
  const button = (text: string) =>
    [...host.querySelectorAll('button')].find((button) => button.textContent?.startsWith(text))!;
  const click = async (text: string) => {
    await act(async () => button(text).click());
  };
  try {
    await render();
    await click('Preview all high');
    expect(host.querySelector('[aria-label="Category acceptance preview"]')?.textContent).toContain(
      '3 high links',
    );
    await click('Cancel preview');
    expect(onAccept).not.toHaveBeenCalled();
    await click('Preview all high');
    await click('Accept all high');
    expect(onAccept).toHaveBeenCalledOnce();
    expect(onAccept.mock.calls[0][0].map((entry) => entry.hash)).toEqual([100, 101, 102]);
    expect(onAccept.mock.calls[0][1]).toBe(
      guidedRevision(
        guidedDecisions(f.document, f.categories, f.proposals, f.source, f.baseline, f.scope),
      ),
    );
    await click('Preview all high');
    props = { ...props, baseline: props.baseline + 'changed' };
    await render();
    expect(button('Accept all high').disabled).toBe(true);
    await click('Accept all high');
    expect(onAccept).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});

it('preselects one medium source for confirmation and respects read-only permission', async () => {
  const f = guidedFixture();
  // Source name carries the exact perk as a line within an exotic row, requiring confirmation.
  f.source.tabs[0].rows[2].name = 'A Weapon\nSample 102';
  f.source.tabs[0].rows[2].nameNorm = 'a weapon sample 102';
  const onAccept = vi.fn();
  const host = document.createElement('div');
  const root = createRoot(host);
  const props = { ...f, category: f.categories[0], canEdit: true, onAccept };
  const button = (text: string) =>
    [...host.querySelectorAll('button')].find((button) => button.textContent?.startsWith(text))!;
  try {
    await act(async () => root.render(createElement(GuidedPreview, props)));
    await act(async () => button('Review medium').click());
    expect(host.querySelector('[aria-label="Category acceptance preview"]')?.textContent).toContain(
      'Mechanics 2',
    );
    await act(async () => button('Confirm Sample 102').click());
    expect(onAccept.mock.calls[0][0].map((entry: GuidedDecision) => entry.hash)).toEqual([102]);
    await act(async () => root.render(createElement(GuidedPreview, { ...props, canEdit: false })));
    expect(button('Preview all high').disabled).toBe(true);
    expect(button('Review medium').disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});
