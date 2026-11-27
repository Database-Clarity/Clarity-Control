// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Marks } from '@clarity/core/marks';
import { apiRequest } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { useMarksStore } from '../marks/store';
import { EditorPaneHeader } from './EditorPaneHeader';

vi.mock('../../services/api', () => ({ apiUrl: 'https://api.test', apiRequest: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const at = '2026-11-15T00:00:00Z';
let state: Marks;
let host: HTMLDivElement;
let root: Root;
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) =>
      element.getAttribute('aria-label') === name || element.textContent?.trim() === name,
  );
const click = (element: HTMLElement | undefined) => act(async () => element!.click());

beforeEach(() => {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  // The marks' names are 200px; the compact "Marks (1)" 50px; the line has 100px.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const width = (element: Element): number => {
      const spill = (element as HTMLElement).dataset?.spill;
      if (spill === 'marksLabels') return 200;
      if (spill === 'marks') return 50;
      if (element.hasAttribute('data-tool-fit'))
        return [...element.children].reduce((sum, child) => sum + width(child), 0);
      return 0;
    };
    const value = width(this);
    return { width: value, height: 24, top: 0, left: 0, right: value, bottom: 24 } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 100);
  state = {
    types: [{ id: 'contradiction', label: 'Compendium contradiction', colour: 'red', by: 1, at }],
    entries: { 42: [{ type: 'contradiction', note: 'Burst radius', by: 2, at }] },
  };
  useAuthStore.setState({ user: { id: 1, login: 'alice', role: 'maintainer' }, token: 'token' });
  useMarksStore.getState().accept(structuredClone(state));
  vi.mocked(apiRequest).mockImplementation(async (_path, init) => {
    if (init?.method === 'PUT') {
      const change = JSON.parse(init.body as string).change;
      if (change.action === 'unmark') delete state.entries[42];
      if (change.action === 'mark')
        state.entries[42] = [{ type: change.type, note: change.note, by: 1, at }];
    }
    return Response.json({ marks: state, revision: 'a'.repeat(40) });
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps the compact Marks popover open with Undo when its only mark is resolved', async () => {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <EditorPaneHeader
          lang="en"
          onLanguage={() => {}}
          draft={false}
          saving={false}
          onDiscard={() => {}}
          reason={null}
          onSwitch={() => {}}
          overrides={[]}
          activeOverride={undefined}
          onEditOverride={() => {}}
          onBack={() => {}}
          markHash={42}
        />
      </MemoryRouter>,
    ),
  );
  // The names did not fit: the line shows the count, and More holds nothing.
  const trigger = button('Entry marks')!;
  expect(trigger.textContent).toBe('Marks (1)');
  expect(button('More editor tools')).toBeUndefined();
  await click(trigger);
  await click(button('Resolve Compendium contradiction'));
  expect(useMarksStore.getState().index.get(42)).toBeUndefined();
  // Still open, in place, with Undo (the control was not remounted into More).
  expect(document.querySelector('[data-entry-marks-popup] [data-resolved]')).not.toBeNull();
  expect(button('More editor tools')).toBeUndefined();
  expect(document.activeElement).toBe(button('Undo: restore Compendium contradiction'));
  await click(button('Undo: restore Compendium contradiction'));
  expect(useMarksStore.getState().index.get(42)).toMatchObject([
    { type: 'contradiction', note: 'Burst radius' },
  ]);
  expect(button('Resolve Compendium contradiction')).toBeDefined();
});
