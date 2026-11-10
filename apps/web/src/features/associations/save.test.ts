import { afterEach, expect, it, vi } from 'vitest';
import { tooltipSchema } from '@clarity/core';
import { Fixture, makePrivateKey, tooltip } from '../../../../worker/test/fixture';
import { createDraftStore, useDraftStore } from '../../stores/drafts';
import { useDataStore } from '../../stores/data';
import { editorData } from '../../services/save/fixtures.testSupport';
import { permissionError, prepareChanges } from '../../services/save/pipeline';
import { acceptSaved } from '../../services/save/drafts';
import type { Drafts } from '../../services/draftStorage';

const initialDrafts = useDraftStore.getState();
const initialData = useDataStore.getState();
afterEach(() => {
  vi.unstubAllGlobals();
  useDraftStore.setState(initialDrafts, true);
  useDataStore.setState(initialData, true);
});

it('saves an ordered association-only draft through enrichers and the Worker, then reconciles it', async () => {
  const fixture = new Fixture(await makePrivateKey());
  const base = tooltip();
  const data = editorData();
  data.bundle.tooltips[base.hash] = base;
  const user = { id: 2, login: 'bob', role: 'editor' as const };
  let persisted: Drafts = {};
  const store = createDraftStore({
    read: async () => persisted,
    write: async (drafts) => {
      persisted = structuredClone(drafts);
    },
  });
  await store.getState().hydrate();
  store.getState().updateDraft(base, (next) => ({ ...next, associated: [30, 20] }));
  await store.getState().flush();
  const submitted = store.getState().drafts;
  const changes = [{ hash: base.hash, ...submitted[base.hash] }];
  const prepared = await prepareChanges(changes, user, data);
  expect(prepared[0].next.text).toEqual(base.text);
  expect(prepared[0].next.associated).toEqual([30, 20]);
  expect(
    permissionError(changes, { id: 4, login: 'dan', role: 'translator', languages: ['de'] }),
  ).toContain('Other fields changed');

  const response = await fixture.request(
    '/save',
    'POST',
    { changes: prepared, message: 'Associate verbs' },
    2,
  );
  expect(response.status).toBe(200);
  const result = (await response.json()) as { commit: string; tooltips: unknown[] };
  const saved = result.tooltips.map((entry) => tooltipSchema.parse(entry));
  expect(saved[0].associated).toEqual([30, 20]);
  expect(fixture.current()['tooltips/123.json']).toEqual(saved[0]);
  expect(persisted[123].next.associated).toEqual([30, 20]);

  const retry = vi.fn();
  useDataStore.setState({ data });
  useDraftStore.setState({ drafts: submitted, hydrated: true, retry });
  acceptSaved(submitted, saved, result.commit);
  expect(useDraftStore.getState().drafts).toEqual({});
  expect(useDataStore.getState().data?.bundle.tooltips[123].associated).toEqual([30, 20]);
  expect(retry).toHaveBeenCalledOnce();
});

vi.mock('../../services/save/validationWorker', () => ({
  requestSaveValidation: async (
    changes: import('../../services/api').Change[],
    data: import('../../stores/data').EditorData,
  ) => {
    const { validateChanges } = await import('../../services/save/validation');
    return validateChanges(changes, data);
  },
}));
