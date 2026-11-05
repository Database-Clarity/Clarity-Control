// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deferContextCells } from './deferredContext';

let intersect: () => void;
beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: () => void) {
        intersect = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture() {
  const root = document.createElement('section');
  root.setAttribute('aria-label', 'Proposed source');
  root.innerHTML =
    '<details open><summary>Nearby cells</summary><div data-context-cell><a href="#one">First link</a></div><div data-context-cell><a href="#two">Second link</a></div></details>';
  document.body.append(root);
  const details = root.querySelector('details')!;
  Object.defineProperty(details, 'onbeforematch', { value: null });
  const nodes = [...root.querySelectorAll<HTMLElement>('[data-context-cell]')];
  let top = 600;
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 300 } as DOMRect);
  for (const [index, node] of nodes.entries())
    vi.spyOn(node, 'getBoundingClientRect').mockImplementation(
      () => ({ top: top + index * 100, bottom: top + index * 100 + 80, height: 80 }) as DOMRect,
    );
  const cells = nodes.map((node) => ({
    cell: { plain: node.textContent!, runs: [{ text: node.textContent! }] },
  }));
  return {
    root,
    details,
    nodes,
    cells,
    scrollToCells: () => {
      top = 0;
    },
  };
}
it('keeps open context, text, and links in the DOM without speculatively laying out offscreen cells', () => {
  const schedule = vi.fn();
  vi.stubGlobal('scheduler', { postTask: schedule });
  vi.stubGlobal('requestIdleCallback', schedule);
  const { details, nodes, cells } = fixture();
  const cancel = deferContextCells(details, cells);
  expect(details.open).toBe(true);
  expect(details.textContent).toContain('Second link');
  expect(nodes.every((node) => node.getAttribute('hidden') === 'until-found')).toBe(true);
  intersect();
  expect(nodes.every((node) => node.hasAttribute('hidden'))).toBe(true);
  expect(details.querySelectorAll('a[href]')).toHaveLength(2);
  expect(schedule).not.toHaveBeenCalled();
  cancel();
  expect(nodes.some((node) => node.hasAttribute('hidden'))).toBe(false);
});
it('reveals browser Find results, and the next native Tab link, before those actions finish', () => {
  const { details, nodes, cells } = fixture();
  const cancel = deferContextCells(details, cells);
  const summary = details.querySelector('summary')!;
  summary.focus();
  summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  expect(nodes[0].hasAttribute('hidden')).toBe(false);
  expect(nodes[1].hasAttribute('hidden')).toBe(true);
  nodes[1].dispatchEvent(new Event('beforematch', { bubbles: true }));
  expect(nodes[1].hasAttribute('hidden')).toBe(false);
  cancel();
});
it('reveals scrolled cells synchronously, and cancels callbacks when the context changes', () => {
  const { details, nodes, cells, scrollToCells } = fixture();
  const cancel = deferContextCells(details, cells);
  scrollToCells();
  // The document is the scroll owner in the narrow layout.
  document.dispatchEvent(new Event('scroll'));
  expect(nodes.every((node) => !node.hasAttribute('hidden'))).toBe(true);
  cancel();
  const reads = vi.mocked(nodes[0].getBoundingClientRect).mock.calls.length;
  intersect();
  expect(vi.mocked(nodes[0].getBoundingClientRect)).toHaveBeenCalledTimes(reads);
});
