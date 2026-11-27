// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceShortcutsBlocked } from '../../ui/interaction';
import { EditorPaneHeader } from './EditorPaneHeader';
import { fitTools, phoneFit } from './EditorMore';

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
async function mount(
  spies: ReturnType<typeof handlers>,
  props: { draft?: boolean; inactive?: boolean; worklist?: boolean } = {},
) {
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
          overrides={[{ hash: 5, name: 'Adagio Enhanced', enhanced: true }]}
          activeOverride={undefined}
          onEditOverride={spies.onEditOverride}
          onBack={spies.onBack}
          moreControls={
            props.inactive || props.worklist ? (
              <>
                {props.worklist && <button>Add to worklist</button>}
                {props.inactive && <button>Move to Inactive</button>}
              </>
            ) : undefined
          }
          grouped={[{ hash: 9, name: 'Nine', enhanced: false, reason: 'canonical' }]}
          markup={{ open: true, toggle: spies.toggle }}
          queue={<span data-queue />}
          queueBack={{ to: '/translations?lang=de', label: 'German, all categories' }}
        />
      </MemoryRouter>,
    ),
  );
}
const q = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const button = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('button, a')].find((element) =>
    (element.getAttribute('aria-label') ?? element.textContent ?? '').startsWith(name),
  );
const click = (element: Element | undefined) =>
  act(async () => void (element as HTMLElement).click());
const openMore = () => click(q('button[aria-label="More editor tools"]')!);

