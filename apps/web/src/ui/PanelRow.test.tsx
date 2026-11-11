// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PanelRow } from './PanelRow';
import { Popover } from './Popover';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('PanelRow', () => {
  it('is one collapsed line that expands in place and mounts its body only while open', async () => {
    await act(async () =>
      root.render(
        <PanelRow label="History" summary="Edited today" actions={<button>Add</button>}>
          <p>Body</p>
        </PanelRow>,
      ),
    );
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).toContain('Edited today');
    expect(host.textContent).not.toContain('Body');
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('Body');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)?.textContent).toBe(
      'Body',
    );
  });
  it('is plain text, not a button, when there is nothing to expand', async () => {
    await act(async () => root.render(<PanelRow label="Owner: X" />));
    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).toBe('Owner: X');
  });
});

describe('Popover', () => {
  async function mount() {
    await act(async () =>
      root.render(
        <>
          <Popover label="Details of text" trigger="Details">
            <p>Edited by owner</p>
          </Popover>
          <button id="elsewhere">Elsewhere</button>
        </>,
      ),
    );
    return host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
  }
  it('opens over the page, and closes on Escape with focus back on the trigger', async () => {
    const trigger = await mount();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toBe('Details of text');
    expect(dialog.textContent).toBe('Edited by owner');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it('closes on a press outside, but not on a press inside', async () => {
    const trigger = await mount();
    await act(async () => trigger.click());
    const press = (target: Element) =>
      act(async () => {
        target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      });
    await press(document.querySelector('[role="dialog"] p')!);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await press(host.querySelector('#elsewhere')!);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('portals to body, follows trigger Tab order, closes on Back, and unmounts', async () => {
    await act(async () =>
      root.render(
        <>
          <Popover label="Actions" trigger="Open">
            <input aria-label="Filter" />
            <button>Apply</button>
          </Popover>
          <button id="next">Next</button>
        </>,
      ),
    );
    const trigger = host.querySelector<HTMLButtonElement>('button')!;
    trigger.focus();
    await act(async () => trigger.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.parentElement).toBe(document.body);
    expect(host.contains(dialog)).toBe(false);
    expect(trigger.getAttribute('aria-controls')).toBe(dialog.id);
    const tab = (shiftKey = false) =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    tab();
    expect(document.activeElement).toBe(dialog.querySelector('input'));
    tab(true);
    expect(document.activeElement).toBe(trigger);
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click());
    await act(async () => root.render(<p>Gone</p>));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
