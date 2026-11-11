// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Popover } from './Popover';

let cleanup: () => Promise<void>;
afterEach(async () => {
  await cleanup?.();
});
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
