import type { SaveReview } from './state';

/** The narrow-screen save dock is hidden when there is nothing to save, report or review. */
export function isSaveDockIdle(state: {
  count: number;
  notice: string | null;
  review: SaveReview | null;
}): boolean {
  return state.count === 0 && !state.notice && !state.review;
}

/** CSS custom property that mirrors the dock's real border-box height for the page padding. */
export const dockHeightProperty = '--save-dock-height';

interface DockObserver {
  observe(target: unknown, options?: { box: 'border-box' }): void;
  disconnect(): void;
}

/**
 * Reports the dock's current border-box height (0 while `display: none`) now and after every
 * resize, e.g. a wrapped notice, enlarged text or the safe-area inset. Returns a stop function.
 * Without ResizeObserver nothing is applied, so the stylesheet's fixed fallback stays in force.
 */
export function trackDockHeight(
  target: { offsetHeight: number },
  apply: (height: string) => void,
  Observer: (new (callback: () => void) => DockObserver) | undefined = globalThis.ResizeObserver,
): () => void {
  if (!Observer) return () => undefined;
  const update = () => apply(`${target.offsetHeight}px`);
  update();
  const observer = new Observer(update);
  // offsetHeight is the border-box height, so padding/border/safe-area changes must notify too.
  observer.observe(target, { box: 'border-box' });
  return () => observer.disconnect();
}
