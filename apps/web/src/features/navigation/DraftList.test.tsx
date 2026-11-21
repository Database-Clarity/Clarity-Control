// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { DraftList, draftRows } from './DraftList';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const tip = (hash: number, text: Record<string, string>, compendium?: unknown): Tooltip =>
  ({
    hash,
    text: Object.fromEntries(
      Object.entries(text).map(([lang, value]) => [
        lang,
        { text: value, updatedAt: `2026-11-01T00:00:${String(hash % 60).padStart(2, '0')}Z` },
      ]),
    ),
    associated: [],
    ...(compendium ? { compendium } : {}),
  }) as Tooltip;

const drafts = {
  1: { base: tip(1, { en: 'a' }), next: tip(1, { en: 'b' }) },
  2: { base: tip(2, { en: 'a', de: 'x' }), next: tip(2, { en: 'a', de: 'y' }) },
  3: { base: tip(3, { en: 'a' }), next: tip(3, { en: 'b' }, { sheet: 's', row: 1 }) },
  4: {
    base: { ...tip(4, { en: 'a' }), associated: [] },
    next: { ...tip(4, { en: 'a' }), associated: [7] },
  },
};

const handlers = () => ({ onOpen: vi.fn(), onDiscard: vi.fn() });
const render = async (rows: ReturnType<typeof draftRows>, h = handlers()) => {
  await act(async () =>
    root.render(
      createElement(DraftList, {
        rows,
        nameOf: (hash: number) => `Item ${hash}`,
        conflictsOf: () => 0,
        isStale: () => false,
        ...h,
      }),
    ),
  );
  return h;
};
const tree = () => host.querySelector<HTMLElement>('[role="tree"]')!;
const groups = () =>
  [...host.querySelectorAll('[aria-level="1"]')].map((group) => group.textContent);
const rowNames = () =>
  [...host.querySelectorAll('[aria-level="2"]')].map(
    (row) => row.querySelector('span')!.textContent,
  );
const press = async (key: string) =>
  act(async () => void tree().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));

describe('drafts list', () => {
  it('groups drafts by what they change, each draft once, with counts', async () => {
    await render(draftRows(drafts));
    expect(groups()).toEqual([
      '▾Compendium link1',
      '▾English text1',
      '▾Translations1',
      '▾Other fields1',
    ]);
    expect(rowNames()).toEqual(['Item 3', 'Item 1', 'Item 2', 'Item 4']);
  });

  it('collapses a group from a click and from the keyboard', async () => {
    await render(draftRows(drafts));
    await act(async () => void host.querySelector<HTMLElement>('[aria-level="1"]')!.click());
    expect(rowNames()).toEqual(['Item 1', 'Item 2', 'Item 4']);
    // Home -> the collapsed Compendium group; Right expands it, Left collapses it again.
    await press('Home');
    await press('ArrowRight');
    expect(rowNames()).toContain('Item 3');
    await press('ArrowLeft');
    expect(rowNames()).not.toContain('Item 3');
  });

  it('moves with the arrows, opens on Enter, and asks to discard on Delete', async () => {
    const h = await render(draftRows(drafts));
    await press('ArrowDown'); // Compendium header
    await press('ArrowDown'); // Item 3
    expect(tree().getAttribute('aria-activedescendant')).toBe('draft-row-3');
    await press('Enter');
    expect(h.onOpen).toHaveBeenCalledWith(3);
    await press('Delete');
    expect(h.onDiscard).toHaveBeenCalledWith(3);
    // Left from a row goes to its group's header.
    await press('ArrowLeft');
    expect(tree().getAttribute('aria-activedescendant')).toBe('draft-group-compendium');
  });

  it('groups text removals by the language removed', () => {
    const rows = draftRows({
      1: { base: tip(1, { en: 'a' }), next: tip(1, {}) },
      2: { base: tip(2, { en: 'a', de: 'x' }), next: tip(2, { en: 'a' }) },
      3: { base: tip(3, { en: 'a', de: 'x' }), next: tip(3, { de: 'y' }) },
    });
    const byHash = [...rows].sort((a, b) => a.hash - b.hash);
    expect(byHash.map(({ hash, kind, languages }) => [hash, kind, languages])).toEqual([
      [1, 'text', ['en']],
      [2, 'translation', ['de']],
      [3, 'text', ['en', 'de']],
    ]);
  });

  it('a scroll that hides the active row drops it; the next key picks an item in view', async () => {
    const h = await render(draftRows(drafts));
    await press('ArrowDown');
    await press('ArrowDown');
    expect(tree().getAttribute('aria-activedescendant')).toBe('draft-row-3');
    // The scrollbar (or PageUp) moves row 3 far below the view.
    const row = host.querySelector('#draft-row-3')!;
    row.getBoundingClientRect = () => ({ top: 5000, bottom: 5028 }) as DOMRect;
    await act(async () => void tree().dispatchEvent(new Event('scroll')));
    expect(tree().getAttribute('aria-activedescendant')).toBeNull();
    await press('Delete');
    expect(h.onDiscard).not.toHaveBeenCalled();
    expect(tree().getAttribute('aria-activedescendant')).toBe('draft-group-compendium');
    // End reaches the last item again after a manual scroll.
    await press('End');
    expect(tree().getAttribute('aria-activedescendant')).toBe('draft-row-4');
    host.querySelector('#draft-row-4')!.getBoundingClientRect = () =>
      ({ top: -5000, bottom: -4972 }) as DOMRect;
    await act(async () => void tree().dispatchEvent(new Event('scroll')));
    await press('End');
    expect(tree().getAttribute('aria-activedescendant')).toBe('draft-row-4');
  });

  it('a click on a group heading keeps that heading as the place', async () => {
    await render(draftRows(drafts));
    const english = () => host.querySelector<HTMLElement>('#draft-group-text')!;
    await act(async () => void english().click());
    expect(tree().getAttribute('aria-activedescendant')).toBe('draft-group-text');
    expect(english().getAttribute('aria-expanded')).toBe('false');
    await act(async () => void english().click());
    expect(english().getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps its place when the active draft is discarded', async () => {
    const h = await render(draftRows(drafts));
    await press('ArrowDown');
    await press('ArrowDown');
    await press('ArrowDown');
    await press('ArrowDown'); // Item 1, the English text row
    expect(tree().getAttribute('aria-activedescendant')).toBe('draft-row-1');
    const { 1: _gone, ...rest } = drafts;
    void _gone;
    await render(draftRows(rest), h);
    // Its group went with it; the item now at that place takes over: Item 2.
    expect(tree().getAttribute('aria-activedescendant')).toBe('draft-row-2');
  });

  it('keeps a bounded DOM with 400 drafts and reaches the last one from the keyboard', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [
        i + 1,
        { base: tip(i + 1, { en: 'a' }), next: tip(i + 1, { en: `b${i}` }) },
      ]),
    );
    const rows = draftRows(many);
    await render(rows);
    expect(host.querySelectorAll('[aria-level="2"]').length).toBeLessThan(60);
    await press('End');
    const last = rows.at(-1)!.hash;
    expect(tree().getAttribute('aria-activedescendant')).toBe(`draft-row-${last}`);
    expect(host.querySelector(`#draft-row-${last}`)).not.toBeNull();
  });
});
