import { afterEach, expect, it, vi } from 'vitest';

afterEach(async () => {
  const { useAuthStore } = await import('../../stores/auth');
  useAuthStore.setState({ user: null });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('follows the authenticated Worker report, including on, off, legacy, and signed-out states', async () => {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', 'https://worker.example');
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('sessionStorage', { getItem: () => null });
  const { getMe } = await import('../apiAuth');
  const { useAuthStore } = await import('../../stores/auth');
  const { preparationEnabled } = await import('./flag');
  for (const reported of [true, false, undefined, true]) {
    vi.stubGlobal('fetch', async () =>
      Response.json({ id: 1, login: 'm', role: 'maintainer', schedulePreparation: reported }),
    );
    useAuthStore.setState({ user: await getMe() });
    expect(preparationEnabled()).toBe(reported === true);
  }
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '0');
  expect(preparationEnabled()).toBe(false);
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  useAuthStore.setState({ user: null });
  expect(preparationEnabled()).toBe(false);
});
