import { useLayoutEffect } from 'react';
import { create } from 'zustand';

const surfaces = new Set<object>();
export const useCompendiumSurfaces = create<{ visible: boolean }>(() => ({ visible: false }));
export function useCompendiumSurface(visible = true) {
  useLayoutEffect(() => {
    if (!visible) return;
    const owner = {};
    surfaces.add(owner);
    useCompendiumSurfaces.setState({ visible: true });
    return () => {
      surfaces.delete(owner);
      useCompendiumSurfaces.setState({ visible: surfaces.size > 0 });
    };
  }, [visible]);
}

const quietMs = 100;
let quietUntil = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let users = 0;
const resumed = new Set<() => void>();
export const compendiumInputPaused = () => performance.now() < quietUntil;
export function onCompendiumInputResume(callback: () => void) {
  resumed.add(callback);
  return () => {
    resumed.delete(callback);
  };
}
function release() {
  timer = undefined;
  const remaining = quietUntil - performance.now();
  if (remaining > 0) {
    timer = setTimeout(release, remaining);
    return;
  }
  for (const callback of resumed) callback();
}
function input(event: Event) {
  if (
    !(event.target instanceof Element) ||
    !event.target.closest('.cm-editor, input, textarea, [contenteditable="true"]')
  )
    return;
  quietUntil = performance.now() + quietMs;
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(release, quietMs);
}
/** Shared by header instances; only timing changes, never matching inputs or cached results. */
export function trackCompendiumInput() {
  if (!users++) {
    document.addEventListener('keydown', input, true);
    document.addEventListener('beforeinput', input, true);
  }
  return () => {
    if (--users) return;
    document.removeEventListener('keydown', input, true);
    document.removeEventListener('beforeinput', input, true);
    if (timer !== undefined) clearTimeout(timer);
    quietUntil = 0;
    release();
  };
}
export function waitForCompendiumInput(): Promise<void> {
  if (!compendiumInputPaused()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = onCompendiumInputResume(() => {
      unsubscribe();
      resolve();
    });
  });
}
