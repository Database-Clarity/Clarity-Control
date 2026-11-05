// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { ProposalContext } from './ProposalContext';

it('keeps deferred text and native links, and formats before Tab or beforematch exposes them', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const previous = Object.getOwnPropertyDescriptor(HTMLDetailsElement.prototype, 'onbeforematch');
  Object.defineProperty(HTMLDetailsElement.prototype, 'onbeforematch', {
    configurable: true,
    value: null,
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return (
      this.hasAttribute('data-context-cell')
        ? { top: 600, bottom: 680, height: 80 }
        : { top: 0, bottom: 300, height: 300 }
    ) as DOMRect;
  });
  const fixture = guidedFixture();
  const match = fixture.proposals.get(100)!.match!;
  const text = 'A linked line\n\nSecond line';
  match.tab.grid = [0, 1].map((col) => ({
    row: match.row.rowIndex,
    col,
    cell: {
      plain: text,
      runs: [
        { text: '', href: 'https://example.com/empty' },
        { text, href: `https://example.com/${col}`, bold: true },
      ],
    },
  }));
  const host = document.createElement('section');
  host.setAttribute('aria-label', 'Proposed source');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(createElement(ProposalContext, { match, source: fixture.source })),
    );
    const details = host.querySelector('details')!;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    const cells = [...details.querySelectorAll<HTMLElement>('[data-context-cell]')];
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell.getAttribute('hidden')).toBe('until-found');
      expect(cell.textContent!.endsWith(text)).toBe(true);
      expect(cell.querySelector('a')?.target).toBe('_blank');
      expect(cell.querySelectorAll('a')).toHaveLength(1);
      expect(cell.querySelector('[style]')).toBeNull();
    }
    details.querySelector('summary')!.focus();
    await act(async () =>
      details.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })),
    );
    expect(cells[0].hasAttribute('hidden')).toBe(false);
    expect(cells[0].querySelector('a span')?.getAttribute('style')).toContain('font-weight: 700');
    expect(cells[1].hasAttribute('hidden')).toBe(true);
    const textNode = cells[1].querySelector('a')!.firstChild!;
    document.getSelection()!.setBaseAndExtent(textNode, 2, textNode, 8);
    await act(async () => cells[1].dispatchEvent(new Event('beforematch', { bubbles: true })));
    expect(cells[1].hasAttribute('hidden')).toBe(false);
    expect(cells[1].querySelector('[data-multiline]')!.textContent).toBe(text);
    expect(document.getSelection()!.toString()).toBe(text.slice(2, 8));
    expect(details.open).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    if (previous) Object.defineProperty(HTMLDetailsElement.prototype, 'onbeforematch', previous);
    else Reflect.deleteProperty(HTMLDetailsElement.prototype, 'onbeforematch');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
