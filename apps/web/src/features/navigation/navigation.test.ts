import { completeWeaponTypeLabels } from '@clarity/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorData } from '../../stores/data';
import { canonicalHash, navigationGroups, sharedPerkLabel, variantHashes } from './catalog';
import { createStepping, shiftScrollDirection, stepWithinCategory } from './stepping';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipNavigation } from './TooltipNavigation';
import { Layout } from './Layout';
import { useDraftStore } from '../../stores/drafts';

vi.mock('../../stores/drafts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/drafts')>();
  return {
    ...actual,
    useDraftStore: Object.assign(
      (selector?: (state: ReturnType<typeof actual.useDraftStore.getState>) => unknown) =>
        selector ? selector(actual.useDraftStore.getState()) : actual.useDraftStore.getState(),
      actual.useDraftStore,
    ),
  };
});

const data: EditorData = {
  categories: [
    { id: 'later', label: 'Later', group: 'Weapons', order: 20 },
    { id: 'first', label: 'First', group: 'Armor', order: 10 },
  ],
  items: {
    10: {
      hash: 10,
      name: 'Base',
      icon: '',
      categoryId: 'later',
      inGameDescription: '',
      enhancedHashes: [11, 12],
    },
    11: {
      hash: 11,
      name: 'Enhanced',
      icon: '',
      categoryId: 'later',
      inGameDescription: '',
      baseHash: 10,
    },
    12: {
      hash: 12,
      name: 'Second variant',
      icon: '',
      categoryId: 'later',
      inGameDescription: '',
      baseHash: 10,
    },
    20: { hash: 20, name: 'Armor', icon: '', categoryId: 'first', inGameDescription: '' },
  },
  aliases: { 99: { to: 11, kind: 'sandbox' } },
  weaponTypeLabels: completeWeaponTypeLabels(),
  bundle: {
    sourceCommit: 'abc',
    generatedAt: '2026-10-27T00:00:00Z',
    tooltips: {
      2: {
        hash: 2,
        custom: { name: 'Variables', categoryId: 'globals' },
        text: {},
        associated: [],
      },
    },
    permissions: { users: {} },
    pushed: {},
  },
};

describe('tooltip catalog', () => {
  it('surfaces stale alias drafts as recoverable conflicts instead of hiding their text', () => {
    const previous = useDraftStore.getState();
    const base = { hash: 11, text: {}, associated: [] };
    useDraftStore.setState({
      drafts: {
        11: {
          base,
          next: {
            ...base,
            text: {
              en: {
                text: 'Recovered work to keep',
                updatedAt: '2026-10-27T00:00:00Z',
                updatedBy: 'owner',
              },
            },
          },
        },
      },
    });
    try {
      const markup = renderToStaticMarkup(
        createElement(
          MemoryRouter,
          null,
          createElement(TooltipNavigation, {
            data: { ...data, aliases: { 11: { to: 10, kind: 'frame' } } },
          }),
        ),
      );
      expect(markup).toContain('Recovered draft conflict');
      expect(markup).toContain('Recovered work to keep');
      expect(markup).toContain('Open shared tooltip 10');
      expect(markup).toContain('Discard recovered draft 11');
    } finally {
      useDraftStore.setState(previous);
    }
  });
  it('uses grouped dropdowns rather than lists or paging buttons', () => {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/t/10'] },
        createElement(TooltipNavigation, { data }),
      ),
    );
    expect(markup.match(/<select/g)).toHaveLength(2);
    expect(markup).toContain('<optgroup label="Armor">');
    expect(markup).toContain('<optgroup label="Weapons">');
    expect(markup).not.toContain('<details');
    expect(markup).not.toContain('<button');
    expect(markup).toContain('value="10" selected=""');
    expect(markup).not.toContain('value="11"');
  });
  it('marks shared perks in the navigation item and callout', () => {
    const shared: EditorData = {
      ...data,
      items: { ...data.items, 10: { ...data.items[10], owners: [20, 77] } },
    };
    const render = (value: EditorData) =>
      renderToStaticMarkup(
        createElement(
          MemoryRouter,
          { initialEntries: ['/t/10'] },
          createElement(TooltipNavigation, { data: value }),
        ),
      );
    expect(sharedPerkLabel(10, shared)).toBe('Shared perk — used on: Armor, 77');
    expect(sharedPerkLabel(10, data)).toBeUndefined();
    expect(sharedPerkLabel(20, shared)).toBeUndefined();
    const markup = render(shared);
    expect(markup).toContain('Shared perk — used on: Armor, 77');
    expect(markup).toContain('· shared perk');
    expect(render(data)).not.toContain('hared perk');
    expect(
      sharedPerkLabel(10, {
        ...data,
        items: { ...data.items, 10: { ...data.items[10], owners: [20] } },
      }),
    ).toBeUndefined();
  });
  it('provides one navigation appearance with no density toggle', () => {
    const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Layout)));
    expect(markup).not.toContain('Comfortable navigation');
    expect(markup).not.toContain('Compact navigation');
    expect(markup).not.toContain('aria-pressed');
  });
  it('resolves enhanced variants and sandbox aliases to the base', () => {
    expect(canonicalHash(11, data)).toBe(10);
    expect(canonicalHash(99, data)).toBe(10);
    expect(canonicalHash(555, data)).toBe(555);
    expect(variantHashes(10, data)).toEqual([10, 11, 12]);
  });
  it('groups categories in order and lists variants only with their base', () => {
    const groups = navigationGroups(data, '');
    expect(groups.map((group) => group.name)).toEqual(['Armor', 'Weapons', 'Other']);
    expect(
      groups.flatMap((group) =>
        group.sections.flatMap((section) => section.items.map((item) => item.hash)),
      ),
    ).toEqual([20, 10, 2]);
  });
  it('searches names, base hashes, variant hashes, and sandbox hashes', () => {
    for (const search of ['BASE', 'Enhanced', '10', '11', '99']) {
      expect(navigationGroups(data, search)[0]?.sections[0]?.items[0]?.hash).toBe(10);
    }
    expect(navigationGroups(data, 'missing')).toEqual([]);
  });
  it('reports alias cycles rather than looping', () => {
    expect(() =>
      canonicalHash(98, {
        ...data,
        aliases: {
          98: { to: 99, kind: 'sandbox' },
          99: { to: 98, kind: 'sandbox' },
        },
      }),
    ).toThrow('Cyclic');
  });
  it('lists a frame group once, counts all members and edits no alias variants', () => {
    const frames: EditorData = {
      ...data,
      aliases: {
        11: { to: 10, kind: 'frame' },
        12: { to: 10, kind: 'frame' },
        99: { to: 11, kind: 'sandbox' },
      },
    };
    expect(canonicalHash(11, frames)).toBe(10);
    expect(canonicalHash(99, frames)).toBe(10);
    expect(variantHashes(10, frames)).toEqual([10]);
    expect(navigationGroups(frames, '12')[0]?.sections[0]?.items.map((item) => item.hash)).toEqual([
      10,
    ]);
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/t/10'] },
        createElement(TooltipNavigation, { data: frames }),
      ),
    );
    expect(markup).toContain('×3');
    expect(markup).not.toContain('value="11"');
    expect(markup).not.toContain('value="12"');
  });
});

