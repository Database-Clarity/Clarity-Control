// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createMemoryRouter,
  RouterProvider,
  useBlocker,
  useLocation,
  type RouterProviderProps,
} from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { DriftPage } from '../drift/DriftPage';
import { useDataStore, type EditorData } from '../../stores/data';
import { useAuthStore } from '../../stores/auth';
import type { User } from '../../services/api';
import { WorkThroughControl } from './QueueControl';
import { resetWorkQueues, useWorkQueues } from './store';
import { useWorkThrough } from './useQueue';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const names: Record<number, string> = { 11: 'Alpha', 12: 'Beta', 13: 'Gamma' };
function tooltip(hash: number, snapshot: string): Tooltip {
  return {
    hash,
    associated: [],
    text: {
      en: { text: `English ${hash}`, updatedAt: '2026-02-01T00:00:00.000Z', updatedBy: 'x' },
    },
    bungieSnapshot: { description: snapshot, snapshotAt: '2026-01-01T00:00:00.000Z' },
  };
}
function build(reviewed: number[] = []): EditorData {
  return {
    categories: [{ id: 'perks', label: 'Perks', group: 'Weapons', order: 1 }],
    items: Object.fromEntries(
      Object.entries(names).map(([hash, name]) => [
        hash,
        { hash: Number(hash), name, icon: '', categoryId: 'perks', inGameDescription: 'New' },
      ]),
    ),
    aliases: {},
    bundle: {
      sourceCommit: 'abc',
      generatedAt: '2026-02-01T00:00:00Z',
      tooltips: Object.fromEntries(
        Object.keys(names).map((hash) => [
          hash,
          tooltip(Number(hash), reviewed.includes(Number(hash)) ? 'New' : 'Old'),
        ]),
      ),
      permissions: { users: {} },
      pushed: {},
    },
  } as unknown as EditorData;
}

let host: HTMLDivElement;
let root: Root;
let router: RouterProviderProps['router'];
let location: ReturnType<typeof useLocation>;

/** The editor route, reduced to the work-through control fed the way TooltipPage feeds it. */
let blocking = false;
function Editor() {
  location = useLocation();
  // The editor's leave guard, reduced to refusing every navigation while `blocking` is set.
  useBlocker(() => blocking);
  const work = useWorkThrough(location.state);
  return <div data-editor>{work && <WorkThroughControl work={work} />}</div>;
}
function List() {
  location = useLocation();
  return <DriftPage />;
}

