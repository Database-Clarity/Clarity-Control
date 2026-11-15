// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { userDraftKey } from '../services/draftStorage';
import {
  announced,
  memoryStorage,
  runCurrentFlow,
  spyOnStorage,
  touched,
} from './drafts.storageFlow.testSupport';

// Flag ON (spec R6): the batch store follows the Current account through the real module link in
// stores/drafts.ts, and a Current flow with no batch edits still leaves Current storage, keys, and
// channel messages exactly as with the flag OFF. Batch buckets are only read.
vi.stubGlobal('localStorage', memoryStorage());
vi.stubGlobal('sessionStorage', memoryStorage());
let undo = () => {};
beforeAll(() => void (undo = spyOnStorage()));
afterAll(() => {
  undo();
  vi.unstubAllEnvs();
});

it('flag ON: the batch store follows the account and Current storage stays byte-identical', async () => {
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  vi.resetModules();
  const { useDraftStore } = await import('./drafts');
  const { useConflictStore } = await import('./conflicts');
  const { useDataStore } = await import('./data');
  const { acceptSaved } = await import('../services/save/drafts');
  const { useBatchDraftStore, batchBucketKey } = await import('../services/scheduled/batchDrafts');
  const user = 'flag-on-user';
  const other = 'flag-on-other';
  const modules = { useDraftStore, useConflictStore, useDataStore, acceptSaved };
  const { before, after } = await runCurrentFlow(modules, user, other);
  await useBatchDraftStore.getState().hydrate();
  expect(after).toEqual(before);
  expect(useBatchDraftStore.getState()).toMatchObject({ owner: null, hydrated: true });
  expect([...touched].sort()).toEqual(
    [
      'tooltips',
      userDraftKey(other),
      userDraftKey(user),
      batchBucketKey(other),
      batchBucketKey(user),
    ].sort(),
  );
  for (const message of announced)
    expect((message as { key: string }).key).toBe(userDraftKey(user));

  // Signing in again re-links: the batch store hydrates that account's (empty) bucket.
  await useDraftStore.getState().activate(user);
  await useBatchDraftStore.getState().hydrate();
  expect(useBatchDraftStore.getState()).toMatchObject({ owner: user, hydrated: true, drafts: {} });
});
