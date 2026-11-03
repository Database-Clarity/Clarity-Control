// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { AssociationsPanel } from './AssociationsPanel';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  apiUrl: 'https://api.test',
}));
const tip = (hash: number, associated: number[] = []): Tooltip => ({
  hash,
  associated,
  text: {},
});
const item = (hash: number, name: string) => ({
  hash,
  name,
  icon: '',
  categoryId: 'c',
  inGameDescription: '',
});
let host: HTMLDivElement;
let root: Root;
const originals = {
  data: useDataStore.getState(),
  auth: useAuthStore.getState(),
  drafts: useDraftStore.getState(),
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useDataStore.setState({
    data: {
      categories: [{ id: 'c', label: 'C', group: 'G', order: 1 }],
      items: { 10: item(10, 'Alpha'), 20: item(20, 'Beta'), 21: item(21, 'Gamma') },
      aliases: {},
      bundle: { tooltips: { 10: tip(10, [20, 21]), 20: tip(20), 21: tip(21) } },
    } as unknown as EditorData,
  });
  useDraftStore.setState({ drafts: {}, hydrated: true });
  useAuthStore.setState({ user: { id: 1, login: 'ann', role: 'editor' } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useDataStore.setState(originals.data);
  useAuthStore.setState(originals.auth);
  useDraftStore.setState(originals.drafts);
});
const render = () =>
  act(async () =>
    root.render(
      <MemoryRouter>
        <AssociationsPanel hash={10} />
      </MemoryRouter>,
    ),
  );

it('is a compact row: count, the names, and Add; the list opens in place', async () => {
  await render();
  expect(host.textContent).toContain('Associated tooltips (2)');
  expect(host.textContent).toContain('Beta · Gamma');
  expect(host.querySelector('[aria-label="Add associated tooltip"]')).not.toBeNull();
  expect(host.querySelector('ol')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
  expect(host.querySelectorAll('ol li')).toHaveLength(2);
  expect(host.querySelector('[aria-label="Remove Beta"]')).not.toBeNull();
});

it('Add opens the row with the search; signed out hides Add and nothing else', async () => {
  await render();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Add associated tooltip"]')!.click(),
  );
  expect(host.querySelector('input[type="search"]')).not.toBeNull();
  useAuthStore.setState({ user: null });
  await render();
  expect(host.querySelector('[aria-label="Add associated tooltip"]')).toBeNull();
  expect(host.textContent).toContain('Associated tooltips (2)');
  expect(host.textContent).toContain('Beta · Gamma');
  expect(host.querySelector('button[aria-expanded]')).not.toBeNull();
});
