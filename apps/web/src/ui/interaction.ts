export function workspaceShortcutsBlocked(event: KeyboardEvent) {
  return event.defaultPrevented || !!document.querySelector('dialog[open], [aria-modal="true"]');
}
