// @vitest-environment jsdom
// Escape in the account sheet hands focus straight back to the account button. The overlay's own
// restore runs in an effect, which the public build (Preact) defers past a paint, so focus sat on
// the page body for a frame (POLISH U19).
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ReportIdentitySheet from './ReportIdentitySheet';

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mount(onClose: () => void) {
  const anchor = createRef<HTMLButtonElement>();
  act(() =>
    root.render(
      <MemoryRouter>
        <button ref={anchor} type="button">
          Account
        </button>
        <ReportIdentitySheet
          open
          onClose={onClose}
          anchorRef={anchor}
          user={null}
          pictured={false}
        />
      </MemoryRouter>,
    ),
  );
  return anchor;
}

it('returns focus to the account button when Escape closes the sheet', () => {
  let focusedAtClose: Element | null = null;
  const onClose = vi.fn(() => (focusedAtClose = document.activeElement));
  const anchor = mount(onClose);
  const panel = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Account"]')!;
  expect(panel.contains(document.activeElement)).toBe(true);
  panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(focusedAtClose).toBe(anchor.current);
});

it('leaves focus alone when the sheet closes while focus is elsewhere', () => {
  let focusedAtClose: Element | null = null;
  const onClose = vi.fn(() => (focusedAtClose = document.activeElement));
  mount(onClose);
  const other = document.createElement('input');
  document.body.append(other);
  other.focus();
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(focusedAtClose).toBe(other);
  other.remove();
});
