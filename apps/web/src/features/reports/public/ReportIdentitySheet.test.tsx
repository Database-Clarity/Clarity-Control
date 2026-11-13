// @vitest-environment jsdom
// The account sheet restores focus itself (POLISH U19): Escape hands focus straight back to the
// account button (the overlay's effect-based restore ran a paint late under Preact, leaving focus
// on the page body), and a close never takes focus from wherever the reporter or another overlay
// put it.
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ShellOverlay } from '../../navigation/ShellOverlay';
import ReportIdentitySheet from './ReportIdentitySheet';

let root: Root;
let host: HTMLElement;
let setOpen: (open: boolean) => void;
let focusedAtClose: Element | null;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  focusedAtClose = null;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function App() {
  const [open, setSheet] = useState(true);
  const [other, setOther] = useState(false);
  setOpen = setSheet;
  const account = useRef<HTMLButtonElement>(null);
  const replace = useRef<HTMLButtonElement>(null);
  return (
    <MemoryRouter>
      <button ref={account} type="button" data-account>
        Account
      </button>
      <button ref={replace} type="button" data-replace onClick={() => setOther(true)}>
        Other
      </button>
      <input data-field />
      <ReportIdentitySheet
        open={open}
        onClose={() => {
          focusedAtClose = document.activeElement;
          setSheet(false);
        }}
        anchorRef={account}
        user={null}
        pictured={false}
      />
      <ShellOverlay open={other} onClose={() => setOther(false)} label="Other" anchorRef={replace}>
        <input />
      </ShellOverlay>
    </MemoryRouter>
  );
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const account = () => host.querySelector('[data-account]');
const sheet = () =>
  document.querySelector<HTMLElement>('[data-shell-overlay="Account"] [role="dialog"]');

it('returns focus to the account button in the step that closes the sheet on Escape', async () => {
  act(() => root.render(<App />));
  expect(sheet()!.contains(document.activeElement)).toBe(true);
  act(() => sheet()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(focusedAtClose).toBe(account());
  expect(sheet()).toBeNull();
  await flush();
  expect(document.activeElement).toBe(account());
});

it('keeps focus on a field the reporter pressed outside the sheet', async () => {
  act(() => root.render(<App />));
  const field = host.querySelector<HTMLInputElement>('[data-field]')!;
  field.focus();
  act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await flush();
  expect(sheet()).toBeNull();
  expect(document.activeElement).toBe(field);
});

it('returns focus to the account button after a press on blank page', async () => {
  act(() => root.render(<App />));
  act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  // A blank press blurs to the body once the press settles.
  (document.activeElement as HTMLElement).blur();
  await flush();
  expect(sheet()).toBeNull();
  expect(document.activeElement).toBe(account());
});

it('leaves focus in an overlay that takes over', async () => {
  act(() => root.render(<App />));
  act(() => host.querySelector<HTMLButtonElement>('[data-replace]')!.click());
  await flush();
  expect(sheet()).toBeNull();
  expect(document.activeElement?.closest('[data-shell-overlay="Other"]')).not.toBeNull();
});

it('returns focus to the account button when a route change closes the sheet', async () => {
  act(() => root.render(<App />));
  act(() => setOpen(false));
  expect(sheet()).toBeNull();
  expect(document.activeElement).toBe(account());
  await flush();
  expect(document.activeElement).toBe(account());
});
