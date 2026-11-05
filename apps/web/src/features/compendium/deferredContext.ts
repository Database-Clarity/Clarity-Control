import type { CompendiumCell } from '@clarity/core';

const heights = new WeakMap<CompendiumCell, Map<string, number>>();

/** Keep physical cells searchable, and lay them out as they approach the viewport. */
export function deferContextCells(
  details: HTMLDetailsElement,
  cells: readonly { cell: CompendiumCell }[],
  prepare?: (node: HTMLElement, index: number) => boolean,
) {
  const nodes = [...details.querySelectorAll<HTMLElement>(':scope > [data-context-cell]')];
  const root = details.closest<HTMLElement>('[aria-label="Proposed source"]');
  if (!root || typeof IntersectionObserver === 'undefined' || !('onbeforematch' in details)) {
    nodes.forEach((node, index) => prepare?.(node, index));
    return Object.assign(() => {}, { refresh: () => {} });
  }
  const indices = new Map(nodes.map((node, index) => [node, index]));
  const pending = new Set(nodes);
  // Hide every new cell before the first size read. No rich offscreen text is
  // included in the foreground layout needed to locate the card viewport.
  for (const node of nodes) node.setAttribute('hidden', 'until-found');
  const key = `${details.clientWidth}|${getComputedStyle(details).font}`;
  for (const [index, node] of nodes.entries()) {
    const height = heights.get(cells[index].cell)?.get(key);
    node.style.containIntrinsicBlockSize = height === undefined ? '5rem' : `${height}px`;
  }
  let cancelled = false;
  function reveal(node: HTMLElement) {
    if (!pending.has(node) || (prepare && !prepare(node, indices.get(node)!))) return;
    if (!pending.delete(node)) return;
    node.removeAttribute('hidden');
    node.style.contentVisibility = 'visible';
    const height = node.getBoundingClientRect().height;
    const style = getComputedStyle(node);
    const contentHeight =
      height -
      [style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth].reduce(
        (sum, value) => sum + (parseFloat(value) || 0),
        0,
      );
    let sizes = heights.get(cells[indices.get(node)!].cell);
    if (!sizes) heights.set(cells[indices.get(node)!].cell, (sizes = new Map()));
    if (sizes.size >= 4 && !sizes.has(key)) sizes.delete(sizes.keys().next().value!);
    sizes.set(key, contentHeight);
    node.style.containIntrinsicBlockSize = `${contentHeight}px`;
    node.style.contentVisibility = '';
    observer.unobserve(node);
  }
  let refreshing = false;
  function revealVisible() {
    if (refreshing) return;
    if (cancelled || !pending.size) return;
    const bounds = root!.getBoundingClientRect();
    const top = Math.max(0, bounds.top);
    const bottom = Math.min(window.innerHeight, bounds.bottom);
    if (bottom <= top) return;
    refreshing = true;
    try {
      for (const node of pending) {
        // Re-read after revealing an earlier cell: its natural height can move
        // later cells out of the viewport. Never activate stale estimated boxes.
        const box = node.getBoundingClientRect();
        if (box.top < bottom + 128 && box.bottom > top - 128) reveal(node);
      }
    } finally {
      refreshing = false;
    }
  }
  const observer = new IntersectionObserver(revealVisible, { root, rootMargin: '128px 0px' });
  for (const node of nodes) observer.observe(node);
  const beforeMatch = (event: Event) => {
    const node = (event.target as Element).closest<HTMLElement>('[data-context-cell]');
    if (node) reveal(node);
  };
  const keyboard = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    // The browser retains native focus order. Expose its next link before the
    // default Tab action, including links in a still-deferred physical cell.
    const links = [...details.querySelectorAll<HTMLElement>('summary, a[href]')];
    const next =
      links[links.indexOf(document.activeElement as HTMLElement) + (event.shiftKey ? -1 : 1)];
    const node = next?.closest<HTMLElement>('[data-context-cell]');
    if (node) reveal(node);
  };
  details.addEventListener('beforematch', beforeMatch);
  details.addEventListener('keydown', keyboard);
  // Phone layouts can scroll the document or an outer review region instead
  // of the card. Capture every ancestor's native scroll before its next paint.
  document.addEventListener('scroll', revealVisible, { capture: true, passive: true });
  window.addEventListener('resize', revealVisible);
  revealVisible();
  const cancel = () => {
    cancelled = true;
    observer.disconnect();
    details.removeEventListener('beforematch', beforeMatch);
    details.removeEventListener('keydown', keyboard);
    document.removeEventListener('scroll', revealVisible, true);
    window.removeEventListener('resize', revealVisible);
    for (const node of pending) node.removeAttribute('hidden');
  };
  return Object.assign(cancel, { refresh: revealVisible });
}
