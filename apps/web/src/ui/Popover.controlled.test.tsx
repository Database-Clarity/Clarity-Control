// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Popover } from './Popover';

let cleanup: () => Promise<void>;
afterEach(async () => {
  await cleanup?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function hoverHarness() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const mount = document.createElement('div');
  document.body.append(mount);
  const root = createRoot(mount);
  cleanup = async () => {
    await act(async () => root.unmount());
    mount.remove();
  };
  await act(async () =>
    root.render(
      <>
        <input aria-label="Translation editor" />
        <Popover label="English original" trigger="Chaos remanié" openOnHover>
          <input aria-label="Popover field" />
        </Popover>
      </>,
    ),
  );
  return { trigger: mount.querySelector('button')!, editor: mount.querySelector('input')! };
}

function pointer(target: HTMLElement, type: 'pointerover' | 'pointerout', pointerType = 'mouse') {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
    relatedTarget: { value: document.body },
  });
  target.dispatchEvent(event);
}

it('ignores touch hover while allowing a deliberate tap to open the popover', async () => {
  const { trigger } = await hoverHarness();
  await act(async () => pointer(trigger, 'pointerover', 'touch'));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => trigger.click());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});

it('dismisses a hover-only popover without moving focus from the editor', async () => {
  const { trigger, editor } = await hoverHarness();
  await act(async () => editor.focus());
  await act(async () => pointer(trigger, 'pointerover'));
  // It opens once the pointer has rested (HOVER_REST).
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(() => new Promise((resolve) => setTimeout(resolve, 160)));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.activeElement).toBe(editor);
  await act(async () =>
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(editor);
});

it.each(['click', 'keyboard'])(
  'returns focus after Escape for a popover opened by %s',
  async (method) => {
    const { trigger } = await hoverHarness();
    await act(async () => (method === 'click' ? trigger.click() : trigger.focus()));
    const field = document.querySelector<HTMLInputElement>('[aria-label="Popover field"]')!;
    await act(async () => field.focus());
    await act(async () =>
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  },
);

it('returns focus for an explicit click even when the editor retained focus', async () => {
  const { trigger, editor } = await hoverHarness();
  await act(async () => editor.focus());
  await act(async () => trigger.click());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.activeElement).toBe(editor);
  await act(async () =>
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it.each(['trigger', 'content'])(
  'keeps a focused %s open on pointer leave until focus leaves',
  async (owner) => {
    const { trigger, editor } = await hoverHarness();
    vi.useFakeTimers();
    await act(async () => pointer(trigger, 'pointerover'));
    await act(async () => vi.advanceTimersByTime(160));
    const field = document.querySelector<HTMLInputElement>('[aria-label="Popover field"]')!;
    const focused = owner === 'trigger' ? trigger : field;
    await act(async () => focused.focus());
    await act(async () =>
      pointer(
        owner === 'trigger' ? trigger : field.closest<HTMLElement>('[role="dialog"]')!,
        'pointerout',
      ),
    );
    await act(async () => vi.advanceTimersByTime(151));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(focused);
    await act(async () => editor.focus());
    await act(async () => vi.advanceTimersByTime(151));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(editor);
  },
);

it('closes a mouse-hover popover after pointer leave when neither surface owns focus', async () => {
  const { trigger, editor } = await hoverHarness();
  vi.useFakeTimers();
  await act(async () => editor.focus());
  await act(async () => pointer(trigger, 'pointerover'));
  await act(async () => vi.advanceTimersByTime(160));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => pointer(trigger, 'pointerout'));
  await act(async () => vi.advanceTimersByTime(151));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(editor);
});
it('reveals hover content on focus and stays closed when Escape restores trigger focus', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const mount = document.createElement('div');
  document.body.append(mount);
  const root = createRoot(mount);
  cleanup = async () => {
    await act(async () => root.unmount());
    mount.remove();
  };
  await act(async () =>
    root.render(
      <Popover label="English original" trigger="Chaos remanié" openOnHover>
        Chaos Reshaped
      </Popover>,
    ),
  );
  const trigger = mount.querySelector('button')!;
  await act(async () => trigger.focus());
  expect(document.querySelector('[role="dialog"]')?.textContent).toBe('Chaos Reshaped');
  await act(async () => trigger.blur());
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(document.activeElement).toBe(trigger);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(trigger.hasAttribute('title')).toBe(false);
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
