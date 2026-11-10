// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VariantWorkspace } from './VariantWorkspace';
import { RightPane, RightPaneHeader } from '../../ui/RightPane';
import { useSettingsStore } from '../../stores/settings';

let host: HTMLDivElement;
let root: Root;
let width: number;
let compendiumRenders: number;
let compendiumEffects: number;

function Compendium() {
  compendiumRenders++;
  return (
    <RightPane label="Compendium pane" header={<RightPaneHeader title="Compendium" />}>
      <span ref={() => void compendiumEffects++}>Sheet</span>
    </RightPane>
  );
}
const English = () => (
  <RightPane
    label="English source"
    header={<RightPaneHeader title="English">Shows</RightPaneHeader>}
  >
    English text
  </RightPane>
);
const render = (options: { compendium?: boolean; source?: boolean } = {}) =>
  act(() =>
    root.render(
      <VariantWorkspace
        editor={<div>Editor</div>}
        source={options.source === false ? undefined : <English />}
        compendium={options.compendium === false ? null : <Compendium />}
      />,
    ),
  );
const tab = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('[data-pane-tab]')].find(
    (button) => button.textContent === name,
  );
const panes = () =>
  [...host.querySelectorAll('aside')].map((pane) => pane.getAttribute('aria-label'));
const remembered = () => useSettingsStore.getState().device.remembered.translatePane;

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
  width = 1016;
  compendiumRenders = compendiumEffects = 0;
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

describe('translate mode right pane', () => {
  it('does no hidden Compendium work on a phone', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 700px)',
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    width = 390;
    render();
    expect(host.querySelector('[data-mode]')?.getAttribute('data-mode')).toBe('phone');
    expect(compendiumRenders).toBe(0);
    expect(compendiumEffects).toBe(0);
  });

  it('shows English alone first, and the hidden Compendium does no work at all', () => {
    render();
    expect(host.querySelector('[data-mode]')?.getAttribute('data-mode')).toBe('split');
    expect(panes()).toEqual(['English source']);
    expect(tab('English')?.getAttribute('aria-selected')).toBe('true');
    expect(tab('Compendium')?.getAttribute('aria-selected')).toBe('false');
    // Typing re-renders the workspace; the Compendium still never renders, mounts, or lays out.
    render();
    render();
    expect(compendiumRenders).toBe(0);
    expect(compendiumEffects).toBe(0);
    expect(host.textContent).not.toContain('Sheet');
    // The "Shows" control stays in the English tab's header.
    expect(host.querySelector('aside')?.textContent).toContain('Shows');
  });

  it('opens the Compendium on its tab, alone, moves focus with it, and remembers the pick', () => {
    render();
    act(() => tab('Compendium')!.click());
    expect(panes()).toEqual(['Compendium pane']);
    expect(compendiumRenders).toBeGreaterThan(0);
    expect(document.activeElement).toBe(tab('Compendium'));
    expect(remembered()).toBe('compendium');
    // A later visit (new workspace) starts on the remembered tab.
    act(() => root.unmount());
    root = createRoot(host);
    render();
    expect(panes()).toEqual(['Compendium pane']);
    // Arrow keys switch back.
    act(() => {
      tab('Compendium')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      );
    });
    expect(panes()).toEqual(['English source']);
    expect(document.activeElement).toBe(tab('English'));
    expect(remembered()).toBe('english');
  });

  it('adds no tabs for a translator (English alone) or for English editing (Compendium alone)', () => {
    useSettingsStore.getState().remember({ translatePane: 'compendium' });
    render({ compendium: false });
    expect(host.querySelector('[data-pane-tab]')).toBeNull();
    expect(panes()).toEqual(['English source']);
    expect(host.querySelector('aside h3')?.textContent).toBe('English');
    render({ source: false });
    expect(host.querySelector('[data-pane-tab]')).toBeNull();
    expect(panes()).toEqual(['Compendium pane']);
  });

  it('keeps the one-panel-at-a-time toggle and phone layouts as they were', () => {
    width = 600;
    render();
    expect(host.querySelector('[data-mode]')?.getAttribute('data-mode')).toBe('toggle');
    expect(host.querySelector('[data-pane-tab]')).toBeNull();
    const toggle = [...host.querySelectorAll<HTMLButtonElement>('[data-toggles] button')].find(
      (button) => button.textContent === 'Compendium',
    )!;
    act(() => toggle.click());
    expect(host.querySelector('[data-view]')?.getAttribute('data-view')).toBe('compendium');
    expect(remembered()).toBe('compendium');
  });
});
