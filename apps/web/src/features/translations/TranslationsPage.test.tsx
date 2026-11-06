// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { TranslationsPage } from './TranslationsPage';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import type { User } from '../../services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const stamp = { updatedBy: 'x' };
function tooltip(hash: number, en: string, de?: { source: string }): Tooltip {
  return {
    hash,
    associated: [],
    text: {
      en: { text: en, updatedAt: '2026-02-01T00:00:00.000Z', ...stamp },
      ...(de
        ? {
            de: {
              text: 'Zwei',
              updatedAt: '2026-01-01T00:00:00.000Z',
              sourceUpdatedAt: de.source,
              ...stamp,
            },
          }
        : {}),
    },
  };
}
const categories = [
  { id: 'perks', label: 'Perks', group: 'Weapons', order: 1 },
  { id: 'mods', label: 'Mods', group: 'Armor', order: 2 },
];
function build(tooltips: Tooltip[], names: Record<number, [string, string]>): EditorData {
  return {
    categories,
    items: Object.fromEntries(
      Object.entries(names).map(([hash, [name, categoryId]]) => [
        hash,
        { hash: Number(hash), name, icon: '', categoryId, inGameDescription: '' },
      ]),
    ),
    aliases: {},
    bundle: {
      sourceCommit: 'abc',
      generatedAt: '2026-02-01T00:00:00Z',
      tooltips: Object.fromEntries(tooltips.map((entry) => [entry.hash, entry])),
      permissions: { users: {} },
      pushed: {},
    },
  };
}
const small = build(
  [
    tooltip(1, 'English one'),
    tooltip(2, 'English two', { source: '2026-01-01T00:00:00.000Z' }),
    tooltip(3, 'English three', { source: '2026-02-01T00:00:00.000Z' }),
    tooltip(4, 'English four'),
  ],
  {
    1: ['Missing Perk', 'perks'],
    2: ['Outdated Perk', 'perks'],
    3: ['Current Perk', 'perks'],
    4: ['Missing Mod', 'mods'],
  },
);
const person = (role: User['role'], languages?: string[]) =>
  ({ login: 'person', role, languages }) as unknown as User;

let host: HTMLDivElement;
let root: Root;
let navigate: ReturnType<typeof useNavigate>;
let location: ReturnType<typeof useLocation>;

