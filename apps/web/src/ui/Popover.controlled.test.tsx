// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Popover } from './Popover';

let cleanup: () => Promise<void>;
afterEach(async () => {
  await cleanup?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([420, 640])(
  'aligns below the anchor with a %i px layout and a 420 px visual viewport',
  async (layoutHeight) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('innerHeight', layoutHeight);
    vi.stubGlobal(
      'visualViewport',
      Object.assign(new EventTarget(), { height: 420, width: 390, offsetTop: 0 }),
    );
    const mount = document.createElement('div');
    const anchor = document.createElement('div');
    document.body.append(anchor, mount);
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
      top: 120,
      bottom: 250,
      left: 12,
      right: 354,
      width: 342,
      height: 130,
      x: 12,
      y: 120,
      toJSON() {},
    });
    const root = createRoot(mount);
    cleanup = async () => {
      await act(async () => root.unmount());
      mount.remove();
      anchor.remove();
    };
    await act(async () =>
      root.render(
        <Popover label="Results" anchorElement={anchor} open>
          <p>Result</p>
        </Popover>,
      ),
    );
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.style.left).toBe('12px');
    expect(dialog.style.width).toBe('342px');
    expect(dialog.style.top).toBe('254px');
    expect(dialog.style.bottom).toBe('auto');
    expect(dialog.style.maxHeight).toBe('158px');
    expect(dialog.dataset.anchorCompact).toBe('true');
  },
);
it('anchors a controlled portal without moving input focus, and closes on Escape, Back, and outside press', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const mount = document.createElement('div');
  const anchor = document.createElement('div');
  const input = document.createElement('input');
  anchor.append(input);
  document.body.append(anchor, mount);
  const root = createRoot(mount);
  cleanup = async () => {
    await act(async () => root.unmount());
    mount.remove();
    anchor.remove();
  };
  const changed = vi.fn();
  function Harness({ initial }: { initial: number }) {
    const [open, setOpen] = useState(true);
    return (
      <Popover
        key={initial}
        label="Results"
        anchorElement={anchor}
        open={open}
        onOpenChange={(value) => {
          changed(value);
          setOpen(value);
        }}
      >
        <button>Result</button>
      </Popover>
    );
  }
  for (const [index, event] of [
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    new PopStateEvent('popstate'),
    new Event('pointerdown', { bubbles: true }),
  ].entries()) {
    input.focus();
    await act(async () => root.render(<Harness key={index} initial={index} />));
    expect(document.querySelector('[role="dialog"]')?.parentElement).toBe(document.body);
    expect(mount.querySelector('button')).toBeNull();
    expect(document.activeElement).toBe(input);
    await act(async () => anchor.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () =>
      (event.type === 'popstate' ? window : document.body).dispatchEvent(event),
    );
    expect(changed).toHaveBeenLastCalledWith(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(input);
  }
});
