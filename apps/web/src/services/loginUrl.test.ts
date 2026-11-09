import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('loginUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_API_URL', 'https://worker.example/');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const urlFor = async (location: { origin: string; hostname: string }) => {
    vi.stubGlobal('location', location);
    return (await import('./api')).loginUrl();
  };

  it.each([
    ['the legacy site', 'https://database-clarity.github.io', 'database-clarity.github.io'],
    ['local development', 'http://localhost:5173', 'localhost'],
    ['a loopback preview', 'http://127.0.0.1:4173', '127.0.0.1'],
  ])('sends nothing extra from %s (the URL is unchanged)', async (_name, origin, hostname) => {
    expect(await urlFor({ origin, hostname })).toBe('https://worker.example/auth/login');
  });

  it('names the starting site when it is any other origin', async () => {
    expect(
      await urlFor({ origin: 'https://control.d2clarity.com', hostname: 'control.d2clarity.com' }),
    ).toBe('https://worker.example/auth/login?site=https%3A%2F%2Fcontrol.d2clarity.com');
  });
});
