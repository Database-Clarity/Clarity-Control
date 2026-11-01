// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { ReviewQueue } from './MatchReviewPage';
import { useCompendiumStore } from './store';
import { useAuthStore } from '../../stores/auth';
import { useDraftStore } from '../../stores/drafts';
import { useSaveState } from '../../services/save/state';
import { useSidebarQueueStore } from '../navigation/sidebarQueue';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl } from '../../services/compendium';

const captured = vi.hoisted(() => ({ proposals: new Map() }));
vi.mock('./useProposals', () => ({
  useProposals: () => ({ proposals: captured.proposals, loading: false }),
}));
vi.mock('../../services/draftStorage', () => ({
  draftStorage: { read: async () => ({}), write: async () => {} },
}));

const property = '--review-action-bar-height';
const originals = {
  auth: useAuthStore.getState(),
  drafts: useDraftStore.getState(),
  save: useSaveState.getState(),
  compendium: useCompendiumStore.getState(),
  sidebar: useSidebarQueueStore.getState(),
};
let host: HTMLDivElement;
let root: Root;
let fixture: ReturnType<typeof guidedFixture>;
let height: number;
let closed: boolean;
const observers: {
  notify: () => void;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}[] = [];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture = guidedFixture();
  fixture.document.scope = `${bundleUrl}|${compendiumDataUrl}`;
  captured.proposals = fixture.proposals;
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('__review-guidance') && !init?.method)
        return Response.json({ document: fixture.document, revision: 'synthetic' });
      throw new Error(`Blocked fixture request: ${url}`);
    }),
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(notify: () => void) {
        observers.push({ notify, observe: this.observe, disconnect: this.disconnect });
      }
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  height = 197;
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.matches('footer[aria-label="Review actions"]'))
      return DOMRect.fromRect({ height: this.isConnected ? height : 0 });
    return originalRect.call(this);
  });
  useAuthStore.setState({ user: null, loading: false });
  useDraftStore.setState({ drafts: {}, hydrated: true });
  useSaveState.setState({ locked: false, review: null });
  useCompendiumStore.setState({ data: fixture.source, loading: false });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  closed = false;
  observers.length = 0;
});

afterEach(async () => {
  if (!closed) await act(async () => root.unmount());
  host.remove();
  useAuthStore.setState(originals.auth);
  useDraftStore.setState(originals.drafts);
  useSaveState.setState(originals.save);
  useCompendiumStore.setState(originals.compendium);
  useSidebarQueueStore.setState(originals.sidebar);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(initial = '/compendium/review') {
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [initial] },
        createElement(
          'article',
          null,
          createElement(ReviewQueue, {
            editor: fixture.editor,
            source: fixture.source,
            storageKey: 'synthetic-footer',
          }),
        ),
      ),
    ),
  );
}

async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((node) =>
    node.textContent?.trim().startsWith(text),
  );
  if (!button) throw new Error(`Missing fixture button: ${text}`);
  await act(async () => button.click());
}

const page = () => host.querySelector('article')!;
const footer = () => host.querySelector('footer[aria-label="Review actions"]')!;

describe.each([true, false])('conditional footer with ResizeObserver=%s', (observed) => {
  it('tracks category -> entries -> category -> entries, both overlays and full cleanup', async () => {
    if (!observed) vi.stubGlobal('ResizeObserver', undefined);
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    await mount();
    page().style.setProperty(property, '17px', 'important');
    const priority = page().style.getPropertyPriority(property);
    expect(footer()).toBeNull();
    expect(observers).toHaveLength(0);
    await click('Review all one by one');
    const first = footer();
    expect(page().style.getPropertyValue(property)).toBe('197px');
    if (observed) expect(observers[0].observe).toHaveBeenCalledWith(first, { box: 'border-box' });
    await click('Pick other');
    expect(host.querySelector('[aria-label="Pick another source"]')).not.toBeNull();
    await click('Close picker');
    await click('Bulk preview');
    expect(host.querySelector('[aria-label="Bulk accept preview"]')).not.toBeNull();
    await click('Cancel');
    await click('Back to category guidance');
    expect(first.isConnected).toBe(false);
    expect(page().style.getPropertyValue(property)).toBe('17px');
    expect(page().style.getPropertyPriority(property)).toBe(priority);
    if (observed) {
      expect(observers[0].disconnect).toHaveBeenCalledOnce();
      observers[0].notify();
      expect(page().style.getPropertyValue(property)).toBe('17px');
    }
    await click('Review all one by one');
    expect(footer()).not.toBe(first);
    expect(page().style.getPropertyValue(property)).toBe('197px');
    if (observed) {
      expect(observers[1].observe).toHaveBeenCalledWith(footer(), { box: 'border-box' });
      observers[0].notify();
      expect(page().style.getPropertyValue(property)).toBe('197px');
    }
    height = 101;
    if (observed) observers[1].notify();
    else window.dispatchEvent(new Event('resize'));
    expect(page().style.getPropertyValue(property)).toBe('101px');
    await click('Pick other');
    await click('Close picker');
    await click('Bulk preview');
    const article = page();
    await act(async () => root.unmount());
    closed = true;
    expect(article.style.getPropertyValue(property)).toBe('17px');
    expect(article.style.getPropertyPriority(property)).toBe(priority);
    if (observed) {
      expect(observers[1].disconnect).toHaveBeenCalledOnce();
      observers.forEach((observer) => observer.notify());
      expect(article.style.getPropertyValue(property)).toBe('17px');
    } else {
      const listeners = add.mock.calls.filter(([event]) => event === 'resize');
      expect(listeners).toHaveLength(2);
      for (const [, listener] of listeners) expect(remove).toHaveBeenCalledWith('resize', listener);
      window.dispatchEvent(new Event('resize'));
      expect(article.style.getPropertyValue(property)).toBe('17px');
    }
    expect(useDraftStore.getState().drafts).toEqual({});
  });
});

it('replaces a direct-entry observer and clears an otherwise unowned reservation', async () => {
  await mount('/compendium/review?view=entries&hash=100');
  expect(page().style.getPropertyValue(property)).toBe('197px');
  const old = footer();
  await click('Back to category guidance');
  expect(page().style.getPropertyValue(property)).toBe('');
  await click('Review all one by one');
  expect(footer()).not.toBe(old);
  expect(observers[0].disconnect).toHaveBeenCalledOnce();
  observers[0].notify();
  expect(page().style.getPropertyValue(property)).toBe('197px');
  const article = page();
  await act(async () => root.unmount());
  closed = true;
  observers[1].notify();
  expect(article.style.getPropertyValue(property)).toBe('');
});
