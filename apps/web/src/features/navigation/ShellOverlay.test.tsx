// @vitest-environment jsdom
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShellOverlay } from './ShellOverlay';
import { workspaceShortcutsBlocked } from '../../ui/interaction';

let host: HTMLDivElement;
let root: Root;

function Pair({ keepMounted = false, modal = true }: { keepMounted?: boolean; modal?: boolean }) {
  const [open, setOpen] = useState<'a' | 'b' | null>(null);
  const a = useRef<HTMLButtonElement>(null);
  const b = useRef<HTMLButtonElement>(null);
  return (
    <div id="shell-root">
      <button ref={a} type="button" data-testid="open-a" onClick={() => setOpen('a')}>
        A
      </button>
      <button ref={b} type="button" data-testid="open-b" onClick={() => setOpen('b')}>
        B
      </button>
      <ShellOverlay
        open={open === 'a'}
        onClose={() => setOpen((value) => (value === 'a' ? null : value))}
        label="Overlay A"
        anchorRef={a}
        keepMounted={keepMounted}
        modal={modal}
      >
        <button type="button" data-testid="a-first">
          first
        </button>
        <button type="button" data-testid="a-last">
          last
        </button>
      </ShellOverlay>
      <ShellOverlay
        open={open === 'b'}
        onClose={() => setOpen((value) => (value === 'b' ? null : value))}
        label="Overlay B"
        anchorRef={b}
      >
        <button type="button">only</button>
      </ShellOverlay>
    </div>
  );
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const click = (element: Element) => act(async () => (element as HTMLElement).click());
async function key(target: Element, name: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', {
    key: name,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => void target.dispatchEvent(event));
  return event;
}
const marker = () =>
  [...document.querySelectorAll('[data-shell-overlay]')].map((e) =>
    e.getAttribute('data-shell-overlay'),
  );

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.querySelectorAll('dialog').forEach((dialog) => dialog.remove());
  document.body.style.overflow = '';
});

describe('ShellOverlay', () => {
  it('marks itself, moves focus in, and Escape closes it and returns focus to the anchor', async () => {
    await act(async () => root.render(<Pair />));
    await click(q('open-a'));
    expect(workspaceShortcutsBlocked(new Event('wheel'))).toBe(true);
    expect(marker()).toEqual(['Overlay A']);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Overlay A');
    await key(document.activeElement!, 'Escape');
    expect(workspaceShortcutsBlocked(new Event('wheel'))).toBe(false);
    expect(marker()).toEqual([]);
    expect(document.activeElement).toBe(q('open-a'));
  });

  it('shows one overlay at a time: opening another closes the first', async () => {
    await act(async () => root.render(<Pair />));
    await click(q('open-a'));
    expect(marker()).toEqual(['Overlay A']);
    // The first overlay makes the shell inert, so a second opens from an outside click path:
    await act(async () => q('open-b').click());
    expect(marker()).toEqual(['Overlay B']);
  });

  it('keeps Tab inside a modal overlay and wraps at both ends', async () => {
    await act(async () => root.render(<Pair />));
    await click(q('open-a'));
    q('a-last').focus();
    expect((await key(q('a-last'), 'Tab')).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(q('a-first'));
    expect((await key(q('a-first'), 'Tab', true)).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(q('a-last'));
  });

  it('makes the shell inert only while a modal overlay is open', async () => {
    await act(async () => root.render(<Pair />));
    const shell = document.getElementById('shell-root')!;
    await click(q('open-a'));
    expect(shell.hasAttribute('inert')).toBe(true);
    await key(document.activeElement!, 'Escape');
    expect(shell.hasAttribute('inert')).toBe(false);
  });

  it('a menu (non-modal) leaves the page interactive and closes when Tab leaves it', async () => {
    await act(async () => root.render(<Pair modal={false} />));
    const shell = document.getElementById('shell-root')!;
    await click(q('open-a'));
    expect(shell.hasAttribute('inert')).toBe(false);
    q('a-last').focus();
    await key(q('a-last'), 'Tab');
    expect(marker()).toEqual([]);
  });

  it('closes on an outside press but not on a press inside or on its own anchor', async () => {
    await act(async () => root.render(<Pair modal={false} />));
    await click(q('open-a'));
    await act(async () => {
      q('a-first').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(marker()).toEqual(['Overlay A']);
    await act(async () => {
      q('open-a').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(marker()).toEqual(['Overlay A']);
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(marker()).toEqual([]);
  });

  it('leaves Escape and Tab to a native dialog above it', async () => {
    await act(async () => root.render(<Pair />));
    await click(q('open-a'));
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    const escape = await key(q('a-first'), 'Escape');
    expect(escape.defaultPrevented).toBe(false);
    expect(marker()).toEqual(['Overlay A']);
    expect((await key(q('a-last'), 'Tab')).defaultPrevented).toBe(false);
  });

  it('keeps children mounted but hidden while closed, and unmarked', async () => {
    await act(async () => root.render(<Pair keepMounted />));
    expect(q('a-first')).not.toBeNull();
    expect(q('a-first').closest('[hidden]')).not.toBeNull();
    expect(marker()).toEqual([]);
    await click(q('open-a'));
    expect(q('a-first').closest('[hidden]')).toBeNull();
    expect(marker()).toEqual(['Overlay A']);
  });
});
