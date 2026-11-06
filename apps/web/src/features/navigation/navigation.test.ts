import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorData } from '../../stores/data';
import { presentCategories } from '../../services/categoryLabels';
import { loadManifestFacts } from '../compendium/manifestFacts';
import {
  canonicalHash,
  classifiedCategory,
  navigationGroups,
  sharedPerkLabel,
  singleOwnerLabel,
  variantHashes,
} from './catalog';
import {
  categoryPosition,
  createStepping,
  positionLabel,
  shiftScrollDirection,
  stepTarget,
  stepWithinCategory,
  tooltipPath,
} from './stepping';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipNavigation } from './TooltipNavigation';
import { RecoveredDrafts } from './DraftButton';
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
  it('names an item by the category the finder lists it under, not its generator category', () => {
    // Heavy Bolts: generator weapon-perk, reclassified to Parts with Effects.
    const bolts = {
      hash: 1202133695,
      name: 'Heavy Bolts',
      icon: '',
      categoryId: 'weapon-perk',
      inGameDescription: '',
    };
    const boltData: EditorData = {
      ...data,
      categories: presentCategories([
        { id: 'weapon-perk', label: 'Weapon Perk', group: 'Weapons', order: 100 },
      ]),
      items: { [bolts.hash]: bolts },
    };
    const facts = loadManifestFacts().items[bolts.hash].inventory!;
    bolts.name = facts.displayName ?? bolts.name;
    bolts.inGameDescription = facts.description ?? bolts.inGameDescription;
    expect(classifiedCategory(bolts, boltData)?.label).toBe('Parts with Effects');
    const sections = navigationGroups(boltData, '').flatMap((group) => group.sections);
    const listed = sections.find((section) =>
      section.items.some((item) => item.hash === bolts.hash),
    );
    expect(listed?.label).toBe('Parts with Effects');
    expect(listed?.id).toBe(classifiedCategory(bolts, boltData)?.id);
  });

  it('skips the legacy Default perk placeholder but keeps the other globals', () => {
    const base = { text: {}, associated: [] };
    const withGlobals: EditorData = {
      ...data,
      bundle: {
        ...data.bundle,
        tooltips: {
          ...data.bundle.tooltips,
          0: { ...base, hash: 0, custom: { name: 'Default perk', categoryId: 'none' } },
          1: { ...base, hash: 1, custom: { name: 'Global exports', categoryId: 'none' } },
        },
      },
    };
    const names = navigationGroups(withGlobals, '').flatMap((group) =>
      group.sections.flatMap((section) => section.items.map((item) => item.name)),
    );
    expect(names).toContain('Global exports');
    expect(names).not.toContain('Default perk');
    expect(navigationGroups(withGlobals, 'default perk').flatMap((g) => g.sections)).toEqual([]);
    expect(withGlobals.bundle.tooltips[0]).toBeDefined();
    const other = navigationGroups(withGlobals, '').find((group) => group.name === 'Other')!;
    expect(other.sections[0].label).toBe('Other: none');
  });

  it('retains and discovers single owner identity with fallback names', () => {
    const single: EditorData = {
      ...data,
      items: { 10: { ...data.items[10], itemHash: 42, itemName: 'Hidden Exotic' } },
    };
    expect(singleOwnerLabel(10, single)).toBe('Owner: Hidden Exotic / 42');
    expect(navigationGroups(single, 'hidden exotic')[0].sections[0].items[0].hash).toBe(10);
    expect(navigationGroups(single, '42')[0].sections[0].items[0].hash).toBe(10);
    const fallback: EditorData = {
      ...single,
      items: { 10: { ...single.items[10], itemName: undefined } },
    };
    expect(singleOwnerLabel(10, fallback)).toBe('Owner: 42');
  });

  it('names one owner once when two definitions of it share the perk', () => {
    const twin: EditorData = {
      ...data,
      items: {
        10: {
          ...data.items[10],
          owners: [42, 43],
          ownerNames: { 42: 'Twin Piece', 43: 'Twin Piece' },
        },
      },
    };
    expect(sharedPerkLabel(10, twin)).toBeUndefined();
    expect(singleOwnerLabel(10, twin)).toBe('Owner: Twin Piece / 42, 43');
    const split: EditorData = {
      ...twin,
      items: { 10: { ...twin.items[10], ownerNames: { 42: 'Aeon Safe', 43: 'Aeon Soul' } } },
    };
    expect(sharedPerkLabel(10, split)).toBe('Shared perk — used on: Aeon Safe, Aeon Soul');
    expect(singleOwnerLabel(10, split)).toBeUndefined();
  });

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
          createElement(RecoveredDrafts, {
            data: { ...data, aliases: { 11: { to: 10, kind: 'frame' } } },
            onOpen: () => undefined,
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
  it('uses a grouped category dropdown and a tooltip combobox, with no stepper in the header form', () => {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/t/10'] },
        createElement(TooltipNavigation, { data }),
      ),
    );
    expect(markup.match(/<select/g)).toHaveLength(1);
    expect(markup).toContain('<optgroup label="Armor">');
    expect(markup).toContain('<optgroup label="Weapons">');
    expect(markup).not.toContain('<details');
    // The combobox shows the current item and keeps its list closed until asked.
    expect(markup).toMatch(/<input[^>]*role="combobox"[^>]*aria-expanded="false"[^>]*value="Base"/);
    expect(markup).not.toContain('role="listbox"');
    expect(markup).not.toContain('Step within category');
    expect(markup.match(/<button/g)).toBeNull();
    expect(markup).toContain('value="later" selected=""');
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
    expect(markup).toContain('title="Shared perk — used on: Armor, 77"');
    expect(render(data)).not.toContain('hared perk');
    expect(
      sharedPerkLabel(10, {
        ...data,
        items: { ...data.items, 10: { ...data.items[10], owners: [20] } },
      }),
    ).toBeUndefined();
  });
  it('resolves shared owner names from the catalog, custom items, and generated owner names', () => {
    const shared: EditorData = {
      ...data,
      items: {
        ...data.items,
        10: {
          ...data.items[10],
          owners: [20, 2, 77, 78, 79],
          ownerNames: { 20: 'Other armor', 2: 'Other custom', 77: 'Exotic <A>', 78: ' ' },
        },
      },
    };
    const expected = 'Shared perk — used on: Armor, Variables, Exotic <A>, 78, 79';
    expect(sharedPerkLabel(10, shared)).toBe(expected);
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/t/10'] },
        createElement(TooltipNavigation, { data: shared }),
      ),
    );
    expect(markup).toContain('Shared perk — used on: Armor, Variables, Exotic &lt;A&gt;, 78, 79');
  });
  it('uses custom names when catalog names are blank, before generated names or hashes', () => {
    const shared: EditorData = {
      ...data,
      items: {
        ...data.items,
        10: { ...data.items[10], owners: [2, 20, 77], ownerNames: { 2: 'Generated' } },
        2: { ...data.items[20], hash: 2, name: '  ' },
        20: { ...data.items[20], name: '\t' },
      },
      bundle: {
        ...data.bundle,
        tooltips: {
          ...data.bundle.tooltips,
          20: {
            hash: 20,
            custom: { name: ' Custom armor ', categoryId: 'first' },
            text: {},
            associated: [],
          },
        },
      },
    };
    expect(sharedPerkLabel(10, shared)).toBe('Shared perk — used on: Variables, Custom armor, 77');
    shared.items[2].name = ' Catalog name ';
    expect(sharedPerkLabel(10, shared)).toBe(
      'Shared perk — used on: Catalog name, Custom armor, 77',
    );
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
  it('refreshes canonical destinations when the loaded catalogue changes', () => {
    expect(canonicalHash(99, data)).toBe(10);
    const changed = { ...data, aliases: { 99: { to: 20, kind: 'sandbox' as const } } };
    expect(canonicalHash(99, changed)).toBe(20);
    expect(canonicalHash(99, data)).toBe(10);
  });
  it('groups categories in order and lists variants only with their base', () => {
    const groups = navigationGroups(data, '');
    expect(groups.map((group) => group.name)).toEqual(['Weapons', 'Armor', 'Other']);
    expect(
      groups.flatMap((group) =>
        group.sections.flatMap((section) => section.items.map((item) => item.hash)),
      ),
    ).toEqual([10, 20, 2]);
  });
  it('searches names, base hashes, variant hashes, and sandbox hashes', () => {
    for (const search of ['BASE', 'Enhanced', '10', '11', '99']) {
      expect(navigationGroups(data, search)[0]?.sections[0]?.items[0]?.hash).toBe(10);
    }
    expect(navigationGroups(data, 'missing')).toEqual([]);
  });
  it('finds canonical entries by existing owner names and hashes', () => {
    const owned: EditorData = {
      ...data,
      items: {
        ...data.items,
        10: {
          ...data.items[10],
          owners: [20, 2, 77],
          ownerNames: { 77: 'Fallback Exotic' },
          itemHash: 88,
        },
      },
    };
    for (const query of ['armor', 'VARIABLES', 'fallback exotic', '77', '88', '99']) {
      const hashes = navigationGroups(owned, query).flatMap((group) =>
        group.sections.flatMap((section) => section.items.map((item) => item.hash)),
      );
      expect(hashes.filter((hash) => hash === 10)).toEqual([10]);
    }
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
    // One category entry for the whole frame group; the variants have no entry of their own.
    expect(markup).toContain('Later (1)');
  });
});

