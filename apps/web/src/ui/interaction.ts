/**
 * Something that owns the keyboard or the wheel above the page: a modal dialog (save, conflict,
 * the preview leave guard), an open sheet or popover that marks itself with `data-shell-overlay`,
 * or an expanded combobox, whose arrows and wheel belong to its list.
 */
const OWNERS =
  'dialog[open], [aria-modal="true"], [data-shell-overlay], [role="combobox"][aria-expanded="true"]';

export function workspaceShortcutOwners() {
  return document.querySelectorAll(OWNERS);
}

export function workspaceShortcutsBlocked(event: Event) {
  return event.defaultPrevented || !!document.querySelector(OWNERS);
}
