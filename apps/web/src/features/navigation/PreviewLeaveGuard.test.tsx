// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, Link, Outlet, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { reviewKey, usePreviewReviewStore } from '../../stores/previewReview';
import { useDraftStore } from '../../stores/drafts';
import { useDataStore, type EditorData } from '../../stores/data';
import { workspaceShortcutsBlocked } from '../../ui/interaction';
import { PreviewLeaveGuard } from './PreviewLeaveGuard';

type Router = ReturnType<typeof createMemoryRouter>;
let host: HTMLDivElement;
let root: Root;
let router: Router;
let show: Mock<() => void>;
let stopHost: () => void;

function Shell() {
  return (
    <>
      <PreviewLeaveGuard />
      <Link to="/review">Review</Link>
      <Link to="/t/12">Next item</Link>
      <Link to="/t/11">Variant</Link>
      <Outlet />
    </>
  );
}
function mount(entries: string[]) {
  router = createMemoryRouter(
    [
      {
        element: <Shell />,
        children: [
          { path: '/', element: <p>Start</p> },
          { path: '/t/:hash', element: <p>Item</p> },
          { path: '/review', element: <p>Review page</p> },
          { path: '/settings', element: <p>Settings</p> },
        ],
      },
    ],
    { initialEntries: entries, initialIndex: entries.length - 1 },
  );
  act(() => root.render(<RouterProvider router={router} />));
}
const path = () => router.state.location.pathname;
const dialog = () => host.querySelector('dialog');
const button = (name: string) =>
  [...host.querySelectorAll('button, a')].find((element) => element.textContent?.replace(/(Enter|Esc)$/, '') === name) as
    | HTMLElement
    | undefined;
function click(name: string) {
  act(() => {
    button(name)!.click();
  });
}
async function go(action: () => void | Promise<void>) {
  await act(async () => {
    await action();
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const values = new Map<string, string>([
    [reviewKey('anonymous'), JSON.stringify({ 10: { canonical: 10, dirty: 2, reviewed: 1 } })],
  ]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  });
  // jsdom has no modal dialogs: model the part the guard and the shortcut check rely on.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  useDataStore.setState({
    data: {
      items: {
        10: { hash: 10, name: 'Demolitionist', categoryId: 'a', icon: '', enhancedHashes: [11] },
        11: { hash: 11, name: 'Enhanced', categoryId: 'a', icon: '', baseHash: 10 },
      },
      aliases: {},
      categories: [],
      bundle: { tooltips: {}, sourceCommit: 'abc' },
    } as unknown as EditorData,
  });
  useDraftStore.setState({ hydrated: true, drafts: {}, owner: null });
  usePreviewReviewStore.setState({ scope: null, entries: {}, prompt: null, host: null });
  show = vi.fn<() => void>();
  stopHost = usePreviewReviewStore.getState().registerHost({ show });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: false, media: query }),
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  stopHost();
  delete (window as { matchMedia?: unknown }).matchMedia;
  vi.unstubAllGlobals();
});

