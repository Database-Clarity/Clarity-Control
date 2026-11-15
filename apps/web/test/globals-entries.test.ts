import { expect, it } from 'vitest';
import { canEditGlobal, canReviewGlobal, type GlobalActor } from '../src/services/globals';
import { createGlobalsFixture } from './globals-entries-fixture';

it('restricts editing and acknowledgements by role and assigned language', () => {
  const actors: GlobalActor[] = [
    null,
    { role: 'trial', languages: [] },
    { role: 'translator', languages: ['fr'] },
    { role: 'editor', languages: [] },
    { role: 'maintainer', languages: [] },
  ];
  expect(actors.map((actor) => canEditGlobal(actor, 'en'))).toEqual([
    false,
    true,
    false,
    true,
    true,
  ]);
  expect(actors.map((actor) => canEditGlobal(actor, 'fr'))).toEqual([
    false,
    true,
    true,
    true,
    true,
  ]);
  expect(actors.map((actor) => canReviewGlobal(actor, 'en'))).toEqual([
    false,
    false,
    false,
    true,
    true,
  ]);
  expect(actors.map((actor) => canReviewGlobal(actor, 'fr'))).toEqual([
    false,
    false,
    true,
    true,
    true,
  ]);
});

it('keeps an explicit empty variable and invalidates prior impact reviews on save', async () => {
  const { service } = createGlobalsFixture({ role: 'maintainer', languages: [] });
  const result = await service.mutate({
    expectedHead: 'fixture-head-1',
    mutation: {
      operation: 'edit',
      id: 'global-damage',
      revision: 'r1',
      lang: 'en',
      body: '',
    },
  });
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') return;
  expect(result.value.entries[0].definitions.en?.body).toBe('');
  expect(result.value.impacts['global-damage'].every((row) => row.review === 'required')).toBe(
    true,
  );
  const stale = await service.mutate({
    expectedHead: result.value.head,
    mutation: {
      operation: 'acknowledge',
      id: 'global-damage',
      consumerId: '10:en:live',
      contentRevision: 'tooltip1',
      dependencyDigest: 'digest1',
      decision: 'no-text-change-needed',
    },
  });
  expect(stale.kind).toBe('conflict');
});
