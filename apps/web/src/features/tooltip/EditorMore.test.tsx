// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceShortcutsBlocked } from '../../ui/interaction';
import { EditorPaneHeader } from './EditorPaneHeader';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
let pathname = '';
function Probe() {
  pathname = useLocation().pathname;
  return null;
}
const phone = (matches: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: matches && query.includes('max-width: 700px'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function handlers() {
  return {
    onLanguage: vi.fn(),
    onDiscard: vi.fn(),
    onSwitch: vi.fn(),
    onEditOverride: vi.fn(),
    onBack: vi.fn(),
    toggle: vi.fn(),
  };
}
async function mount(spies: ReturnType<typeof handlers>, props: { draft?: boolean } = {}) {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/t/1?lang=de']}>
        <Probe />
        <EditorPaneHeader
          lang="de"
          onLanguage={spies.onLanguage}
          draft={props.draft ?? true}
          saving={false}
          onDiscard={spies.onDiscard}
          reason={null}
          onSwitch={spies.onSwitch}
          overrides={[{ hash: 5, name: 'Adagio Enhanced' }]}
          activeOverride={undefined}
          onEditOverride={spies.onEditOverride}
          onBack={spies.onBack}
          grouped={
            [{ hash: 9, name: 'Nine', enhanced: false, how: 'same name', reason: 'name' }] as never
          }
          markup={{ open: true, toggle: spies.toggle }}
          queue={<span data-queue />}
          queueBack={{ to: '/translations?lang=de', label: 'German, all categories' }}
        />
      </MemoryRouter>,
    ),
  );
}
const q = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector);
const button = (name: string) =>
  [...host.querySelectorAll<HTMLElement>('button, a')].find((element) =>
    (element.getAttribute('aria-label') ?? element.textContent ?? '').startsWith(name),
  );
const click = (element: Element | undefined) =>
  act(async () => void (element as HTMLElement).click());
const openMore = () => click(q('button[aria-label="More editor tools"]')!);

describe('More (phone tool row)', () => {
  it('replaces the inline tools on a phone: language, draft dot, queue, More', async () => {
    phone(true);
    await mount(handlers());
    expect(button('Markup tools')).toBeUndefined();
    expect(button('Discard')).toBeUndefined();
    expect(button('Edit override')).toBeUndefined();
    expect(q('select[aria-label="Language"]')).not.toBeNull();
    expect(q('[aria-label="Unsaved draft"]')).not.toBeNull();
    const more = q('button[aria-label="More editor tools"]')!;
    expect(more.getAttribute('aria-haspopup')).toBe('dialog');
    // The queue stepper and More are one group on the right.
    expect(more.parentElement!.querySelector('[data-queue]')).not.toBeNull();
  });

  it('reaches every moved action with the same handler', async () => {
    phone(true);
    const spies = handlers();
    await mount(spies);
    await openMore();
    // Focus moves into the sheet, onto its first row.
    expect(document.activeElement?.textContent).toBe('Markup barOn');
    expect(
      [...host.querySelectorAll('[role="dialog"] li > button, [role="dialog"] li > a')].map(
        (row) => row.textContent,
      ),
    ).toEqual([
      'Markup barOn',
      'Discard draft',
      'Grouped manifest perks1 ›',
      'Edit override',
      'Back to queueGerman, all categories',
    ]);
    await click(button('Markup bar'));
    expect(spies.toggle).toHaveBeenCalledTimes(1);
    // Discard asks first, in place; Cancel puts the row back with nothing discarded.
    await click(button('Discard this tooltip'));
    expect(spies.onDiscard).not.toHaveBeenCalled();
    expect(document.activeElement?.textContent).toBe('Cancel');
    await click(button('Cancel'));
    expect(spies.onDiscard).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute('aria-label')).toBe("Discard this tooltip's draft");
    await click(button('Discard this tooltip'));
    await click(
      [...host.querySelectorAll<HTMLElement>('[role="dialog"] button')].find(
        (element) => element.textContent === 'Discard',
      ),
    );
    expect(spies.onDiscard).toHaveBeenCalledTimes(1);
    expect(q('[role="dialog"]')).toBeNull();
    await openMore();
    await click(button('Grouped manifest perks'));
    expect(q('[role="dialog"] [data-grouped="9"]')).not.toBeNull();
    await click(button('Edit override'));
    expect(spies.onEditOverride).toHaveBeenCalledWith(5);
    await openMore();
    await click(button('Back to queue'));
    expect(pathname).toBe('/translations');
  });

  it('shows Discard only with a draft, and closes on Escape with focus back on More', async () => {
    phone(true);
    await mount(handlers(), { draft: false });
    const shortcuts = () => workspaceShortcutsBlocked(new KeyboardEvent('keydown'));
    expect(shortcuts()).toBe(false);
    await openMore();
    // While More is open it owns the workspace shortcuts (Alt+PageDown does not step behind it).
    expect(shortcuts()).toBe(true);
    expect(button('Discard')).toBeUndefined();
    await act(
      async () =>
        void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(q('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(q('button[aria-label="More editor tools"]'));
    expect(shortcuts()).toBe(false);
  });

  it('keeps every inline button on desktop', async () => {
    phone(false);
    await mount(handlers());
    expect(q('button[aria-label="More editor tools"]')).toBeNull();
    expect(button('Markup tools')).toBeDefined();
    expect(button('Discard this tooltip')).toBeDefined();
    expect(button('Edit override')).toBeDefined();
  });
});
