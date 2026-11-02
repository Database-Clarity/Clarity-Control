// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LostTextPage } from './LostTextPage';
import artifact from './lost-text.json';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useSettingsStore } from '../../stores/settings';

vi.mock('../preview/TooltipPreview', () => ({
  TooltipPreview: ({ text }: { text: string }) => <div>{text}</div>,
}));
let root: Root;
let container: HTMLDivElement;
const hash = 1885400500;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  });
  useAuthStore.setState({ user: { id: 1, login: 'editor', role: 'editor' }, loading: false });
  useDraftStore.setState({ drafts: {}, hydrated: true, retry: vi.fn() });
  useDataStore.setState({
    data: {
      items: {},
      categories: [],
      aliases: {},
      bundle: {
        sourceCommit: artifact.sourceCommit,
        generatedAt: '',
        permissions: { users: {} },
        pushed: {},
        tooltips: {
          [hash]: {
            hash,
            associated: [],
            text: { en: { text: '', updatedBy: 'old', updatedAt: '2026-01-01T00:00:00Z' } },
          },
        },
      },
    } as EditorData,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function render(route = '/lost-text') {
  act(() =>
    root.render(
      <MemoryRouter initialEntries={[route]}>
        <LostTextPage />
      </MemoryRouter>,
    ),
  );
}
function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(label),
  );
  expect(button).toBeTruthy();
  act(() => button!.click());
}
it('opens detail, renders old/current text and recovers only into a local draft', () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  render();
  click('Ricochet Rounds');
  expect(container.textContent).toContain('Current saved text: (blank)');
  expect(container.querySelector('a[href*="/commit/"]')).toBeTruthy();
  click('Recover as draft');
  expect(useDraftStore.getState().drafts[hash].next.text.en?.text).toContain('sharper angles');
  expect(container.textContent).toContain('Recovered as a local draft');
  expect(fetch).not.toHaveBeenCalled();
});
it('dismisses locally and can show dismissed records again', () => {
  render('/lost-text?item=1885400500:en');
  click('Dismiss');
  expect(localStorage.getItem('clarity-lost-text:v1:1')).toContain('1885400500:en');
  expect(container.textContent).not.toContain('en · human');
  const input = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0];
  act(() => input.click());
  expect(container.textContent).toContain('en · human');
});
it('shows staleness, empty and storage-error states', () => {
  useDataStore.setState(({ data }) => ({
    data: { ...data!, bundle: { ...data!.bundle, sourceCommit: 'new', tooltips: {} } },
  }));
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  render();
  expect(container.textContent).toContain('regenerate');
  expect(container.textContent).toContain('No blank tooltips with earlier authored text found.');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be loaded');
});
it.each(['trial', null] as const)('hides recovery and dismissal for %s', (role) => {
  useAuthStore.setState({ user: { id: 2, login: 'reader', role } });
  render('/lost-text?item=1885400500:en');
  expect(container.textContent).not.toContain('Recover as draft');
  expect(container.textContent).not.toContain('>Dismiss<');
  expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Dismiss')).toBe(
    false,
  );
});

it('redirects translators away from a direct checker URL', () => {
  useAuthStore.setState({
    user: { id: 3, login: 'translator', role: 'translator', languages: ['de'] },
  });
  render();
  expect(container.textContent).not.toContain('Lost-tooltip checker');
});

it('explains classes, action consequences and dates before taking an action', () => {
  useSettingsStore.getState().update({ dateFormat: 'dmy', timeZone: 'UTC', timeDisplay: 'date' });
  render('/lost-text?item=1885400500:en');
  expect(container.textContent).toContain('Historical text (last non-empty)');
  expect(container.textContent).not.toContain('Recovered text');
  expect(container.textContent).toContain('Recover creates an unsaved local draft');
  expect(container.textContent).toContain('in this browser only');
  expect(container.textContent).toContain('2 of 480 records shown');
  expect(container.querySelector('time')?.textContent).toBe('12 Feb 2023');
  expect(container.querySelector('time')?.title).toBe('2023-02-12T20:12:46+01:00');
  expect(container.textContent).toContain(
    'Unclear — authorship or manifest evidence is inconclusive',
  );
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
});
it('selects copies directly without an overlapping include-copies checkbox', () => {
  render();
  const select = container.querySelector('select')!;
  act(() => {
    select.value = 'manifest-copy';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.textContent).toContain('0 of 480 records shown');
  act(() => {
    select.value = 'human';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.textContent).toContain('2 of 480 records shown');
});
