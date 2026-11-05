// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { usePaneMatch } from './usePaneMatch';
import { matchingSession } from './matchingSession';
import { guidedFixture } from '../../../test/guided-fixture';
import type { Drafts } from '../../services/draftStorage';
import { emptyProgress, reviewStorageKey } from './reviewProgress';
import { recordDecision } from './rapidReview';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl } from '../../services/compendium';
import { apiUrl } from '../../services/api';

vi.mock('./matchingSession', async (original) => ({
  ...(await original<typeof import('./matchingSession')>()),
  matchingSession: vi.fn(),
}));
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
  const display = vi.fn(async () => ({
    matches: new Map([[base.hash, match]]),
    decisions: [],
    fingerprint: '',
    evidence: [],
    categories: [],
    scopeHashes: [],
  }));
  vi.mocked(matchingSession).mockReturnValue({
    display,
    prioritize: async () => new Map(),
    prioritizeReview: async (_input, hash) => ({
      hash,
      baseline: '',
      fingerprint: '',
      matches: new Map(),
    }),
    proposals: Promise.resolve(new Map()),
    currentProposals: undefined,
    guided: async () => [],
    dispose: () => undefined,
  });
  const fetchGuidance = vi.fn(
    async () => new Response(JSON.stringify({ document: null, revision: null })),
  );
  vi.stubGlobal('fetch', fetchGuidance);
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null });
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
    expect(display).toHaveBeenCalledTimes(1);
    for (const text of ['a', 'ab', 'abc']) {
      const next = { ...base, text: { en: { text } } } as Tooltip;
      await act(async () =>
        root.render(createElement(Witness, { drafts: { [base.hash]: { base, next } } })),
      );
      expect(host.textContent).toBe('Matched');
    }
    await settle();
    expect(display).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(host.textContent).toBe('Matched');
    await settle();
    expect(host.textContent).toBe('Matched');
    expect(display).toHaveBeenCalledTimes(2);
    expect(fetchGuidance).toHaveBeenCalledTimes(2);
    display.mockResolvedValue({
      matches: new Map(),
      decisions: [],
      fingerprint: '',
      evidence: [],
      categories: [],
      scopeHashes: [],
    });
    values.set(
      reviewStorageKey(`${bundleUrl}|${compendiumDataUrl}|${apiUrl ?? 'read-only'}`),
      JSON.stringify(
        recordDecision(emptyProgress(), base.hash, 'changed-proof', 'skipped', undefined),
      ),
    );
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: reviewStorageKey(`${bundleUrl}|${compendiumDataUrl}|${apiUrl ?? 'read-only'}`),
        }),
      );
    });
    expect(host.textContent).toBe('No match');
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
    expect(display).toHaveBeenCalledTimes(4);
    const projectedDrafts = (display.mock.calls as unknown as [{ drafts: Drafts }][])[3][0].drafts;
    expect(projectedDrafts[base.hash].base.custom).toEqual(customBase.custom);
    expect(projectedDrafts[base.hash].next.custom).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});

it('paints validated matches before review metadata and rejects a superseded account reply', async () => {
  const f = guidedFixture();
  const base = f.categories[0].entries[0].base;
  type Display = ReturnType<ReturnType<typeof matchingSession>['display']>;
  type Matches = Awaited<Display>['matches'];
  const partials: ((matches: Matches) => void)[] = [];
  const complete: ((value: Awaited<Display>) => void)[] = [];
  const display = vi.fn<ReturnType<typeof matchingSession>['display']>((_input, onMatches) => {
    partials.push(onMatches!);
    return new Promise((resolve) => complete.push(resolve));
  });
  vi.mocked(matchingSession).mockReturnValue({
    display,
    prioritize: async () => new Map(),
    prioritizeReview: async (_input, hash) => ({
      hash,
      baseline: '',
      fingerprint: '',
      matches: new Map(),
    }),
    proposals: Promise.resolve(new Map()),
    currentProposals: undefined,
    guided: async () => [],
    dispose: () => undefined,
  });
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ document: null, revision: null })),
  );
  const host = document.createElement('div');
  const root = createRoot(host);
  function Witness({ userId }: { userId: number }) {
    return createElement(
      'span',
      null,
      usePaneMatch(base, f.editor, f.source, {}, userId) ? 'Matched' : 'No match',
    );
  }
  const matches: Matches = new Map([
    [
      base.hash,
      { status: 'ok', changed: false, tab: f.source.tabs[0], row: f.source.tabs[0].rows[0] },
    ],
  ]);
  try {
    await act(async () => root.render(createElement(Witness, { userId: 1 })));
    expect(host.textContent).toBe('No match');
    await act(async () => partials[0](matches));
    expect(host.textContent).toBe('Matched');
    await act(async () => root.render(createElement(Witness, { userId: 2 })));
    expect(host.textContent).toBe('No match');
    await act(async () => partials[0](matches));
    expect(host.textContent).toBe('No match');
    await act(async () => partials[1](matches));
    expect(host.textContent).toBe('Matched');
    await act(async () =>
      complete[1]({
        matches,
        evidence: [],
        categories: [],
        decisions: [],
        fingerprint: '',
        scopeHashes: [],
      }),
    );
    expect(host.textContent).toBe('Matched');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
