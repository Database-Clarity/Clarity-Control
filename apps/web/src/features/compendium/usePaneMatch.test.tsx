// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { usePaneMatch } from './usePaneMatch';
import { paneMatch } from './paneMatch';
import { guidedFixture } from '../../../test/guided-fixture';
import type { Drafts } from '../../services/draftStorage';

vi.mock('./paneMatch', () => ({ paneMatch: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('keeps Matched visible across text edits and focus refreshes without rematching each keystroke', async () => {
  const f = guidedFixture();
  const base = f.categories[0].entries[0].base;
  const match = {
    status: 'ok' as const,
    changed: false,
    tab: f.source.tabs[0],
    row: f.source.tabs[0].rows[0],
  };
  vi.mocked(paneMatch).mockReturnValue(match);
  const fetchGuidance = vi.fn(
    async () => new Response(JSON.stringify({ document: null, revision: null })),
  );
  vi.stubGlobal('fetch', fetchGuidance);
  vi.stubGlobal('localStorage', { getItem: () => null });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Witness({ drafts }: { drafts: Drafts }) {
    const match = usePaneMatch({ ...base }, f.editor, f.source, drafts);
    return createElement('span', null, match ? 'Matched' : 'No match');
  }
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
  try {
    await act(async () => root.render(createElement(Witness, { drafts: {} })));
    await settle();
    expect(host.textContent).toBe('Matched');
    expect(paneMatch).toHaveBeenCalledTimes(1);
    for (const text of ['a', 'ab', 'abc']) {
      const next = { ...base, text: { en: { text } } } as Tooltip;
      await act(async () =>
        root.render(createElement(Witness, { drafts: { [base.hash]: { base, next } } })),
      );
      expect(host.textContent).toBe('Matched');
    }
    await settle();
    expect(paneMatch).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(host.textContent).toBe('Matched');
    await settle();
    expect(host.textContent).toBe('Matched');
    expect(paneMatch).toHaveBeenCalledTimes(2);
    expect(fetchGuidance).toHaveBeenCalledTimes(2);
    vi.mocked(paneMatch).mockReturnValue(undefined);
    await act(async () => {
      window.dispatchEvent(new Event('storage'));
    });
    expect(host.textContent).toBe('Matched');
    await settle();
    expect(host.textContent).toBe('No match');
    const customBase = { ...base, custom: { name: 'Custom', categoryId: 'attachment-effect' } };
    await act(async () =>
      root.render(
        createElement(Witness, {
          drafts: { [base.hash]: { base: customBase, next: base } },
        }),
      ),
    );
    await settle();
    expect(paneMatch).toHaveBeenCalledTimes(4);
    const projectedDrafts = vi.mocked(paneMatch).mock.calls[3][3];
    expect(projectedDrafts[base.hash].base.custom).toEqual(customBase.custom);
    expect(projectedDrafts[base.hash].next.custom).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
