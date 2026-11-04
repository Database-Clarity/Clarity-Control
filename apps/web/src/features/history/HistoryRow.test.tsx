// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { HistoryPanel } from './HistoryPanel';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';

const getHistory = vi.fn();
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  apiUrl: 'https://api.test',
}));
vi.mock('../../services/history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/history')>()),
  getHistory: (...args: unknown[]) => getHistory(...args),
}));

const commit = (n: number) => ({
  commit: n.toString(16).padStart(40, '0'),
  author: 'Ann',
  date: '2026-10-27T00:00:00Z',
  message: `Edit ${n}`,
});
const tooltip: Tooltip = {
  hash: 10,
  associated: [],
  text: { en: { text: 'x', updatedAt: '2026-10-27T10:00:00Z', updatedBy: 'ann' } },
};
let host: HTMLDivElement;
let root: Root;
const originals = {
  data: useDataStore.getState(),
  auth: useAuthStore.getState(),
  drafts: useDraftStore.getState(),
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  getHistory.mockReset();
  useDataStore.setState({
    data: {
      bundle: { tooltips: { 10: tooltip } },
      items: {},
      aliases: {},
      categories: [],
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

it('is one collapsed row: Edited <date> by <author>, n revisions', async () => {
  getHistory.mockResolvedValue({ page: 1, commits: [commit(1), commit(2), commit(3)] });
  await act(async () => root.render(<HistoryPanel hash={10} />));
  expect(host.textContent ?? '').toMatch(/^History\s*Edited .* by ann, 3 revisions$/);
  expect(host.querySelector('button[aria-expanded="false"]')).not.toBeNull();
  // The commit list is not in the row until it is expanded.
  expect(host.querySelector('ol')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
  expect(host.querySelectorAll('ol li')).toHaveLength(3);
});

it('says 30+ when a full page of commits came back', async () => {
  getHistory.mockResolvedValue({
    page: 1,
    commits: Array.from({ length: 30 }, (_, i) => commit(i + 1)),
  });
  await act(async () => root.render(<HistoryPanel hash={10} />));
  expect(host.textContent).toContain('30+ revisions');
});

it('does not ask the server when signed out, and says so when expanded', async () => {
  useAuthStore.setState({ user: null });
  await act(async () => root.render(<HistoryPanel hash={10} />));
  expect(getHistory).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Edited');
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
  expect(host.textContent).toContain('Sign in as a configured member');
});

it('uses one list request across expansion and refreshes stale rows on reopening', async () => {
  getHistory.mockResolvedValue({ page: 1, commits: [commit(1)] });
  await act(async () => root.render(<HistoryPanel hash={10} />));
  const toggle = () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click();
  await act(async () => toggle());
  expect(getHistory).toHaveBeenCalledTimes(1);
  await act(async () => toggle());
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 61_000);
  getHistory.mockResolvedValue({ page: 1, commits: [commit(2), commit(1)] });
  await act(async () => toggle());
  expect(host.querySelectorAll('ol li')).toHaveLength(2);
  expect(getHistory).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
