import { afterEach, expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { setEditorDraftFetch } from '../../services/editorDrafts';
import { draftItems, savedItems, worklistAvailable } from './savedSources';
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
  const entry = { hash: 11, name: 'Alpha' };
  const items = savedItems([entry], current);
  useSavedWorklists.setState({
    lists: [{ id: 'list', name: 'Weekend', items: [entry] }],
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
  const rebuilt = await queueSources.custom.rebuild(queue, context, {});
  expect(rebuilt).toHaveLength(2);
  expect(rebuilt[0]!.detail).toBe(items[0]!.detail);
  useSavedWorklists.setState({ lists: [] });
  await expect(queueSources.custom.rebuild(queue, context, {})).rejects.toThrow('deleted');
  expect(queue.items).toHaveLength(1);
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
