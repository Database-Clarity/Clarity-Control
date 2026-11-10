// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { QueueControl } from './QueueControl';
import { TranslationsPage } from '../translations/TranslationsPage';
import { queueContext } from '../translations/worklist';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import type { User } from '../../services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const stamp = { updatedBy: 'x' };
function tooltip(hash: number, source?: string): Tooltip {
  return {
    hash,
    associated: [],
    text: {
      en: { text: `English ${hash}`, updatedAt: '2026-02-01T00:00:00.000Z', ...stamp },
      ...(source
        ? { de: { text: 'Zwei', updatedAt: source, sourceUpdatedAt: source, ...stamp } }
        : {}),
    },
  };
}
const categories = [
  { id: 'perks', label: 'Perks', group: 'Weapons', order: 1 },
  { id: 'mods', label: 'Mods', group: 'Armor', order: 2 },
];
const names: Record<number, [string, string]> = {
  1: ['Zeta Perk', 'perks'],
  2: ['Old Perk', 'perks'],
  3: ['Current Perk', 'perks'],
  4: ['Alpha Mod', 'mods'],
  5: ['Older Mod', 'mods'],
  6: ['Beta Perk', 'perks'],
};
function build(tooltips: Tooltip[]): EditorData {
  return {
    categories,
    items: Object.fromEntries(
      Object.entries(names).map(([hash, [name, categoryId]]) => [
        hash,
        { hash: Number(hash), name, icon: '', categoryId, inGameDescription: '' },
      ]),
    ),
    aliases: {},
    bundle: {
      sourceCommit: 'abc',
      generatedAt: '2026-02-01T00:00:00Z',
      tooltips: Object.fromEntries(tooltips.map((entry) => [entry.hash, entry])),
      permissions: { users: {} },
      pushed: {},
    },
  };
}
const current = '2026-02-01T00:00:00.000Z';
const initial = () => [
  tooltip(1),
  tooltip(2, '2026-01-20T00:00:00.000Z'),
  tooltip(3, current),
  tooltip(4),
  tooltip(5, '2026-01-01T00:00:00.000Z'),
  tooltip(6),
];
const editor = { login: 'person', role: 'editor' } as unknown as User;

let host: HTMLDivElement;
let root: Root;
let location: ReturnType<typeof useLocation>;

function Probe() {
  location = useLocation();
  return null;
}
/** The editor route, reduced to the queue control fed the way TooltipPage feeds it. */
function Editor() {
  const hash = Number(useParams().hash);
  const user = useAuthStore((state) => state.user);
  const { search, state } = useLocation();
  const context = queueContext(new URLSearchParams(search), state, user);
  return context ? <QueueControl hash={hash} context={context} /> : <p>Ordinary visit</p>;
}
async function mount(path: string, tooltips = initial()) {
  useDataStore.setState({ status: 'ready', data: build(tooltips) });
  useAuthStore.setState({ user: editor, loading: false });
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Probe />
        <Routes>
          <Route path="/translations" element={<TranslationsPage />} />
          <Route path="/t/:hash" element={<Editor />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}
const rows = () => [...host.querySelectorAll<HTMLAnchorElement>('li[data-index] a')];
const position = () => host.querySelector('[data-queue] [role=status]')?.textContent;
const link = (label: string) =>
  host.querySelector<HTMLAnchorElement>(`[data-queue] a[aria-label^="${label}"]`);
const click = (element: Element) => act(async () => (element as HTMLElement).click());
const save = (hash: number) =>
  act(async () =>
    useDataStore.setState({
      data: build(initial().map((entry) => (entry.hash === hash ? tooltip(hash, current) : entry))),
    }),
  );

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => setTimeout(run, 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useAuthStore.setState({ user: null, loading: false });
  vi.unstubAllGlobals();
});

