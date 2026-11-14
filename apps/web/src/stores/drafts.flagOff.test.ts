// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { userDraftKey } from '../services/draftStorage';
import { acceptSaved } from '../services/save/drafts';
import { scheduledEnabled } from '../services/scheduled/flag';
import { useConflictStore } from './conflicts';
import { useDataStore } from './data';
import { useDraftStore } from './drafts';
import {
  announced,
  memoryStorage,
  runCurrentFlow,
  spyOnStorage,
  touched,
} from './drafts.storageFlow.testSupport';

// Spec R6 / I6: with the scheduled-changes switch OFF (the production default), nothing reads or
// writes the batch namespace and no storage key changes. The batch module must never even load.
const loaded = vi.hoisted(() => ({ batchModule: false }));
vi.mock('../services/scheduled/batchDrafts', () => {
  loaded.batchModule = true;
  return {};
});
vi.stubGlobal('localStorage', memoryStorage());
vi.stubGlobal('sessionStorage', memoryStorage());
let undo = () => {};
beforeAll(() => void (undo = spyOnStorage()));
afterAll(() => undo());

it('flag OFF: a full Current edit, conflict, and save flow leaves every storage key unchanged', async () => {
  expect(scheduledEnabled()).toBe(false);
  const user = 'flag-off-user';
  const other = 'flag-off-other';
  const modules = { useDraftStore, useConflictStore, useDataStore, acceptSaved };
  const { before, after } = await runCurrentFlow(modules, user, other);
  expect(after).toEqual(before);
  // Only Current buckets were read or written, and only Current keys were announced.
  expect([...touched].sort()).toEqual(['tooltips', userDraftKey(other), userDraftKey(user)].sort());
  expect(announced.length).toBeGreaterThan(0);
  for (const message of announced)
    expect((message as { key: string }).key).toBe(userDraftKey(user));
  expect(JSON.stringify(after).includes('batch')).toBe(false);
  expect(loaded.batchModule).toBe(false);
});
