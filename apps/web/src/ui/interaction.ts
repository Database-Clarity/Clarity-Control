import { useLayoutEffect, type RefObject } from 'react';

/**
 * Something that owns the keyboard or the wheel above the page: a modal dialog (save, conflict,
 * the preview leave guard), an open sheet or popover that marks itself with `data-shell-overlay`,
 * or an expanded combobox, whose arrows and wheel belong to its list.
 */
const owners = new Map<Element, number>();

export function registerWorkspaceShortcutOwner(owner: Element) {
  owners.set(owner, (owners.get(owner) ?? 0) + 1);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const count = owners.get(owner)! - 1;
    if (count) owners.set(owner, count);
    else owners.delete(owner);
  };
}

/** Register during the DOM commit, and release before an owner disappears. */
export function useWorkspaceShortcutOwner(ref: RefObject<Element | null>, open = true) {
  useLayoutEffect(() => {
    if (open && ref.current) return registerWorkspaceShortcutOwner(ref.current);
  }, [ref, open]);
}

// Native dialogs may also be opened or closed through the platform API. Observe
// only `open` on those registered roots; editor mutations never reach this observer.
const nativeDialogs = new Map<HTMLDialogElement, { release?: () => void }>();
let nativeObserver: MutationObserver | undefined;
function updateNativeDialogs(records: MutationRecord[]) {
  for (const { target } of records) {
    const dialog = target as HTMLDialogElement;
    const entry = nativeDialogs.get(dialog);
    if (!entry) continue;
    if (dialog.open && !entry.release) entry.release = registerWorkspaceShortcutOwner(dialog);
    else if (!dialog.open && entry.release) {
      entry.release();
      entry.release = undefined;
    }
  }
}
function flushNativeDialogs() {
  if (nativeObserver) updateNativeDialogs(nativeObserver.takeRecords());
}

export function observeNativeDialogShortcutOwner(dialog: HTMLDialogElement) {
  const entry: { release?: () => void } = {};
  if (dialog.open) entry.release = registerWorkspaceShortcutOwner(dialog);
  nativeDialogs.set(dialog, entry);
  nativeObserver ??= new MutationObserver(updateNativeDialogs);
  nativeObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] });
  let observing = true;
  return () => {
    if (!observing) return;
    observing = false;
    flushNativeDialogs();
    entry.release?.();
    nativeDialogs.delete(dialog);
    nativeObserver?.disconnect();
    if (!nativeDialogs.size) nativeObserver = undefined;
    else
      for (const root of nativeDialogs.keys())
        nativeObserver!.observe(root, { attributes: true, attributeFilter: ['open'] });
  };
}

export function useNativeDialogShortcutOwner(
  ref: RefObject<HTMLDialogElement | null>,
  mounted = true,
) {
  useLayoutEffect(() => {
    if (mounted && ref.current) return observeNativeDialogShortcutOwner(ref.current);
  }, [ref, mounted]);
}

export function workspaceShortcutOwners() {
  flushNativeDialogs();
  return owners.keys();
}

export function workspaceShortcutsBlocked(event: Event) {
  // A platform open/close can occur earlier in this same event. Taking records
  // keeps that case synchronous without scanning the document or its contents.
  flushNativeDialogs();
  return event.defaultPrevented || owners.size > 0;
}
