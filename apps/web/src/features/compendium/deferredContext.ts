import type { CompendiumCell } from '@clarity/core';

const heights = new WeakMap<CompendiumCell, Map<string, number>>();

/** Keep sheet text searchable, but lay out offscreen physical lines separately. */
export function deferContextCells(
  details: HTMLDetailsElement,
  cells: readonly { cell: CompendiumCell }[],
) {
  const root = details.closest<HTMLElement>('[aria-label="Proposed source"]');
  if (!root || typeof IntersectionObserver === 'undefined' || !('onbeforematch' in details))
    return () => {};
  const nodes = [...details.querySelectorAll<HTMLElement>('[data-context-line="block"]')];
  const pending = new Set(nodes);
  // Hide every new cell before the first size read. No rich offscreen text is
  // included in the foreground layout needed to locate the card viewport.
  for (const node of nodes) node.setAttribute('hidden', 'until-found');
  const key = `${details.clientWidth}|${getComputedStyle(details).font}`;
  for (const [index, node] of nodes.entries()) {
    const height = heights.get(cells[index].cell)?.get(key);
    node.style.containIntrinsicBlockSize = height === undefined ? '1lh' : `${height}px`;
  }
  const controller = new AbortController();
  let cancelled = false;
  let idle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const inputPending = () =>
    (
      navigator as Navigator & {
        scheduling?: { isInputPending(options: { includeContinuous: boolean }): boolean };
      }
    ).scheduling?.isInputPending({ includeContinuous: true }) ?? false;
  function reveal(node: HTMLElement) {
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
    let sizes = heights.get(cells[nodes.indexOf(node)].cell);
    if (!sizes) heights.set(cells[nodes.indexOf(node)].cell, (sizes = new Map()));
    if (sizes.size >= 4 && !sizes.has(key)) sizes.delete(sizes.keys().next().value!);
    sizes.set(key, contentHeight);
    node.style.containIntrinsicBlockSize = `${contentHeight}px`;
    node.style.contentVisibility = '';
    observer.unobserve(node);
  }
  function revealVisible() {
    if (cancelled || !pending.size) return;
    const bounds = root!.getBoundingClientRect();
    const top = Math.max(0, bounds.top);
    const bottom = Math.min(window.innerHeight, bounds.bottom);
    if (bottom <= top) return;
    for (const node of pending) {
      // Re-read after revealing an earlier cell: its natural height can move
      // later cells out of the viewport. Never activate stale estimated boxes.
      const box = node.getBoundingClientRect();
      if (box.top < bottom + 128 && box.bottom > top - 128) reveal(node);
    }
  }
  const observer = new IntersectionObserver(revealVisible, { root, rootMargin: '128px 0px' });
  for (const node of nodes) observer.observe(node);
  const beforeMatch = (event: Event) => {
    const node = (event.target as Element).closest<HTMLElement>('[data-context-line="block"]');
    if (node) reveal(node);
  };
  const keyboard = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    // The browser retains native focus order. Expose its next link before the
    // default Tab action, including links in a still-deferred physical cell.
    const links = [...details.querySelectorAll<HTMLElement>('summary, a[href]')];
    const next =
      links[links.indexOf(document.activeElement as HTMLElement) + (event.shiftKey ? -1 : 1)];
    const node = next?.closest<HTMLElement>('[data-context-line="block"]');
    if (node) reveal(node);
  };
  details.addEventListener('beforematch', beforeMatch);
  details.addEventListener('keydown', keyboard);
  // Phone layouts can scroll the document or an outer review region instead
  // of the card. Capture every ancestor's native scroll before its next paint.
  document.addEventListener('scroll', revealVisible, { capture: true, passive: true });
  window.addEventListener('resize', revealVisible);
  revealVisible();
  function prepare() {
    if (cancelled) return;
    if (!inputPending()) {
      const next = pending.values().next().value;
      if (next) reveal(next);
    }
    if (pending.size) schedule();
  }
  function schedule() {
    const tasks = (
      globalThis as typeof globalThis & {
        scheduler?: {
          postTask(
            callback: () => void,
            options: { priority: 'background'; signal: AbortSignal },
          ): Promise<unknown>;
        };
      }
    ).scheduler;
    if (tasks && !inputPending())
      void tasks
        .postTask(prepare, { priority: 'background', signal: controller.signal })
        .catch(() => {});
    else if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(prepare);
    else timer = setTimeout(prepare, 16);
  }
  if (pending.size) schedule();
  return () => {
    cancelled = true;
    controller.abort();
    observer.disconnect();
    if (idle !== undefined) cancelIdleCallback(idle);
    if (timer !== undefined) clearTimeout(timer);
    details.removeEventListener('beforematch', beforeMatch);
    details.removeEventListener('keydown', keyboard);
    document.removeEventListener('scroll', revealVisible, true);
    window.removeEventListener('resize', revealVisible);
    for (const node of pending) node.removeAttribute('hidden');
  };
}
