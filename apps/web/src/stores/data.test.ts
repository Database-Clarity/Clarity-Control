import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDataStore } from './data';
import { clearSavedOverlay, rememberSaved } from './savedOverlay';
import { loadBundle } from '../services/bundle';
import { loadGenerator } from '../services/generator';

vi.mock('../services/bundle', () => ({ loadBundle: vi.fn() }));
vi.mock('../services/generator', () => ({ loadGenerator: vi.fn() }));

describe('editor data loading', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearSavedOverlay();
    useDataStore.setState({ status: 'idle', data: null, error: null });
  });
  it('exposes loading and ready only after both sources finish, deduplicating in-flight loads', async () => {
    const catalog = {
      categories: [],
      items: {},
      aliases: {},
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
  it('applies saves made during fetch resolution and retires them on a newer bundle', async () => {
    const at = Date.parse('2026-11-01T00:00:00Z');
    const tooltip = (text: string) => ({
      hash: 10,
      text: { en: { text, updatedAt: new Date(at).toISOString(), updatedBy: 'user' } },
      associated: [],
    });
    const stale = {
      sourceCommit: 'abc',
      generatedAt: new Date(at).toISOString(),
      tooltips: { 10: tooltip('old') },
      permissions: { users: {} },
      pushed: {},
    };
    vi.mocked(loadGenerator).mockResolvedValue({ categories: [], items: {}, aliases: {} });
    let resolve!: (value: typeof stale) => void;
    vi.mocked(loadBundle).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const loading = useDataStore.getState().load();
    rememberSaved([tooltip('mine')], [], Date.now());
    resolve(stale);
    await loading;
    expect(useDataStore.getState().data?.bundle.tooltips[10]).toEqual(tooltip('mine'));
    vi.mocked(loadBundle).mockResolvedValue({
      ...stale,
      generatedAt: new Date(Date.now() + 61000).toISOString(),
      tooltips: { 10: tooltip('theirs') },
    });
    await useDataStore.getState().load();
    expect(useDataStore.getState().data?.bundle.tooltips[10]).toEqual(tooltip('theirs'));
  });
});
