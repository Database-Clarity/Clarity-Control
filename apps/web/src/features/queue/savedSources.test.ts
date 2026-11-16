// @vitest-environment jsdom
import { useAuthStore } from '../../stores/auth';
const api = vi.hoisted(() => vi.fn());
vi.mock('../../services/apiAuth', () => ({ apiRequest: api }));
import { afterEach, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { setEditorDraftFetch } from '../../services/editorDrafts';
import { draftGroups, draftItems, savedItems, worklistAvailable } from './savedSources';
import { queueSources } from './sources';
import { startQueue } from './start';
import { useWorkQueues, resetWorkQueues } from './store';
import { useSavedWorklists } from './worklists';
const data = (): EditorData => ({
  items: {
    11: { hash: 11, name: 'Alpha', icon: '', categoryId: 'perks', inGameDescription: '' },
    12: { hash: 12, name: 'Beta', icon: '', categoryId: 'perks', inGameDescription: '' },
  },
  aliases: {},
  categories: [],
  bundle: {
    tooltips: {},
    sourceCommit: 'a',
    generatedAt: '',
    permissions: { users: {} },
    pushed: {},
  },
});
afterEach(() => {
  setEditorDraftFetch(undefined);
  resetWorkQueues();
});
const sessionToken = `${btoa(JSON.stringify({ exp: 4102444800 }))}.test`;
it('takes Drafts membership from the loader index and only saved English completes it', async () => {
  const current = data();
  setEditorDraftFetch(async () => Response.json({ schemaVersion: 1, hashes: [11, 12, 999] }));
  current.bundle.tooltips[12] = {
    hash: 12,
    text: { en: { text: 'Saved English' } },
    associated: [],
  } as unknown as Tooltip;
  const items = await draftItems(current);
  expect(items.map((item) => item.hash)).toEqual([11]);
  const test = queueSources.drafts.done({ data: current, user: null, decisions: {} });
  expect(test(items[0]!, {})).toBe(false);
  expect(test(items[0]!, { 11: { next: current.bundle.tooltips[12]! } } as never)).toBe(false);
  current.bundle.tooltips[11] = { ...current.bundle.tooltips[12]!, hash: 11 };
  expect(test(items[0]!, {})).toBe(true);
});
it('reuses the queue, freezes membership, preserves the save baseline, and rebuilds explicitly', async () => {
  const current = data();
  sessionStorage.setItem('clarity-editor-session', sessionToken);
  useAuthStore.setState({
    user: { id: 1, login: 'one', role: 'editor' } as never,
    loading: false,
    token: sessionToken,
  });
  useSavedWorklists.setState({ scope: '1', index: {}, saving: [], failed: [] });
  const entry = { hash: 11, name: 'Alpha' };
  const items = savedItems([entry], current);
  useSavedWorklists.setState({
    lists: [{ id: 'b4d6ed22-4e98-4f25-a55f-11d529c9ae97', name: 'Weekend', items: [entry] }],
    loaded: ['list'],
  });
  useSavedWorklists.setState({ loaded: ['list'] });
  const target = startQueue({
    source: 'custom',
    scope: 'shown',
    items,
    first: items[0]!,
    origin: { path: '/drift', restore: { worklistId: 'list' } },
  });
  const queue = useWorkQueues.getState().queues[target.state.workThrough.id]!;
  const context = { data: current, user: null, decisions: {} };
  const done = queueSources.custom.done(context);
  expect(done(items[0]!, {})).toBe(false);
  current.bundle.tooltips[11] = {
    hash: 11,
    associated: [],
    text: { en: { text: 'Saved' } },
  } as unknown as Tooltip;
  expect(queueSources.custom.done({ ...context, data: { ...current } })(items[0]!, {})).toBe(true);
  useSavedWorklists.setState({
    lists: [{ id: 'list', name: 'Weekend', items: [entry, { hash: 12, name: 'Beta' }] }],
  });
  expect(queue.items).toHaveLength(1);
  api.mockResolvedValueOnce(
    Response.json({
      worklist: { id: 'b4d6ed22-4e98-4f25-a55f-11d529c9ae97', name: 'Weekend', hashes: [11, 12] },
      revision: 'a'.repeat(32),
    }),
  );
  const rebuilt = await queueSources.custom.rebuild(queue, context, {});
  expect(rebuilt).toHaveLength(2);
  expect(rebuilt[0]!.detail).toBe(items[0]!.detail);
  useSavedWorklists.setState({ lists: [] });
  await expect(queueSources.custom.rebuild(queue, context, {})).rejects.toThrow('deleted');
  expect(queue.items).toHaveLength(1);
});
it('groups the usable drafts by category when an alias cycle elsewhere breaks the finder sections', async () => {
  const current = data();
  current.items[13] = {
    hash: 13,
    name: 'Gamma',
    icon: '',
    categoryId: 'perks',
    inGameDescription: '',
  };
  current.aliases = { 12: { to: 13, kind: 'name' }, 13: { to: 12, kind: 'name' } };
  setEditorDraftFetch(async () => Response.json({ schemaVersion: 1, hashes: [11, 12, 13] }));
  const items = await draftItems(current);
  expect(items.map((item) => item.hash)).toEqual([11]);
  const groups = draftGroups(items, current);
  expect(groups.map((group) => [group.id, group.items.map((item) => item.hash)])).toEqual([
    ['perks', [11]],
  ]);
  // A category's Rebuild still resolves.
  const queue = { origin: { path: '/', restore: { category: 'perks' } } } as Parameters<
    typeof queueSources.drafts.rebuild
  >[0];
  const rebuilt = await queueSources.drafts.rebuild(
    queue,
    { data: current, user: null, decisions: {} },
    {},
  );
  expect(rebuilt.map((item) => item.hash)).toEqual([11]);
});

it('marks missing, archived, aliased, and cyclic entries unavailable through the real resolver', () => {
  const current = data();
  expect(worklistAvailable(11, current)).toBe(true);
  expect(worklistAvailable(999, current)).toBe(false);
  const archived = data();
  archived.bundle.tooltips[11] = {
    hash: 11,
    archive: {
      removedAt: '2026-01-01T00:00:00Z',
      lastSeen: { name: 'Alpha', categoryId: 'perks', manifestVersion: 'test' },
    },
    associated: [],
    text: {},
  } as Tooltip;
  expect(worklistAvailable(11, archived)).toBe(false);
  expect(worklistAvailable(11, { ...current, aliases: { 11: { to: 12, kind: 'name' } } })).toBe(
    false,
  );
  expect(
    worklistAvailable(11, {
      ...current,
      aliases: { 11: { to: 12, kind: 'name' }, 12: { to: 11, kind: 'name' } },
    }),
  ).toBe(false);
});

it('keeps cyclic orphan rows and live rows usable without false completion when stamps cannot resolve (F4)', () => {
  const current = data();
  delete current.items[11];
  current.aliases = { 11: { to: 13, kind: 'name' }, 13: { to: 11, kind: 'name' } };
  current.bundle.tooltips[11] = {
    hash: 11,
    text: { en: { text: 'Saved orphan', updatedAt: '2026-11-15T00:00:00Z', updatedBy: 'fixture' } },
    associated: [],
  } as Tooltip;
  current.bundle.tooltips[12] = {
    hash: 12,
    text: { en: { text: 'Live text', updatedAt: '2026-11-15T00:00:00Z', updatedBy: 'fixture' } },
    associated: [],
  } as Tooltip;
  const items = savedItems(
    [
      { hash: 11, name: 'Unavailable' },
      { hash: 12, name: 'Live' },
    ],
    current,
  );
  expect(items.map((item) => item.hash)).toEqual([11, 12]);
  expect(worklistAvailable(11, current)).toBe(false);
  expect(worklistAvailable(12, current)).toBe(true);
  const done = queueSources.custom.done({ data: current, user: null, decisions: {} });
  expect(done(items[0]!, {})).toBe(false);
  expect(done(items[1]!, {})).toBe(false);
  const resolved = { ...current, aliases: {} };
  expect(
    queueSources.custom.done({ data: resolved, user: null, decisions: {} })(items[1]!, {}),
  ).toBe(false);
});
