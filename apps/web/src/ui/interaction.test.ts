// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';
import {
  observeNativeDialogShortcutOwner,
  registerWorkspaceShortcutOwner,
  workspaceShortcutOwners,
  workspaceShortcutsBlocked,
} from './interaction';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('workspaceShortcutsBlocked', () => {
  const wheel = () => new Event('wheel', { cancelable: true });

  it('is open on a plain page', () => {
    expect(workspaceShortcutsBlocked(wheel())).toBe(false);
  });
  it('is closed under a modal dialog, an aria-modal sheet, a shell overlay or an open combobox', () => {
    for (const html of [
      '<dialog open></dialog>',
      '<div aria-modal="true"></div>',
      '<div data-shell-overlay></div>',
      '<input role="combobox" aria-expanded="true" />',
    ]) {
      document.body.innerHTML = html;
      const owner = document.body.firstElementChild!;
      const release = registerWorkspaceShortcutOwner(owner);
      try {
        expect(workspaceShortcutsBlocked(wheel())).toBe(true);
      } finally {
        release();
      }
    }
  });
  it('ignores a closed dialog and a collapsed combobox', () => {
    document.body.innerHTML = '<dialog></dialog><input role="combobox" aria-expanded="false" />';
    expect(workspaceShortcutsBlocked(wheel())).toBe(false);
  });
  it('yields to an event something else already handled', () => {
    const event = wheel();
    event.preventDefault();
    expect(workspaceShortcutsBlocked(event)).toBe(true);
  });

  it('reads registered ownership without querying the document, and releases each owner once', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    document.body.append(a, b);
    const stopA = registerWorkspaceShortcutOwner(a);
    const stopAAgain = registerWorkspaceShortcutOwner(a);
    const stopB = registerWorkspaceShortcutOwner(b);
    const query = vi.spyOn(document, 'querySelector');
    try {
      expect([...workspaceShortcutOwners()]).toEqual([a, b]);
      stopA();
      stopA();
      expect(workspaceShortcutsBlocked(wheel())).toBe(true);
      stopAAgain();
      expect([...workspaceShortcutOwners()]).toEqual([b]);
      stopB();
      expect(workspaceShortcutsBlocked(wheel())).toBe(false);
      expect(query).not.toHaveBeenCalled();
    } finally {
      stopA();
      stopAAgain();
      stopB();
    }
  });

  it('reflects a registered native dialog opening and closing in the same event', () => {
    const dialog = document.createElement('dialog');
    document.body.append(dialog);
    const release = observeNativeDialogShortcutOwner(dialog);
    try {
      document.body.dispatchEvent(new Event('click'));
      dialog.setAttribute('open', '');
      expect(workspaceShortcutsBlocked(wheel())).toBe(true);
      expect(workspaceShortcutsBlocked(new KeyboardEvent('keydown', { key: 'a' }))).toBe(true);
      dialog.removeAttribute('open');
      expect(workspaceShortcutsBlocked(wheel())).toBe(false);
      expect(workspaceShortcutsBlocked(new KeyboardEvent('keydown', { key: 'a' }))).toBe(false);
      dialog.setAttribute('open', '');
      release(); // Unmounting an owner also releases a still-open native dialog.
      expect(workspaceShortcutsBlocked(wheel())).toBe(false);
    } finally {
      release();
    }
  });

  it('registers the actual dialog before input and cleans up on unmount without a close', () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const prototype = HTMLDialogElement.prototype;
    const originalShow = Object.getOwnPropertyDescriptor(prototype, 'showModal');
    const originalClose = Object.getOwnPropertyDescriptor(prototype, 'close');
    Object.defineProperty(prototype, 'showModal', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    });
    Object.defineProperty(prototype, 'close', {
      configurable: true,
      value: () => {},
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          createElement(Dialog, { title: 'Test dialog', onClose() {}, children: 'Body' }),
        ),
      );
      expect(host.querySelector('dialog')?.open).toBe(true);
      expect(workspaceShortcutsBlocked(wheel())).toBe(true);
      expect(workspaceShortcutsBlocked(new KeyboardEvent('keydown', { key: 'a' }))).toBe(true);
    } finally {
      act(() => root.unmount());
      host.remove();
      if (originalShow) Object.defineProperty(prototype, 'showModal', originalShow);
      else Reflect.deleteProperty(prototype, 'showModal');
      if (originalClose) Object.defineProperty(prototype, 'close', originalClose);
      else Reflect.deleteProperty(prototype, 'close');
    }
    expect(workspaceShortcutsBlocked(wheel())).toBe(false);
  });
});