describe('previous/next stepping buttons', () => {
  const category: EditorData = {
    ...data,
    items: {
      ...data.items,
      21: { hash: 21, name: 'Boots', icon: '', categoryId: 'first', inGameDescription: '' },
      22: { hash: 22, name: 'Cape', icon: '', categoryId: 'first', inGameDescription: '' },
    },
  };
  function stepper(path: string) {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(TooltipNavigation, { data: category, variant: 'sheet' }),
      ),
    );
    const buttons = [...markup.matchAll(/<button([^>]*)>/g)].filter((match) =>
      /aria-label="(Previous|Next) tooltip"/.test(match[1]),
    );
    return {
      markup,
      disabled: Object.fromEntries(
        buttons.map((match) => [
          /aria-label="(Previous|Next) tooltip"/.exec(match[1])![1],
          match[1].includes('disabled'),
        ]),
      ),
    };
  }
  it('computes targets and the counter at both ends and in the middle', () => {
    const hashes = [20, 21, 22];
    expect(categoryPosition(20, hashes)).toEqual({
      index: 1,
      total: 3,
      previous: undefined,
      next: 21,
    });
    expect(categoryPosition(21, hashes)).toEqual({ index: 2, total: 3, previous: 20, next: 22 });
    expect(categoryPosition(22, hashes)).toEqual({
      index: 3,
      total: 3,
      previous: 21,
      next: undefined,
    });
    expect(categoryPosition(99, hashes)).toEqual({
      index: 0,
      total: 3,
      previous: undefined,
      next: undefined,
    });
    expect(categoryPosition(1, [])).toEqual({
      index: 0,
      total: 0,
      previous: undefined,
      next: undefined,
    });
    expect(positionLabel({ index: 2, total: 3 })).toBe('2 of 3');
    expect(positionLabel({ index: 0, total: 3 })).toBe('3 in category');
  });
  it('disables Previous on the first and Next on the last tooltip of the category', () => {
    const first = stepper('/t/20');
    expect(first.disabled).toEqual({ Previous: true, Next: false });
    expect(first.markup).toContain('1 of 3');
    expect(stepper('/t/21').disabled).toEqual({ Previous: false, Next: false });
    const last = stepper('/t/22');
    expect(last.disabled).toEqual({ Previous: false, Next: true });
    expect(last.markup).toContain('3 of 3');
  });
  it('keeps both buttons disabled for a single-item category and labels the group', () => {
    const only = stepper('/t/10');
    expect(only.disabled).toEqual({ Previous: true, Next: true });
    expect(only.markup).toContain('1 of 1');
    expect(only.markup).toContain('aria-label="Step within category"');
  });
  it('wraps the keyboard/wheel help so touch devices can hide it but keeps the draft legend', () => {
    const { markup } = stepper('/t/20');
    expect(markup).toMatch(/<small id="tooltip-stepping-help"[^>]*>Type to search\. Shift\+Scroll/);
    expect(markup).toContain('* = unsaved draft.');
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
  describe('with the preview leave guard', () => {
    function guarded(allowed: boolean) {
      const entries = ['/t/10'];
      const navigate = vi.fn((path: string, { replace }: { replace: boolean }) => {
        if (replace) entries[entries.length - 1] = path;
        else entries.push(path);
      });
      let epoch = 0;
      const guard = {
        allow: vi.fn(() => allowed),
        epoch: () => epoch,
        authorized: vi.fn((run: () => void) => run()),
      };
      return {
        entries,
        navigate,
        guard,
        stepping: createStepping(navigate, guard),
        bump: () => void epoch++,
      };
    }
    it('asks before any history or timer state changes, and a refusal leaves nothing pending', () => {
      vi.useFakeTimers();
      const { entries, navigate, guard, stepping } = guarded(false);
      expect(stepping.step('/t/10', '/t/20')).toBe(false);
      expect(guard.allow).toHaveBeenCalledWith('/t/10', '/t/20');
      expect(navigate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2000);
      stepping.commit();
      expect(navigate).not.toHaveBeenCalled();
      expect(entries).toEqual(['/t/10']);
    });
    it('finishes what a gesture already stepped through when it is refused part-way', () => {
      vi.useFakeTimers();
      const { entries, guard, stepping } = guarded(true);
      stepping.step('/t/10', '/t/20');
      guard.allow.mockReturnValue(false);
      expect(stepping.step('/t/20', '/t/30')).toBe(false);
      // The origin entry is kept and the stepped route added, as for any finished gesture.
      expect(entries).toEqual(['/t/10', '/t/20']);
      expect(guard.authorized).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2000);
      expect(entries).toEqual(['/t/10', '/t/20']);
    });
    it('finishes an allowed gesture as the usual two history operations', () => {
      vi.useFakeTimers();
      const { entries, stepping } = guarded(true);
      expect(stepping.step('/t/10', '/t/20')).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(entries).toEqual(['/t/10', '/t/20']);
    });
    it('runs the history restore inside the authorized pass of the guard, and only that', () => {
      vi.useFakeTimers();
      const { navigate, guard, stepping } = guarded(true);
      const calls: string[] = [];
      guard.authorized.mockImplementation((run: () => void) => {
        calls.push('open');
        run();
        calls.push('close');
      });
      navigate.mockImplementation((path: string) => void calls.push(path));
      stepping.step('/t/10', '/t/20');
      expect(calls).toEqual(['/t/20']);
      vi.advanceTimersByTime(1000);
      expect(calls).toEqual(['/t/20', 'open', '/t/10', '/t/20', 'close']);
    });
    it('spends the allowance when something changed meanwhile: no history is rewritten', () => {
      vi.useFakeTimers();
      const { entries, navigate, stepping, bump } = guarded(true);
      stepping.step('/t/10', '/t/20');
      navigate.mockClear();
      bump();
      vi.advanceTimersByTime(1000);
      expect(navigate).not.toHaveBeenCalled();
      expect(entries).toEqual(['/t/20']);
    });
  });
  describe('language from a worklist link', () => {
    it('keeps a valid ?lang= in targets and drops line/variant highlights and invalid values', () => {
      expect(tooltipPath(20, '?lang=fr&line=3&variant=11')).toBe('/t/20?lang=fr');
      expect(tooltipPath(20, '?line=3')).toBe('/t/20');
      expect(tooltipPath(20, '?lang=xx')).toBe('/t/20');
      expect(tooltipPath(20, '')).toBe('/t/20');
    });
    it('steps from /t/1?lang=fr to /t/2?lang=fr, remembering the full origin', () => {
      const location = { pathname: '/t/10', search: '?lang=fr&line=3' };
      expect(stepTarget(location, 1, [10, 20, 30])).toEqual({
        from: '/t/10?lang=fr&line=3',
        to: { path: '/t/20?lang=fr', pathname: '/t/20', search: '?lang=fr' },
      });
      expect(stepTarget({ pathname: '/t/10', search: '' }, 1, [10, 20])?.to).toEqual({
        path: '/t/20',
        pathname: '/t/20',
        search: '',
      });
      expect(stepTarget(location, -1, [10, 20, 30])).toBeUndefined();
    });
    it('keeps ?lang= through Next, Next, and committed Back history without touching the dropdown', () => {
      vi.useFakeTimers();
      const { entries, stepping } = history();
      entries[0] = '/t/10?lang=fr&line=3';
      let location = { pathname: '/t/10', search: '?lang=fr&line=3' };
      for (const direction of [1, 1]) {
        const target = stepTarget(location, direction, [10, 20, 30]);
        expect(target).toBeDefined();
        stepping.step(target!.from, target!.to.path);
        location = target!.to;
      }
      expect(entries).toEqual(['/t/30?lang=fr']);
      vi.advanceTimersByTime(1000);
      expect(entries).toEqual(['/t/10?lang=fr&line=3', '/t/30?lang=fr']);
    });
  });
});

it('finds set names in 2pc/4pc order and hides set-conversion selectors', () => {
  const entry = {
    icon: '',
    inGameDescription: '',
    categoryId: 'armor-set-bonus',
    setName: 'Example Set',
    setHash: 901,
  };
  const editor: EditorData = {
    ...data,
    aliases: {},
    items: {
      701: { ...entry, hash: 701, name: 'A fourth perk', pieceCount: 4 },
      702: { ...entry, hash: 702, name: 'Z second perk', pieceCount: 2 },
      703: {
        hash: 703,
        name: 'Set Bonus: Example Set',
        icon: '',
        categoryId: 'armor-mod-general',
        inGameDescription:
          'Converts this armor to the Example Set armor set, reducing the requirements for its set bonus perks by 1',
      },
    },
  };
  expect(
    navigationGroups(editor, 'Example Set').flatMap((g) =>
      g.sections.flatMap((s) => s.items.map((i) => i.hash)),
    ),
  ).toEqual([702, 701]);
  expect(navigationGroups(editor, '703')).toEqual([]);
});