function Probe() {
  navigate = useNavigate();
  location = useLocation();
  return null;
}
let mounts = 0;
async function mount(path: string, user: User | null, data: EditorData = small) {
  useDataStore.setState({ status: 'ready', data });
  useAuthStore.setState({ user, loading: false });
  await act(async () =>
    root.render(
      <MemoryRouter key={mounts++} initialEntries={[path]}>
        <Probe />
        <Routes>
          <Route path="/translations" element={<TranslationsPage />} />
          <Route path="/t/:hash" element={<p>Editor</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}
const rows = () => [...host.querySelectorAll<HTMLAnchorElement>('li[data-index] a')];
const names = () => rows().map((row) => row.querySelector('span')?.textContent);
const press = (target: Element, key: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useAuthStore.setState({ user: null, loading: false });
});

describe('TranslationsPage queue', () => {
  it('lists what needs work in the assigned language and opens the editor in translate mode', async () => {
    await mount('/translations', person('translator', ['de']));
    expect(names()).toEqual(['Outdated Perk', 'Missing Perk', 'Missing Mod']);
    expect(rows().map((row) => row.getAttribute('href'))).toEqual([
      '/t/2?lang=de',
      '/t/1?lang=de',
      '/t/4?lang=de',
    ]);
    const text = host.textContent!;
    expect(text).toContain('Outdated · 31 d');
    expect(text).toContain('Missing');
    expect(text).not.toContain('Current Perk');
    expect(host.querySelector('select option[value="fr"]')).toBeNull();
    expect(host.querySelector('[role=group][aria-label="Coverage by language"]')).toBeNull();
    expect(host.querySelector('[role=status]')!.textContent).toBe('3 to translate');
    await act(async () => rows()[1]!.click());
    expect(location.pathname).toBe('/t/1');
    expect(location.search).toBe('?lang=de');
  });

  it('scopes a translator to assigned languages and defaults to the first', async () => {
    await mount('/translations', person('translator', ['fr', 'de']));
    const options = [...host.querySelectorAll('select')[0]!.querySelectorAll('option')];
    expect(options.map((option) => option.value)).toEqual(['de', 'fr']);
    expect(rows()[0]!.getAttribute('href')).toBe('/t/2?lang=de');
    await mount('/translations?lang=ja', person('translator', ['fr']));
    expect(rows()[0]!.getAttribute('href')).toBe('/t/3?lang=fr');
    expect(host.textContent).toContain('Japanese is not one of your assigned languages');
  });

  it('tells a translator without languages that nothing can be translated', async () => {
    await mount('/translations', person('translator', []));
    expect(host.textContent).toContain('You have no assigned languages');
    expect(rows()).toHaveLength(0);
  });

  it('shows maintainers and editors per-language coverage that picks the language', async () => {
    for (const role of ['maintainer', 'editor'] as const) {
      await mount('/translations', person(role));
      const coverage = host.querySelector('[role=group][aria-label="Coverage by language"]')!;
      const german = coverage.querySelector<HTMLButtonElement>('button[aria-label^="German"]')!;
      expect(german.getAttribute('aria-label')).toBe('German: 1 translated, 1 outdated, 2 missing');
      const french = coverage.querySelector<HTMLButtonElement>('button[aria-label^="French"]')!;
      expect(french.getAttribute('aria-label')).toBe('French: 0 translated, 0 outdated, 4 missing');
    }
    const coverage = host.querySelector('[role=group][aria-label="Coverage by language"]')!;
    await act(async () =>
      coverage.querySelector<HTMLButtonElement>('button[aria-label^="French"]')!.click(),
    );
    expect(location.search).toBe('?lang=fr');
    expect(rows().map((row) => row.getAttribute('href'))).toContain('/t/2?lang=fr');
    await act(async () =>
      coverage.querySelector<HTMLButtonElement>('button[aria-label^="German"]')!.click(),
    );
    expect(location.search).toBe('');
  });

  it('keeps language and filters in the URL and applies them', async () => {
    await mount('/translations?lang=de&state=missing&cat=mods', person('maintainer'));
    expect(names()).toEqual(['Missing Mod']);
    expect(host.querySelector('[role=status]')!.textContent).toBe('1 of 3');
    const pressed = [...host.querySelectorAll('[aria-pressed=true]')].map((b) => b.textContent);
    expect(pressed).toContain('Missing 2');
    await mount('/translations?lang=de&q=outdated', person('maintainer'));
    expect(names()).toEqual(['Outdated Perk']);
    await mount('/translations?lang=de&q=nothing', person('maintainer'));
    expect(host.textContent).toContain('No tooltips match these filters.');
    await act(async () =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Clear filters')!.click(),
    );
    expect(location.search).toBe('?lang=de');
    expect(names()).toHaveLength(3);
  });

  it('says so when there is nothing to translate', async () => {
    const done = build([tooltip(3, 'English three', { source: '2026-02-01T00:00:00.000Z' })], {
      3: ['Current Perk', 'perks'],
    });
    await mount('/translations?lang=de', person('maintainer'), done);
    expect(host.textContent).toContain('Nothing to translate in German.');
  });

  it('moves the selection with the arrow keys, keeping one tab stop', async () => {
    await mount('/translations', person('translator', ['de']));
    const stops = () => rows().filter((row) => row.tabIndex === 0);
    expect(stops()).toHaveLength(1);
    expect(stops()[0]!.textContent).toContain('Outdated Perk');
    await press(rows()[0]!, 'ArrowDown');
    expect(stops()[0]!.textContent).toContain('Missing Perk');
    expect(document.activeElement).toBe(stops()[0]);
    await press(document.activeElement!, 'End');
    expect(stops()[0]!.textContent).toContain('Missing Mod');
    await press(document.activeElement!, 'ArrowDown');
    expect(stops()[0]!.textContent).toContain('Missing Mod');
    await press(document.activeElement!, 'Home');
    expect(stops()[0]!.textContent).toContain('Outdated Perk');
    await press(document.activeElement!, 'ArrowUp');
    expect(stops()[0]!.textContent).toContain('Outdated Perk');
  });

  it('opens the first match with Enter in the filter field', async () => {
    await mount('/translations?lang=de', person('translator', ['de']));
    const input = host.querySelector<HTMLInputElement>('input[type=search]')!;
    await press(input, 'Enter');
    expect(location.pathname).toBe('/t/2');
  });

  it('keeps focus and every typed character in the filter while the list refilters', async () => {
    const many = build(
      Array.from({ length: 300 }, (_, i) => tooltip(100 + i, `English ${i}`)),
      Object.fromEntries(
        Array.from({ length: 300 }, (_, i) => [
          100 + i,
          [`Tooltip ${String(i).padStart(3, '0')}`, 'perks'],
        ]),
      ),
    );
    await mount('/translations', person('translator', ['de']), many);
    const input = host.querySelector<HTMLInputElement>('input[type=search]')!;
    act(() => input.focus());
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    let typed = '';
    for (const character of 'tooltip 02') {
      typed += character;
      await act(async () => {
        setter.call(input, typed);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe(typed);
    }
    expect(names()[0]).toBe('Tooltip 020');
    await press(input, 'Enter');
    expect(location.pathname).toBe('/t/120');
  });

  it('keeps a filter typed just before opening a row when coming Back', async () => {
    const type = async (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    await mount('/translations', person('maintainer'));
    const input = () => host.querySelector<HTMLInputElement>('input[type=search]')!;
    // Enter in the field, then Back.
    await type(input(), 'missing mod');
    await press(input(), 'Enter');
    expect(location.pathname).toBe('/t/4');
    await act(async () => void navigate(-1));
    expect(location.search).toContain('q=missing+mod');
    expect(input().value).toBe('missing mod');
    expect(names()).toEqual(['Missing Mod']);
    expect(host.querySelector('a[data-selected]')!.textContent).toContain('Missing Mod');
    // Clicking a row inside the debounce, then Back.
    await type(input(), 'perk');
    await act(async () => rows()[0]!.click());
    expect(location.pathname).toMatch(/^\/t\//);
    await act(async () => void navigate(-1));
    expect(location.search).toContain('q=perk');
    expect(input().value).toBe('perk');
    // A non-first result opened inside the debounce is still the selected row on Back.
    await type(input(), 'perk');
    await type(input(), 'mod');
    await type(input(), '');
    await type(input(), 'e');
    const second = rows()[1]!;
    const label = second.textContent;
    await act(async () => second.click());
    await act(async () => void navigate(-1));
    expect(host.querySelector('a[data-selected]')!.textContent).toBe(label);
  });

  it('selects the first match on Back after Enter, whatever was selected before', async () => {
    const type = async (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    await mount('/translations', person('translator', ['de']));
    const input = () => host.querySelector<HTMLInputElement>('input[type=search]')!;
    await type(input(), 'perk');
    const [first, second] = rows().map((row) => row.textContent);
    await act(async () => rows()[1]!.click());
    await act(async () => void navigate(-1));
    expect(host.querySelector('a[data-selected]')!.textContent).toBe(second);
    await press(input(), 'Enter');
    await act(async () => void navigate(-1));
    expect(host.querySelector('a[data-selected]')!.textContent).toBe(first);
  });

  it('returns from the editor to the same selection and scroll position', async () => {
    const many = build(
      Array.from({ length: 300 }, (_, i) => tooltip(100 + i, `English ${i}`)),
      Object.fromEntries(
        Array.from({ length: 300 }, (_, i) => [
          100 + i,
          [`Tooltip ${String(i).padStart(3, '0')}`, 'perks'],
        ]),
      ),
    );
    await mount('/translations', person('translator', ['de']), many);
    expect(rows().length).toBeLessThan(60);
    act(() => rows()[0]!.focus());
    for (let step = 0; step < 40; step++) await press(document.activeElement!, 'ArrowDown');
    // jsdom has no layout: the key handler moved the window and the selection.
    expect(rows().some((row) => row.textContent?.includes('Tooltip 040'))).toBe(true);
    const selected = host.querySelector('a[data-selected]')!.textContent;
    const scroller = host.querySelector<HTMLElement>('[class*=viewport]')!;
    scroller.scrollTop = 600;
    await act(async () => scroller.dispatchEvent(new Event('scroll')));
    await act(async () =>
      rows()
        .find((row) => row.tabIndex === 0)!
        .click(),
    );
    expect(location.pathname).toMatch(/^\/t\//);
    await act(async () => void navigate(-1));
    expect(location.pathname).toBe('/translations');
    expect(host.querySelector('a[data-selected]')!.textContent).toBe(selected);
    expect(document.activeElement).toBe(host.querySelector('a[data-selected]'));
    expect(host.querySelector<HTMLElement>('[class*=viewport]')!.scrollTop).toBe(600);
  });

  it('renders a bounded window for a long queue', async () => {
    const count = 2500;
    const long = build(
      Array.from({ length: count }, (_, i) => tooltip(1000 + i, `English ${i}`)),
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [1000 + i, [`Tooltip ${i}`, 'perks']]),
      ),
    );
    await mount('/translations', person('translator', ['de']), long);
    expect(rows().length).toBeLessThan(60);
    expect(host.querySelector('li[data-index]')!.getAttribute('aria-setsize')).toBe(String(count));
    expect(host.querySelector<HTMLElement>('ul[aria-label]')!.style.height).toBe(`${count * 32}px`);
  });
});