describe('PreviewLeaveGuard', () => {
  it('lets an item with nothing unreviewed be left freely', async () => {
    mount(['/t/12']);
    await go(() => router.navigate('/review'));
    expect(path()).toBe('/review');
    expect(dialog()).toBeNull();
  });

  it('restores the unreviewed change after a reload and blocks a link before the page unmounts', async () => {
    mount(['/t/10']);
    expect(usePreviewReviewStore.getState().unreviewed(10)).toEqual([10]);
    click('Review');
    expect(path()).toBe('/t/10');
    expect(host.textContent).toContain('Item');
    expect(dialog()?.hasAttribute('open')).toBe(true);
    expect(dialog()?.textContent).toContain('Your changes to Demolitionist');
    expect(button('Show preview')?.hasAttribute('autofocus')).toBe(true);
  });

  it('offers only Show preview and Stay, and Stay resets without replaying the target', async () => {
    mount(['/t/10']);
    click('Review');
    const names = [...dialog()!.querySelectorAll('footer button')].map((item) => item.textContent);
    expect(names).toEqual(['Show previewEnter', 'StayEsc']);
    expect(dialog()?.textContent).toContain('Leaving is possible once the preview has been shown.');
    click('Stay');
    expect(dialog()).toBeNull();
    expect(path()).toBe('/t/10');
    expect(show).not.toHaveBeenCalled();
    await go(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(path()).toBe('/t/10');
  });

  it('Escape means Stay, and the compact prompt has no separate close button', async () => {
    mount(['/t/10']);
    click('Review');
    act(() => {
      dialog()!.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(dialog()).toBeNull();
    expect(path()).toBe('/t/10');
    click('Review');
    expect(dialog()!.querySelector('[aria-label="Close dialog"]')).toBeNull();
  });

  it('Show preview stays on the item and then shows the column once the dialog is gone', async () => {
    mount(['/t/10']);
    click('Review');
    show.mockImplementation(() => expect(dialog()).toBeNull());
    click('Show preview');
    expect(path()).toBe('/t/10');
    expect(show).toHaveBeenCalledTimes(1);
    click('Review');
    expect(path()).toBe('/t/10');
  });

  it('allows a deliberate navigation after the preview rendered the change, and re-arms on a later edit', async () => {
    mount(['/t/10']);
    click('Review');
    click('Stay');
    act(() => usePreviewReviewStore.getState().acknowledge(10, 2));
    click('Review');
    expect(path()).toBe('/review');
    expect(dialog()).toBeNull();
    await go(() => router.navigate('/t/10'));
    act(() => {
      usePreviewReviewStore.setState({
        entries: { 10: { canonical: 10, dirty: 3, reviewed: 2 } },
      });
    });
    await go(() => router.navigate('/'));
    expect(path()).toBe('/t/10');
    expect(dialog()).not.toBeNull();
  });

  it('blocks Back, Forward and programmatic navigation, both push and replace', async () => {
    mount(['/', '/t/10']);
    for (const target of ['/review', '/']) {
      await go(() => router.navigate(target));
      expect(path()).toBe('/t/10');
      click('Stay');
    }
    await go(() => router.navigate('/review', { replace: true }));
    expect(path()).toBe('/t/10');
    click('Stay');
    await go(() => router.navigate(-1));
    expect(path()).toBe('/t/10');
    expect(dialog()).not.toBeNull();
    click('Stay');
    expect(dialog()).toBeNull();
    expect(router.state.historyAction).toBe('POP');
  });

  it('does not block moving between an item and its variants, or opening Settings', async () => {
    mount(['/t/10']);
    await go(() => click('Variant'));
    expect(path()).toBe('/t/11');
    expect(dialog()).toBeNull();
    await go(() => router.navigate('/t/10'));
    await go(() => router.navigate('/settings'));
    expect(path()).toBe('/settings');
  });

  it('does not guard phones', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({ matches: query.includes('700px'), media: query }),
    });
    mount(['/t/10']);
    click('Review');
    expect(path()).toBe('/review');
  });

  it('is invisible without a preview host', async () => {
    stopHost();
    mount(['/t/10']);
    usePreviewReviewStore.setState({ entries: { 10: { canonical: 10, dirty: 1, reviewed: 0 } } });
    click('Review');
    expect(path()).toBe('/review');
  });

  it('shows a prompt for a refused stepping gesture and keeps the shortcut check closed while it is open', async () => {
    mount(['/t/10']);
    expect(workspaceShortcutsBlocked(new Event('wheel'))).toBe(false);
    act(() => {
      expect(usePreviewReviewStore.getState().requestLeave('/t/10', '/t/12')).toBe(false);
    });
    expect(dialog()?.hasAttribute('open')).toBe(true);
    expect(workspaceShortcutsBlocked(new Event('wheel'))).toBe(true);
    click('Stay');
    expect(dialog()).toBeNull();
    expect(usePreviewReviewStore.getState().prompt).toBeNull();
    expect(workspaceShortcutsBlocked(new Event('wheel'))).toBe(false);
  });

  it('stops watching the drafts when it unmounts', async () => {
    mount(['/t/10']);
    act(() => root.unmount());
    root = createRoot(host);
    useDraftStore.setState({ drafts: { 12: { base: stub(12, 'a'), next: stub(12, 'b') } } });
    expect(usePreviewReviewStore.getState().entries[12]).toBeUndefined();
  });
});

function stub(hash: number, text: string) {
  return { hash, text: { en: { text, updatedAt: '', updatedBy: '' } }, associated: [] };
}
