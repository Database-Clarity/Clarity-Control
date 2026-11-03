// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsSync } from './SettingsSync';
import { useAuthStore } from '../../stores/auth';
import { useSettingsStore } from '../../stores/settings';

const activate = vi.fn(async () => {});
const alice = { id: 1, login: 'alice', role: 'editor' as const };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  activate.mockClear();
  useSettingsStore.setState({ activate });
  useAuthStore.setState({ user: alice, loading: false });
});
afterEach(() => vi.restoreAllMocks());

it('activates settings once per account and role, not on every auth reload', async () => {
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(SettingsSync)));
  expect(activate).toHaveBeenCalledTimes(1);

  // A reload of the same account (storage event, retry, permission save).
  await act(async () => useAuthStore.setState({ loading: true }));
  await act(async () => useAuthStore.setState({ user: { ...alice }, loading: false }));
  expect(activate).toHaveBeenCalledTimes(1);

  await act(async () => useAuthStore.setState({ user: { ...alice, role: 'trial' } }));
  expect(activate).toHaveBeenCalledTimes(2);
  await act(async () => useAuthStore.setState({ user: null }));
  expect(activate).toHaveBeenLastCalledWith(null);
  await act(async () => root.unmount());
});