describe('More (phone tool row)', () => {
  it('keeps a real worklist action in More when it is the only extra control', async () => {
    phone(true);
    await mount(handlers(), { worklist: true });
    expect(button('Add to worklist')).toBeUndefined();
    await openMore();
    expect(button('Add to worklist')).toBeDefined();
  });
  it('keeps the inactive action in More instead of the main phone row', async () => {
    phone(true);
    await mount(handlers(), { inactive: true });
    expect(button('Move to Inactive')).toBeUndefined();
    await openMore();
    expect(button('Move to Inactive')?.closest('[role=dialog]')?.getAttribute('aria-label')).toBe(
      'Editor tools',
    );
  });
  it('replaces the inline tools on a phone: language, draft dot, queue, More', async () => {
    phone(true);
    await mount(handlers());
    expect(button('Markup tools')).toBeUndefined();
    expect(button('Discard')).toBeUndefined();
    expect(button('Edit enhanced')).toBeUndefined();
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
      [...document.querySelectorAll('[role="dialog"] li > button, [role="dialog"] li > a')].map(
        (row) => row.textContent,
      ),
    ).toEqual([
      'Markup barOn',
      'Discard draft',
      'Items and perk effects1 ›',
      'Edit enhanced',
      'Back to queueGerman, all categories',
    ]);
    await click(button('Markup bar'));
    expect(spies.toggle).toHaveBeenCalledTimes(1);
    // Discard asks first, in place; Cancel puts the row back with nothing discarded.
    await click(button('Discard this draft'));
    expect(spies.onDiscard).not.toHaveBeenCalled();
    expect(document.activeElement?.textContent).toBe('Cancel');
    await click(button('Cancel'));
    expect(spies.onDiscard).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Discard this draft');
    await click(button('Discard this draft'));
    await click(
      [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find(
        (element) => element.textContent === 'Discard',
      ),
    );
    expect(spies.onDiscard).toHaveBeenCalledTimes(1);
    expect(q('[role="dialog"]')).toBeNull();
    await openMore();
    await click(button('Items and perk effects'));
    expect(q('[role="dialog"] [data-grouped="9"]')).not.toBeNull();
    await click(button('Edit enhanced'));
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

  it('keeps the everyday buttons inline on desktop; Grouped and the rare actions are in More', async () => {
    phone(false);
    await mount(handlers(), { inactive: true, worklist: true });
    expect(button('Markup tools')).toBeDefined();
    // The shortcut is in the title, not a visible hint.
    expect(button('Markup tools')?.textContent).toBe('Markup tools');
    expect(button('Markup tools')?.title).toContain('Ctrl+.');
    expect(button('Discard this draft')).toBeDefined();
    expect(button('Edit enhanced')).toBeDefined();
    expect(button('Grouped')).toBeUndefined();
    expect(button('Add to worklist')).toBeUndefined();
    expect(button('Move to Inactive')).toBeUndefined();
    await openMore();
    const sheet = q('[role="dialog"][aria-label="Editor tools"]')!;
    expect(sheet.textContent).toContain('Items and perk effects');
    expect(button('Add to worklist')?.closest('[role=dialog]')).toBe(sheet);
    expect(button('Move to Inactive')?.closest('[role=dialog]')).toBe(sheet);
  });
});

describe('inline tools (phone tool row)', () => {
  it('reserves More for a rare action while keeping everyday tools inline when they fit', () => {
    const layout = { gap: 6, headerGap: 6, more: 36, queue: 0, room: 120 };
    expect(phoneFit([60], layout, true)).toBe(1);
    expect(phoneFit([60, 60], layout, true)).toBe(1);
    expect(phoneFit([60], { ...layout, room: 90 }, true)).toBe(0);
    expect(phoneFit([60, 60], { ...layout, queue: 120, room: 130 }, true)).toBe(2);
  });
  it('fits tools in order and never leaves a single tool for More', () => {
    // Everything fits: no More at all.
    expect(fitTools([60, 60, 60], 6, 192, 42)).toBe(3);
    // One tool short: More would hold one, so it takes two.
    expect(fitTools([60, 60, 60], 6, 150, 42)).toBe(1);
    // Room for two beside More: the last two go.
    expect(fitTools([60, 60, 60, 60], 6, 200, 42)).toBe(2);
    // No room: every tool in More.
    expect(fitTools([60, 60], 6, 40, 42)).toBe(0);
    expect(fitTools([], 6, 0, 42)).toBe(0);
    // A lone tool stays inline however narrow the row (the row wraps; More never holds one).
    expect(fitTools([60], 6, 10, 42)).toBe(1);
  });

  it('fits from sizes the answer cannot change (no back-and-forth when the queue wraps)', () => {
    const layout = { gap: 6, headerGap: 6, more: 36, queue: 0 };
    // No queue: More shares the tools' line.
    expect(phoneFit([60, 60, 60], { ...layout, room: 192 })).toBe(3);
    expect(phoneFit([60, 60, 60], { ...layout, room: 150 })).toBe(1);
    // With a queue: all on one line when it fits beside the tools...
    expect(phoneFit([60, 60], { ...layout, queue: 120, room: 6 + 126 + 120 })).toBe(2);
    // ...otherwise the queue (and More) wrap below and the tools get the whole line.
    expect(phoneFit([60, 60], { ...layout, queue: 120, room: 130 })).toBe(2);
    expect(phoneFit([60, 60, 60], { ...layout, queue: 120, room: 130 })).toBe(1);
    // A lone tool never goes to More, queue or not.
    expect(phoneFit([60], { ...layout, queue: 300, room: 40 })).toBe(1);
  });

  it('shows what fits inline with the same handlers, and More only for the overflow', async () => {
    phone(true);
    // A row 1000px wide where every tool is 60px: everything fits inline; More holds only Grouped.
    let callback: (() => void) | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(run: () => void) {
          callback = run;
        }
        observe() {
          queueMicrotask(() => callback?.());
        }
        disconnect() {}
      },
    );
    // The header line is `room` wide; every tool and More's square are 60px; nothing else counts.
    let room = 1000;
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const width = this.dataset.label || this.hasAttribute('data-more') ? 60 : 0;
        return { width, height: 36, top: 0, left: 0, right: width, bottom: 36 } as DOMRect;
      });
    const line = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(() => room);
    const spies = handlers();
    await mount(spies);
    await act(async () => {});
    expect(button('Grouped')).toBeUndefined();
    await openMore();
    expect(
      [...document.querySelectorAll('[role="dialog"] li > button, [role="dialog"] li > a')].map(
        (row) => row.textContent,
      ),
    ).toEqual(['Items and perk effects1 ›', 'Back to queueGerman, all categories']);
    await click(q('button[aria-label="Close Editor tools"]')!);
    await click(button('Markup bar'));
    expect(spies.toggle).toHaveBeenCalledTimes(1);
    await click(button('Edit enhanced'));
    expect(spies.onEditOverride).toHaveBeenCalledWith(5);
    // Inline Discard still asks first; Cancel discards nothing.
    await click(button('Discard this draft'));
    expect(spies.onDiscard).not.toHaveBeenCalled();
    await click(button('Cancel'));
    expect(spies.onDiscard).not.toHaveBeenCalled();
    await click(button('Discard this draft'));
    await click(
      [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find(
        (element) => element.textContent === 'Discard',
      ),
    );
    expect(spies.onDiscard).toHaveBeenCalledTimes(1);
    // Room for two tools beside More: Edit enhanced joins Grouped there.
    room = 2 * 60 + 6 + 60 + 6;
    await act(async () => callback?.());
    expect(button('Markup bar')).toBeDefined();
    expect(button('Discard this draft')).toBeDefined();
    await openMore();
    expect(
      [...document.querySelectorAll('[role="dialog"] li > button, [role="dialog"] li > a')].map(
        (row) => row.textContent,
      ),
    ).toEqual([
      'Items and perk effects1 ›',
      'Edit enhanced',
      'Back to queueGerman, all categories',
    ]);
    rect.mockRestore();
    line.mockRestore();
  });
});
