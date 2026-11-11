// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VariantWorkspace } from './VariantWorkspace';
import { RightPane, RightPaneHeader } from '../../ui/RightPane';
import { useSettingsStore } from '../../stores/settings';
import { useReportsTab } from '../reports/pane/tabStore';

let host: HTMLDivElement;
let root: Root;
let width: number;
let reportRenders: number;

function Reports() {
  reportRenders++;
  return (
    <RightPane label="Reports pane" header={<RightPaneHeader title="Reports" />}>
      Reports body
    </RightPane>
  );
}
const Compendium = () => (
  <RightPane label="Compendium pane" header={<RightPaneHeader title="Compendium" />}>
    Sheet
  </RightPane>
);
const render = (count: number | null = 2) =>
  act(() =>
    root.render(
      <VariantWorkspace
        editor={<div>Editor</div>}
        compendium={<Compendium />}
        reports={{ pane: <Reports />, count }}
      />,
    ),
  );
const paneTab = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('[data-pane-tab]')].find((button) =>
    button.textContent?.startsWith(name),
  );
const panes = () =>
  [...host.querySelectorAll('aside')].map((pane) => pane.getAttribute('aria-label'));

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => void values.set(name, value),
    removeItem: (name: string) => void values.delete(name),
  });
  useSettingsStore.setState({
    device: { ...useSettingsStore.getState().device, panes: {}, remembered: {} },
  });
  useReportsTab.setState({ open: false, focusToken: 0 });
  width = 1016;
  reportRenders = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ width, left: 0 }) as DOMRect,
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Reports tab in the right pane', () => {
  it('labels the tab from the index count and renders nothing while it is closed', () => {
    render(2);
    expect(panes()).toEqual(['Compendium pane']);
    expect(paneTab('Reports')?.textContent).toBe('Reports 2');
    // Typing re-renders the workspace: the closed Reports pane never renders.
    render(2);
    render(2);
    expect(reportRenders).toBe(0);
    render(0);
    expect(paneTab('Reports')?.textContent).toBe('Reports');
  });

  it('opens on its tab, stays open across re-renders (stepping), and gives the pane back', () => {
    render();
    act(() => paneTab('Reports')!.click());
    expect(panes()).toEqual(['Reports pane']);
    expect(useReportsTab.getState().open).toBe(true);
    // The next tooltip (a new render with another count) keeps the tab.
    render(0);
    expect(panes()).toEqual(['Reports pane']);
    act(() => paneTab('Compendium')!.click());
    expect(panes()).toEqual(['Compendium pane']);
    expect(useReportsTab.getState().open).toBe(false);
    // Reports never becomes the remembered English/Compendium pick.
    expect(useSettingsStore.getState().device.remembered.translatePane).toBeUndefined();
  });

  it('Alt+R opens the tab and asks the pane to focus its first report', () => {
    render();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', altKey: true, bubbles: true }),
      );
    });
    expect(panes()).toEqual(['Reports pane']);
    expect(useReportsTab.getState().focusToken).toBe(1);
  });

  it('on a phone: a fourth tab, mounted only while it is the open view', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 700px)',
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    width = 390;
    render(3);
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Editor', 'Compendium', 'Reports 3']);
    expect(tabs[2]!.getAttribute('aria-label')).toBe('Reports, 3 open');
    expect(reportRenders).toBe(0);
    act(() => tabs[2]!.click());
    expect(host.querySelector('[data-panel="reports"]')?.getAttribute('data-active')).toBe('true');
    expect(host.querySelector('[data-panel="reports"]')?.textContent).toContain('Reports body');
    act(() => tabs[0]!.click());
    expect(host.querySelector('[data-panel="reports"]')?.childElementCount).toBe(0);
  });
});
