// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceShortcutsBlocked } from './interaction';

afterEach(() => {
  document.body.innerHTML = '';
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
      expect(workspaceShortcutsBlocked(wheel())).toBe(true);
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
});
