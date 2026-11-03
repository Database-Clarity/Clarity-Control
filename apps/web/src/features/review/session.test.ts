import { beforeEach, expect, it, vi } from 'vitest';
import { publishableHash, type Tooltip } from '@clarity/core';
import { loadBundle, type Bundle } from '../../services/bundle';
import { pushSelected } from '../../services/history';
import { acceptSaved } from '../../services/save/drafts';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { pendingTooltips } from './model';
import { acknowledgedMarkers, publishReviewed } from './session';

vi.mock('../../services/bundle', () => ({ loadBundle: vi.fn() }));
vi.mock('../../services/generator', () => ({ loadGenerator: vi.fn() }));
vi.mock('../../services/history', () => ({ pushSelected: vi.fn() }));

const at = '2026-01-01T00:00:00Z';
const make = (text: string): Tooltip => ({
  hash: 10,
  text: { en: { text, updatedAt: at, updatedBy: 'fixture' } },
  associated: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  useDraftStore.setState({ hydrated: true, drafts: {} });
  useAuthStore.setState({ user: { id: 1, login: 'fixture', role: 'maintainer' } });
});

it('keeps saved text and does not re-list pushed tooltips when the bundle is stale after a push', async () => {
  const old = make('Old');
  const saved = make('New');
  const staleBundle: Bundle = {
    sourceCommit: 'old',
    generatedAt: at,
    tooltips: { 10: old },
    pushed: {},
    permissions: { users: {} },
  };
  const data: EditorData = {
    items: { 10: { hash: 10, name: 'Demo', categoryId: 'perk', icon: '', inGameDescription: '' } },
    categories: [{ id: 'perk', label: 'Perks', group: 'Weapons', order: 1 }],
    aliases: {},
    bundle: staleBundle,
  };
  useDataStore.setState({ status: 'ready', data, error: null });
  // The CDN keeps serving the pre-save bundle.
  vi.mocked(loadBundle).mockResolvedValue(staleBundle);
  acceptSaved({}, [saved], 'saved-commit');
  const current = useDataStore.getState().data!;
  expect(current.bundle.tooltips[10].text.en?.text).toBe('New');
  const entries = await pendingTooltips(current);
  const digest = await publishableHash(saved);
  vi.mocked(pushSelected).mockResolvedValue({ branch: 'live', pushed: { 10: digest } } as never);

  expect(await publishReviewed(entries, current, () => true)).toBe(true);

  expect(loadBundle).not.toHaveBeenCalled();
  const after = useDataStore.getState().data!;
  expect(after.bundle.tooltips[10].text.en?.text).toBe('New');
  expect(await pendingTooltips(after, acknowledgedMarkers(after))).toEqual([]);
});
