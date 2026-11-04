// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Drafts } from '../../services/draftStorage';
import { guidedFixture } from '../../../test/guided-fixture';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl } from '../../services/compendium';
import { emptyProgress, reviewStorageKey } from './reviewProgress';
import { notifyCompendiumInputs } from './inputEvents';
import { useDisplayMatches } from './useDisplayMatches';

const calls = vi.hoisted(() => ({ display: vi.fn() }));
vi.mock('./matchingSession', async (original) => ({
  ...(await original<typeof import('./matchingSession')>()),
  matchingSession: () => ({ display: calls.display }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('reuses content through typing/focus and withholds old matches when local decisions change', async () => {
  vi.stubEnv('DEV', false);
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null });
  const fixture = guidedFixture();
  const base = fixture.categories[0].entries[0].base;
  const next = {
    ...base,
    compendium: {
      gid: 'g1',
      rowKey: 'Name',
      snapshotAt: '2026-11-04T00:00:00Z',
      snapshot: { plain: 'Source', runs: [{ text: 'Source' }] },
    },
  };
  const first = { matches: new Map([[base.hash, { row: { name: 'Source' } }]]), decisions: [] };
  calls.display.mockReset().mockResolvedValue(first);
  let latest: ReturnType<typeof useDisplayMatches>;
  function Probe({ drafts }: { drafts: Drafts }) {
    latest = useDisplayMatches(fixture.editor, fixture.source, drafts, 'content-regression');
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Probe drafts={{ [base.hash]: { base, next } }} />));
    expect(calls.display).toHaveBeenCalledTimes(1);
    for (const text of ['A', 'Ab', 'Abc']) {
      const edited = structuredClone(next);
      edited.text = { en: { text } } as typeof edited.text;
      await act(async () =>
        root.render(<Probe drafts={{ [base.hash]: { base, next: edited } }} />),
      );
    }
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));
    });
    expect(calls.display).toHaveBeenCalledTimes(1);
    expect(latest!.matches).toBe(first.matches);
    await act(async () =>
      root.render(<Probe key="warm-remount" drafts={{ [base.hash]: { base, next } }} />),
    );
    expect(latest!.prepared).toBe(first);
    expect(calls.display).toHaveBeenCalledTimes(1);
    let finish!: (value: unknown) => void;
    calls.display.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const scope = `${bundleUrl}|${compendiumDataUrl}`;
    const key = reviewStorageKey(`${scope}|read-only`, 'content-regression');
    values.set(
      key,
      JSON.stringify({
        ...emptyProgress(),
        decisions: { [base.hash]: { kind: 'no-equivalent', fingerprint: 'source' } },
      }),
    );
    await act(async () => notifyCompendiumInputs(key));
    expect(calls.display).toHaveBeenCalledTimes(2);
    expect(latest!.matches).toBeUndefined();
    expect(latest!.loading).toBe(true);
    expect(latest!.reviewPrepared).toBe(first);
    await act(async () => finish({ matches: new Map(), decisions: [] }));
    expect(latest!.matches?.size).toBe(0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
it('keeps factual review content through local link edits while withholding old automatic matches', async () => {
  vi.stubEnv('DEV', false);
  vi.stubGlobal('localStorage', { getItem: () => null });
  const fixture = guidedFixture();
  const base = fixture.categories[0].entries[0].base;
  const first = { matches: new Map([[base.hash, { row: { name: 'Source' } }]]), decisions: [] };
  calls.display.mockReset().mockResolvedValue(first);
  let latest: ReturnType<typeof useDisplayMatches>;
  function Probe({ drafts }: { drafts: Drafts }) {
    latest = useDisplayMatches(fixture.editor, fixture.source, drafts, 'local-link-regression');
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Probe drafts={{}} />));
    let finish!: (value: unknown) => void;
    calls.display.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const next = {
      ...base,
      compendium: {
        gid: 'g1',
        rowKey: 'Source',
        snapshotAt: '2026-11-04T00:00:00Z',
        snapshot: { plain: 'Source', runs: [{ text: 'Source' }] },
      },
    };
    await act(async () => root.render(<Probe drafts={{ [base.hash]: { base, next } }} />));
    expect(latest!.matches).toBeUndefined();
    expect(latest!.prepared).toBeUndefined();
    expect(latest!.reviewPrepared).toBe(first);
    expect(latest!.loading).toBe(true);
    await act(async () => finish({ matches: new Map(), decisions: [] }));
    expect(latest!.matches?.size).toBe(0);
  } finally {
    await act(async () => root.unmount());
  }
});
