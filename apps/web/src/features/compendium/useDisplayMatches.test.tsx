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
import * as sourceService from '../../services/compendium';

const calls = vi.hoisted(() => ({ display: vi.fn(), prioritize: vi.fn(), prewarm: vi.fn() }));
vi.mock('./matchingSession', async (original) => ({
  ...(await original<typeof import('./matchingSession')>()),
  matchingSession: () => ({ display: calls.display, prioritize: calls.prioritize }),
  prewarmMatchingSession: calls.prewarm,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('publishes a priority reply from idle and cancels stale queued publications', async () => {
  vi.stubEnv('DEV', false);
  vi.stubGlobal('localStorage', { getItem: () => null });
  const idle = new Map<number, IdleRequestCallback>();
  let serial = 0;
  vi.stubGlobal(
    'requestIdleCallback',
    vi.fn((callback: IdleRequestCallback) => {
      idle.set(++serial, callback);
      return serial;
    }),
  );
  vi.stubGlobal(
    'cancelIdleCallback',
    vi.fn((id: number) => idle.delete(id)),
  );
  const f = guidedFixture();
  const matches = new Map();
  calls.prioritize.mockReset().mockResolvedValue(matches);
  calls.display.mockReset().mockReturnValue(new Promise(() => undefined));
  let latest: ReturnType<typeof useDisplayMatches>;
  function Probe({ hash }: { hash: number }) {
    latest = useDisplayMatches(f.editor, f.source, {}, 'idle-priority', hash);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe hash={100} />));
    expect(latest!.matches).toBeUndefined();
    expect(latest!.loading).toBe(true);
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 50 });
    const stale = [...idle.values()][0];
    await act(async () => root.render(<Probe hash={200} />));
    expect(cancelIdleCallback).toHaveBeenCalledWith(1);
    await act(async () => stale({ didTimeout: false, timeRemaining: () => 5 }));
    expect(latest!.matches).toBeUndefined();
    await act(async () => [...idle.values()][0]({ didTimeout: false, timeRemaining: () => 5 }));
    expect(latest!.matches).toBe(matches);
    expect(latest!.loading).toBe(false);
    expect(latest!.prepared).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
  }
});

it('holds priority and full results through editor input until a quiet idle gap', async () => {
  vi.stubEnv('DEV', false);
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const idle: IdleRequestCallback[] = [];
  vi.stubGlobal(
    'requestIdleCallback',
    vi.fn((callback: IdleRequestCallback) => idle.push(callback)),
  );
  vi.stubGlobal('cancelIdleCallback', vi.fn());
  let pending = false;
  vi.stubGlobal('navigator', { scheduling: { isInputPending: () => pending } });
  const f = guidedFixture();
  const matches = new Map();
  const value = { matches, decisions: [] };
  let finish!: (value: unknown) => void;
  calls.prioritize.mockReset().mockResolvedValue(matches);
  calls.display.mockReset().mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  let latest: ReturnType<typeof useDisplayMatches>;
  function Probe() {
    latest = useDisplayMatches(f.editor, f.source, {}, 'typing-quiet', 100);
    return null;
  }
  const editor = document.createElement('div');
  editor.className = 'cm-content';
  document.body.append(editor);
  const root = createRoot(document.createElement('div'));
  const deadline = { didTimeout: false, timeRemaining: () => 5 };
  try {
    await act(async () => root.render(<Probe />));
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await act(async () => idle.shift()!(deadline));
    expect(latest!.loading).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(299));
    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true }));
    await act(async () => finish(value));
    // A complete result must not escape the quiet gate through the memory cache.
    await act(async () => root.render(<Probe />));
    expect(latest!.prepared).toBeUndefined();
    expect(latest!.matches).toBeUndefined();
    await act(async () => vi.advanceTimersByTimeAsync(299));
    expect(idle).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    pending = true;
    await act(async () => idle.shift()!(deadline));
    expect(latest!.loading).toBe(true);
    pending = false;
    await act(async () => vi.advanceTimersByTimeAsync(16));
    await act(async () => idle.shift()!(deadline));
    expect(latest!.prepared).toBe(value);
    expect(latest!.matches).toBe(matches);
    expect(latest!.loading).toBe(false);
  } finally {
    await act(async () => root.unmount());
    editor.remove();
    vi.useRealTimers();
  }
});

it('queues the current tooltip before source hydration and publishes only after the source is bound', async () => {
  vi.stubEnv('DEV', false);
  vi.stubGlobal('localStorage', { getItem: () => null });
  const f = guidedFixture();
  const bridge = {} as NonNullable<ReturnType<typeof sourceService.pendingCompendiumWorker>>;
  vi.spyOn(sourceService, 'pendingCompendiumWorker').mockReturnValue(bridge);
  const matches = new Map([
    [
      100,
      {
        status: 'ok' as const,
        changed: false,
        tab: f.source.tabs[0],
        row: f.source.tabs[0].rows[0],
      },
    ],
  ]);
  calls.prioritize.mockReset().mockResolvedValue(matches);
  calls.prewarm.mockReset().mockReturnValue({ prioritize: calls.prioritize });
  calls.display.mockReset().mockReturnValue(new Promise(() => undefined));
  let latest: ReturnType<typeof useDisplayMatches>;
  function Probe({ source }: { source: typeof f.source | null }) {
    latest = useDisplayMatches(f.editor, source, {}, 'early-intent', 100);
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Probe source={null} />));
    expect(calls.prewarm).toHaveBeenCalledWith(f.editor, bridge);
    expect(calls.prioritize).toHaveBeenCalledTimes(1);
    expect(latest!.matches).toBeUndefined();
    expect(calls.display).not.toHaveBeenCalled();
    await act(async () => root.render(<Probe source={f.source} />));
    expect(latest!.matches).toBe(matches);
    expect(latest!.loading).toBe(false);
    expect(latest!.prepared).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
  }
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