describe('stepping history', () => {
  it('steps only within the selected category and stops at both ends without wrapping', () => {
    const category = [10, 30, 40];
    expect(stepWithinCategory(10, -1, category)).toBeUndefined();
    expect(stepWithinCategory(40, 1, category)).toBeUndefined();
    expect(stepWithinCategory(10, 1, category)).toBe(30);
    expect(stepWithinCategory(30, -1, category)).toBe(10);
    expect(stepWithinCategory(20, 1, category)).toBeUndefined();
    expect(stepWithinCategory(Number.NaN, 1, category)).toBeUndefined();
    expect(stepWithinCategory(10, 1, [])).toBeUndefined();
  });
  it('recognizes Shift+Scroll anywhere, including horizontal wheel deltas, without stealing normal scrolling or zoom', () => {
    const event = { shiftKey: false, ctrlKey: false, metaKey: false, deltaX: 0, deltaY: 100 };
    expect(shiftScrollDirection(event)).toBe(0);
    expect(shiftScrollDirection({ ...event, shiftKey: true })).toBe(1);
    expect(shiftScrollDirection({ ...event, shiftKey: true, deltaY: -100 })).toBe(-1);
    expect(shiftScrollDirection({ ...event, shiftKey: true, deltaY: 0, deltaX: 100 })).toBe(1);
    expect(shiftScrollDirection({ ...event, shiftKey: true, ctrlKey: true })).toBe(0);
    expect(shiftScrollDirection({ ...event, shiftKey: true, metaKey: true })).toBe(0);
  });
  afterEach(() => vi.useRealTimers());
  function history() {
    const entries = ['/t/10'];
    const navigate = vi.fn((path: string, { replace }: { replace: boolean }) => {
      if (replace) entries[entries.length - 1] = path;
      else entries.push(path);
    });
    return { entries, navigate, stepping: createStepping(navigate) };
  }
  it('replaces immediately, then adds exactly one entry after 1 second idle', () => {
    vi.useFakeTimers();
    const { entries, stepping } = history();
    stepping.step('/t/10', '/t/20');
    expect(entries).toEqual(['/t/20']);
    vi.advanceTimersByTime(900);
    stepping.step('/t/20', '/t/30');
    vi.advanceTimersByTime(999);
    expect(entries).toEqual(['/t/30']);
    vi.advanceTimersByTime(1);
    expect(entries).toEqual(['/t/10', '/t/30']);
  });
  it('commits before an explicit selection so back returns to the stepped tooltip', () => {
    vi.useFakeTimers();
    const { entries, stepping, navigate } = history();
    stepping.step('/t/10', '/t/20');
    stepping.commit();
    navigate('/review', { replace: false });
    vi.advanceTimersByTime(1500);
    expect(entries).toEqual(['/t/10', '/t/20', '/review']);
  });
  it('cancels the timer on pop/unmount without later navigation', () => {
    vi.useFakeTimers();
    const { stepping, navigate } = history();
    stepping.step('/t/10', '/t/20');
    stepping.cancel();
    navigate.mockClear();
    vi.advanceTimersByTime(2000);
    expect(navigate).not.toHaveBeenCalled();
  });
  it('does not duplicate history when a gesture returns to its origin', () => {
    vi.useFakeTimers();
    const { entries, stepping } = history();
    stepping.step('/t/10', '/t/20');
    stepping.step('/t/20', '/t/10');
    vi.advanceTimersByTime(1000);
    expect(entries).toEqual(['/t/10']);
  });
});
