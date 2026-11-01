export function workspaceShortcutsBlocked(event: Event) {
  return event.defaultPrevented || !!document.querySelector('dialog[open], [aria-modal="true"]');
}