describe('queue control', () => {
  it.each(['/translations', '/translations?cat=perks', '/translations?q=perk&state=missing'])(
    'steps through exactly the rows of the Translations tab, in its order: %s',
    async (path) => {
      await mount(path);
      const listed = rows().map((row) => row.getAttribute('href'));
      expect(listed.length).toBeGreaterThan(1);
      await click(rows()[0]!);
      const visited = [`${location.pathname}${location.search}`];
      expect(link('Previous in queue')).toBeNull();
      for (let next = link('Next in queue'); next; next = link('Next in queue')) {
        expect(position()).toBe(`${visited.length} of ${listed.length}`);
        await click(next);
        visited.push(`${location.pathname}${location.search}`);
      }
      expect(visited).toEqual(listed);
      expect(position()).toBe(`${listed.length} of ${listed.length}`);
      // And back again: Previous retraces it.
      for (let back = link('Previous in queue'); back; back = link('Previous in queue'))
        await click(back);
      expect(`${location.pathname}${location.search}`).toBe(listed[0]);
      // The way back restores the same view.
      await click(host.querySelector('[data-queue] a[href^="/translations"]')!);
      expect(`${location.pathname}${location.search}`).toBe(path);
      expect(rows().map((row) => row.getAttribute('href'))).toEqual(listed);
    },
  );

  it('exists only in queue mode', async () => {
    await mount('/t/2?lang=de');
    expect(host.textContent).toBe('Ordinary visit');
  });

  it('drops a saved tooltip from the list at once and goes on to what followed it', async () => {
    // Queue: outdated 5 (oldest), 2; then missing 6, 1 (Perks by name), 4 (Mods).
    await mount('/translations');
    expect(rows().map((row) => row.getAttribute('href')!.slice(3, 4))).toEqual([
      '5',
      '2',
      '6',
      '1',
      '4',
    ]);
    await click(rows()[1]!);
    expect(position()).toBe('2 of 5');
    await save(2);
    expect(position()).toBe('Done · 4 left');
    expect(link('Next in queue')?.getAttribute('href')).toBe('/t/6?lang=de');
    expect(link('Previous in queue')?.getAttribute('href')).toBe('/t/5?lang=de');
    await click(link('Next in queue')!);
    expect(position()).toBe('2 of 4');
    // Saving the last entry leaves nothing after it; saving everything ends the queue.
    await click(link('Next in queue')!);
    await click(link('Next in queue')!);
    expect(position()).toBe('4 of 4');
    expect(link('Next in queue')).toBeNull();
    await act(async () =>
      useDataStore.setState({
        data: build(initial().map((entry) => tooltip(entry.hash, current))),
      }),
    );
    expect(position()).toBe('Queue done');
    expect(host.querySelector('[data-queue] [role=link]')).toBeNull();
    expect(host.querySelector('[data-queue] a')?.getAttribute('href')).toBe('/translations');
  });

  it('opens an entry that is not in the queue without an error, offering the first row', async () => {
    await mount('/translations');
    await click(rows()[0]!);
    await save(5);
    expect(position()).toBe('Done · 4 left');
    // A reload forgets where the tooltip was: Next starts at the top of what is left.
    await act(async () => root.unmount());
    root = createRoot(host);
    useDataStore.setState({
      data: build(initial().map((entry) => (entry.hash === 5 ? tooltip(5, current) : entry))),
    });
    await act(async () =>
      root.render(
        <MemoryRouter
          initialEntries={[{ pathname: '/t/5', search: '?lang=de', state: location.state }]}
        >
          <Probe />
          <Routes>
            <Route path="/t/:hash" element={<Editor />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    expect(position()).toBe('Not in queue · 4 left');
    expect(link('Previous in queue')).toBeNull();
    expect(link('Next in queue')?.getAttribute('href')).toBe('/t/2?lang=de');
  });

  it('steps with Alt+PageDown and Alt+PageUp, and leaves other keys alone', async () => {
    await mount('/translations');
    await click(rows()[0]!);
    const press = (init: KeyboardEventInit) =>
      act(async () => {
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
        window.dispatchEvent(event);
        return event;
      });
    await press({ key: 'PageDown', altKey: true });
    expect(location.pathname).toBe('/t/2');
    await press({ key: 'PageDown' });
    await press({ key: 'PageDown', altKey: true, shiftKey: true });
    await press({ key: 'PageDown', altKey: true, repeat: true });
    expect(location.pathname).toBe('/t/2');
    await press({ key: 'PageUp', altKey: true });
    expect(location.pathname).toBe('/t/5');
    await press({ key: 'PageUp', altKey: true });
    expect(location.pathname).toBe('/t/5');
  });
});

describe('queue control on a phone', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width: 700px'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });

  it('is one stepper: Previous, the position as the way back, Next; Alt+PageDown and Alt+PageUp step', async () => {
    await mount('/translations');
    const total = rows().length;
    await click(rows()[0]!);
    // Only the visible segments are in the joined group (its first and last are the arrows).
    const segments = [...host.querySelectorAll('[data-queue] > *')];
    expect(segments.map((segment) => segment.getAttribute('aria-label'))).toEqual([
      'Previous in queue',
      `Back to the translation queue, 1 of ${total}`,
      expect.stringMatching(/^Next in queue: /),
    ]);
    expect(segments[1]!.textContent).toBe(`1 of ${total}`);
    // The status line stays for screen readers only.
    expect(host.querySelector('[data-queue] [role="status"]')).toBeNull();
    expect(host.querySelector('[role="status"].sr-only')!.textContent).toBe(`1 of ${total}`);
    const press = (init: KeyboardEventInit) =>
      act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
        );
      });
    const status = () => host.querySelector('[role="status"].sr-only')?.textContent;
    await press({ key: 'PageDown', altKey: true });
    expect(location.pathname).toBe('/t/2');
    expect(status()).toBe(`2 of ${total}`);
    await press({ key: 'PageUp', altKey: true });
    expect(status()).toBe(`1 of ${total}`);
    await click(link('Back to the translation queue')!);
    expect(location.pathname).toBe('/translations');
  });
});