beforeEach(() => {
  blocking = false;
  resetWorkQueues();
  useDataStore.setState({ data: build() });
  useAuthStore.setState({ user: { login: 'person', role: 'editor' } as unknown as User });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  router = createMemoryRouter(
    [
      { path: '/drift', element: <List /> },
      { path: '/t/:hash', element: <Editor /> },
    ],
    { initialEntries: ['/drift'] },
  );
  act(() => root.render(<RouterProvider router={router} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const button = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (entry) =>
      entry.textContent?.includes(text) || entry.getAttribute('aria-label')?.includes(text),
  );
const link = (label: string) =>
  [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
    (entry) => entry.getAttribute('aria-label')?.startsWith(label) || entry.textContent === label,
  );
const check = (name: string) =>
  host.querySelector<HTMLInputElement>(`input[aria-label="Select ${name}"]`)!;
const position = () => host.querySelector('[data-queue] [role="status"]')?.textContent;

describe('work through Bungie drift', () => {
  it('selected rows: frozen order, skip, done, finish, Leave restores the selection', async () => {
    act(() => check('Alpha').click());
    act(() => check('Gamma').click());
    expect(button('Work through all 3 shown')).toBeDefined();
    await act(async () => button('Work through 2 selected')!.click());
    expect(location.pathname).toBe('/t/11');
    expect(position()).toBe('1 of 2');
    // Focus lands on the queue (its position menu).
    expect(document.activeElement).toBe(host.querySelector('[data-queue] button[aria-haspopup]'));
    // No Previous before the first item.
    expect(
      host.querySelector('[aria-label="Previous in queue"][aria-disabled="true"]'),
    ).not.toBeNull();

    // Alt+PageDown presses Next: the open item passed by Next is skipped.
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', altKey: true })),
    );
    expect(location.pathname).toBe('/t/13');
    expect(position()).toBe('2 of 2');
    expect(Object.values(useWorkQueues.getState().queues)[0]!.skipped).toEqual(['11']);

    // A newly drifting row never joins; a finished one reads "Done".
    act(() => useDataStore.setState({ data: build([13]) }));
    expect(position()).toBe('Done · 1 left');

    // Next on the last item ends the queue there.
    act(() => button('›')!.click());
    expect(position()).toBe('End · 1 skipped');
    expect(link('Revisit')).toBeDefined();

    await act(async () => link('Bungie drift')!.click());
    expect(location.pathname).toBe('/drift');
    // Focus returns to the bar the queue started from.
    expect(document.activeElement?.closest('[aria-label="Work through"]')).not.toBeNull();
    expect(check('Alpha').checked).toBe(true);
    expect(check('Beta')).toBeDefined();
    expect(check('Beta').checked).toBe(false);
    expect(useWorkQueues.getState().active).toBeNull();
  });

  it('an ordinary visit pauses the queue; Resume returns to its item; Back finds the queue', async () => {
    await act(async () => button('Work through all 3 shown')!.click());
    expect(position()).toBe('1 of 3');
    await act(async () => link('Next in queue')!.click());
    expect(position()).toBe('2 of 3');
    // The finder or a link: an ordinary visit, no Previous or Next.
    await act(async () => router.navigate('/t/13'));
    expect(host.querySelector('[aria-label^="Next in queue"]')).toBeNull();
    expect(host.textContent).toContain('Bungie drift · paused');
    await act(async () => link('Resume')!.click());
    expect(location.pathname).toBe('/t/12');
    expect(position()).toBe('2 of 3');
    // Back and Forward keep the queue (history state names it).
    await act(async () => router.navigate(-1));
    expect(location.pathname).toBe('/t/13');
    await act(async () => router.navigate(-1));
    expect(location.pathname).toBe('/t/12');
    expect(position()).toBe('2 of 3');
  });

  it('Rebuild queue in the menu, then Escape, keeps the page working', async () => {
    // Chrome's scrollIntoView returns a promise: an effect must never hand it back as a cleanup.
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = () => Promise.resolve() as unknown as void;
    onTestFinished(() => {
      Element.prototype.scrollIntoView = original;
    });
    act(() => check('Alpha').click());
    await act(async () => button('Work through 1 selected')!.click());
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-queue] button[aria-haspopup]')!.click(),
    );
    const rebuild = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (entry) => entry.textContent === 'Rebuild queue',
    )!;
    await act(async () => rebuild.click());
    for (let wait = 0; wait < 100 && !document.body.textContent?.includes('Rebuilt'); wait++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(document.body.textContent).toContain('Rebuilt: 1 items, 0 new, 0 gone.');
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(position()).toBe('1 of 1');
  });

  it('End stops the paused queue', async () => {
    await act(async () => button('Work through all 3 shown')!.click());
    await act(async () => router.navigate('/t/12'));
    act(() => button('End')!.click());
    expect(host.querySelector('[data-queue]')).toBeNull();
  });

  it('Leave and Revisit change the queue only once their navigation lands', async () => {
    await act(async () => button('Work through all 3 shown')!.click());
    const id = useWorkQueues.getState().active;
    expect(id).not.toBeNull();

    // A refused Leave (the leave guard says no) keeps the queue working where it was.
    blocking = true;
    await act(async () => link('Bungie drift')!.click());
    expect(location.pathname).toBe('/t/11');
    expect(useWorkQueues.getState().active).toBe(id);
    expect(position()).toBe('1 of 3');

    // A modified click opens another tab: this tab's queue stays as it is.
    blocking = false;
    // (jsdom cannot open the tab itself.)
    const noTab = (event: Event) => event.preventDefault();
    host.addEventListener('click', noTab);
    onTestFinished(() => host.removeEventListener('click', noTab));
    await act(async () => {
      link('Bungie drift')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
      );
    });
    expect(location.pathname).toBe('/t/11');
    expect(useWorkQueues.getState().active).toBe(id);

    // Next to the end, then a refused Revisit leaves it ended; an accepted one reopens it.
    await act(async () => link('Next in queue')!.click());
    await act(async () => link('Next in queue')!.click());
    act(() => button('›')!.click());
    expect(position()).toBe('End · 3 skipped');
    blocking = true;
    await act(async () => link('Revisit')!.click());
    expect(useWorkQueues.getState().queues[id!]!.finished).toBe(true);
    blocking = false;
    await act(async () => link('Revisit')!.click());
    expect(location.pathname).toBe('/t/11');
    expect(useWorkQueues.getState().queues[id!]!.finished).toBe(false);
    expect(position()).toBe('1 of 3');

    // An accepted Leave ends it once the list is reached; Back to the entry does not restart it.
    await act(async () => link('Bungie drift')!.click());
    expect(location.pathname).toBe('/drift');
    expect(useWorkQueues.getState().active).toBeNull();
  });
});
