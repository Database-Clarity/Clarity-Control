import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDataStore } from './data';
import { loadBundle } from '../services/bundle';
import { englishWeaponTypeLabels } from '@clarity/core';
import { loadGenerator } from '../services/generator';

vi.mock('../services/bundle', () => ({ loadBundle: vi.fn() }));
vi.mock('../services/generator', () => ({ loadGenerator: vi.fn() }));

describe('editor data loading', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useDataStore.setState({ status: 'idle', data: null, error: null });
  });
  it('exposes loading and ready only after both sources finish, deduplicating in-flight loads', async () => {
    const catalog = {
      categories: [],
      items: {},
      aliases: {},
      weaponTypeLabels: englishWeaponTypeLabels,
    };
    const bundle = {
      sourceCommit: 'abc',
      generatedAt: '2026-10-27T00:00:00Z',
      tooltips: {},
      permissions: { users: {} },
      pushed: {},
    };
    let resolveCatalog!: (value: typeof catalog) => void;
    vi.mocked(loadGenerator).mockReturnValue(
      new Promise((resolve) => {
        resolveCatalog = resolve;
      }),
    );
    vi.mocked(loadBundle).mockResolvedValue(bundle);
    const loading = useDataStore.getState().load();
    expect(useDataStore.getState().status).toBe('loading');
    await useDataStore.getState().load();
    expect(loadGenerator).toHaveBeenCalledTimes(1);
    expect(useDataStore.getState().data).toBeNull();
    resolveCatalog(catalog);
    await loading;
    expect(useDataStore.getState()).toMatchObject({
      status: 'ready',
      data: { ...catalog, bundle },
      error: null,
    });
  });
  it('surfaces source errors instead of showing an empty success and allows retry', async () => {
    vi.mocked(loadGenerator).mockResolvedValue({
      categories: [],
      items: {},
      aliases: {},
      weaponTypeLabels: englishWeaponTypeLabels,
    });
    vi.mocked(loadBundle).mockRejectedValueOnce(new Error('bundle HTTP404'));
    await useDataStore.getState().load();
    expect(useDataStore.getState()).toMatchObject({
      status: 'error',
      data: null,
      error: 'bundle HTTP404',
    });
    vi.mocked(loadBundle).mockResolvedValue({
      sourceCommit: 'abc',
      generatedAt: '2026-10-27T00:00:00Z',
      tooltips: {},
      permissions: { users: {} },
      pushed: {},
    });
    await useDataStore.getState().load();
    expect(useDataStore.getState().status).toBe('ready');
  });
});
