import { beforeEach, expect, it, vi } from 'vitest';
import { publishableHash, type Tooltip } from '@clarity/core';
import { loadGenerator } from '../../services/generator';
import { loadBundle, type Bundle } from '../../services/bundle';
import { pushSelected } from '../../services/history';
import { acceptSaved } from '../../services/save/drafts';
import { useDraftStore } from '../../stores/drafts';
import {
  applySavedOverlay,
  clearSavedOverlay,
  overlayTtlMs,
  rememberSaved,
} from '../../stores/savedOverlay';
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
  clearSavedOverlay();
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

it('a manual refresh against a stale bundle keeps saved text from this tab until the bundle catches up', async () => {
  const saved = make('New');
  const base = {
    items: { 10: { hash: 10, name: 'Demo', categoryId: 'perk', icon: '', inGameDescription: '' } },
    categories: [{ id: 'perk', label: 'Perks', group: 'Weapons', order: 1 }],
    aliases: {},
  };
  vi.mocked(loadGenerator).mockResolvedValue(base as never);
  const stale: Bundle = {
    sourceCommit: 'old',
    generatedAt: at,
    tooltips: { 10: make('Old') },
    pushed: {},
    permissions: { users: {} },
  };
  vi.mocked(loadBundle).mockResolvedValue(stale);
  useDataStore.setState({
    status: 'ready',
    data: { ...base, bundle: stale } as never,
    error: null,
  });
  acceptSaved({}, [saved], 'saved-commit');
  const digest = await publishableHash(saved);
  const entries = await pendingTooltips(useDataStore.getState().data!);
  vi.mocked(pushSelected).mockResolvedValue({ branch: 'live', pushed: { 10: digest } } as never);
  await publishReviewed(entries, useDataStore.getState().data!, () => true);

  await useDataStore.getState().load(); // CDN still serves the pre-save bundle
  const after = useDataStore.getState().data!;
  expect(after.bundle.tooltips[10].text.en?.text).toBe('New');
  expect(await pendingTooltips(after, acknowledgedMarkers(after))).toEqual([]);

  // The bundle catches up (new text + marker): overlay retires, nothing is pending.
  vi.mocked(loadBundle).mockResolvedValue({
    ...stale,
    tooltips: { 10: saved },
    pushed: { 10: digest },
  });
  await useDataStore.getState().load();
  const caught = useDataStore.getState().data!;
  expect(caught.bundle.tooltips[10].text.en?.text).toBe('New');
  expect(applySavedOverlay(caught.bundle)).toBe(caught.bundle);
  expect(await pendingTooltips(caught, acknowledgedMarkers(caught))).toEqual([]);
});

it('saved overlay expires after the TTL so newer edits by others show up, and handles deletes', () => {
  const bundle: Bundle = {
    sourceCommit: 'c',
    generatedAt: at,
    tooltips: { 10: make('Fetched'), 11: { ...make('Gone'), hash: 11 } },
    pushed: {},
    permissions: { users: {} },
  };
  rememberSaved([make('Mine')], [11], 1000);
  const fresh = applySavedOverlay(bundle, 1000 + 1000);
  expect(fresh.tooltips[10].text.en?.text).toBe('Mine');
  expect(fresh.tooltips[11]).toBeUndefined();
  expect(bundle.tooltips[10].text.en?.text).toBe('Fetched'); // input not mutated
  const expired = applySavedOverlay(bundle, 1000 + overlayTtlMs + 1);
  expect(expired).toBe(bundle);
});
