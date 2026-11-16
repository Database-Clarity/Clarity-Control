// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  GlobalImpactComparison,
  validGlobalImpact,
} from '../src/features/globals/GlobalImpactComparison';
import coreFixture from '../../../packages/core/src/globals/contract.fixture.json';
import {
  canEditGlobal,
  canAcknowledgeGlobal,
  canReviewGlobal,
  globalReviewState,
  type GlobalActor,
} from '../src/services/globals';
import {
  createGlobalsFixture,
  globalFixtureSnapshot,
  fixtureDigest,
} from './globals-entries-fixture';
import { globalRecordSchema, globalImpactRowSchema, globalReviewSchema } from '@clarity/core';

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
  const { service, controls } = createGlobalsFixture({ role: 'maintainer', languages: [] });
  const result = await service.mutate({
    expectedHead: '0000000000000000000000000000000000000001',
    mutation: {
      operation: 'edit',
      id: 'g_damage0001',
      revision: 'r1',
      lang: 'en',
      body: '',
    },
  });
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') return;
  expect(result.value.entries[0].definitions.en?.body).toBe('');
  expect(
    result.value.impacts['g_damage0001'].every(
      (row) => !canAcknowledgeGlobal(result.value, 'g_damage0001', row),
    ),
  ).toBe(true);
  expect(result.value.sync.g_damage0001.status).toBe('sync-pending');
  expect(
    canAcknowledgeGlobal(result.value, 'g_damage0001', result.value.impacts.g_damage0001[0]),
  ).toBe(false);
  controls.syncOutcome = 'current';
  const synced = await service.read();
  expect(synced.kind).toBe('ok');
  if (synced.kind !== 'ok') return;
  const stale = await service.mutate({
    expectedHead: synced.value.head,
    mutation: {
      operation: 'acknowledge',
      id: 'g_damage0001',
      consumerId: 'review_10_en_live',
      contentDigest: fixtureDigest(10),
      dependencyDigest: fixtureDigest(110),
      impactDigest: fixtureDigest(210),
      decision: 'no-text-change',
    },
  });
  expect(stale.kind).toBe('conflict');
});

it('refuses stale, pending, failed, and unknown review state', () => {
  const snapshot = structuredClone(globalFixtureSnapshot);
  const row = snapshot.impacts.g_damage0001[0];
  expect(canAcknowledgeGlobal(snapshot, 'g_damage0001', row)).toBe(true);
  expect(canAcknowledgeGlobal(snapshot, 'g_damage0001', snapshot.impacts.g_damage0001[1])).toBe(
    false,
  );
  snapshot.sync.g_damage0001.status = 'sync-pending';
  expect(canAcknowledgeGlobal(snapshot, 'g_damage0001', row)).toBe(false);
  snapshot.sync.g_damage0001.status = 'sync-failed';
  expect(canAcknowledgeGlobal(snapshot, 'g_damage0001', row)).toBe(false);
  snapshot.sync.g_damage0001.status = 'current';
  snapshot.destinationSync.live.status = 'sync-pending';
  expect(canAcknowledgeGlobal(snapshot, 'g_damage0001', row)).toBe(false);
  delete snapshot.destinationSync.live;
  expect(canAcknowledgeGlobal(snapshot, 'g_damage0001', row)).toBe(false);
  expect(canAcknowledgeGlobal(snapshot, 'unknown-entry', row)).toBe(false);
});

it('retains consecutive pending causes through failure and retry', async () => {
  const { service, controls } = createGlobalsFixture({ role: 'editor', languages: [] });
  const first = await service.mutate({
    expectedHead: '0000000000000000000000000000000000000001',
    mutation: {
      operation: 'edit',
      id: 'g_damage0001',
      revision: 'r1',
      lang: 'en',
      body: '20%',
    },
  });
  if (first.kind !== 'ok') throw new Error('Fixture edit failed');
  const second = await service.mutate({
    expectedHead: first.value.head,
    mutation: {
      operation: 'edit',
      id: 'g_damage0001',
      revision: first.value.entries[0].revision,
      lang: 'en',
      body: '30%',
    },
  });
  if (second.kind !== 'ok') throw new Error('Fixture edit failed');
  const causes = second.value.sync.g_damage0001.causeIds;
  expect(causes).toHaveLength(2);
  expect(causes).toContain(first.value.sync.g_damage0001.causeIds[0]);
  controls.syncOutcome = 'sync-failed';
  const failed = await service.read();
  if (failed.kind !== 'ok') throw new Error('Fixture read failed');
  expect(failed.value.sync.g_damage0001.lastFailure).toContain('source changed');
  const stale = await service.retrySync({
    expectedHead: failed.value.head,
    id: 'g_damage0001',
    causeIds: causes.slice(0, 1),
  });
  expect(stale.kind).toBe('conflict');
  const retry = await service.retrySync({
    expectedHead: failed.value.head,
    id: 'g_damage0001',
    causeIds: causes,
  });
  if (retry.kind !== 'ok') throw new Error('Fixture retry failed');
  expect(retry.value.sync.g_damage0001.status).toBe('sync-pending');
  expect(retry.value.sync.g_damage0001.causeIds).toEqual(causes);
  expect(retry.value.entries[0].definitions.en?.body).toBe('30%');
});

it('does not report a queued rename intent as completed', async () => {
  const { service, controls } = createGlobalsFixture({ role: 'editor', languages: [] });
  const queued = await service.mutate({
    expectedHead: '0000000000000000000000000000000000000001',
    mutation: {
      operation: 'rename',
      id: 'g_damage0001',
      revision: 'r1',
      name: 'DamageNew',
    },
  });
  if (queued.kind !== 'ok') throw new Error('Fixture rename failed');
  expect(queued.value.sync.g_damage0001.status).toBe('sync-pending');
  expect(queued.value.entries[0].name).toBe('Damage');
  expect(queued.value.entries[0].nameHistory).toEqual([]);
  controls.syncOutcome = 'current';
  const current = await service.read();
  if (current.kind !== 'ok') throw new Error('Fixture read failed');
  expect(current.value.entries[0].name).toBe('DamageNew');
  expect(current.value.entries[0].id).toBe(queued.value.entries[0].id);
});

it('uses the strict S1 records, render trees, cause sets, and review ledger', () => {
  for (const entry of globalFixtureSnapshot.entries)
    expect(() => globalRecordSchema.parse(entry)).not.toThrow();
  for (const rows of Object.values(globalFixtureSnapshot.impacts))
    for (const row of rows) {
      const { consumer, causes, reason, before, after } = row;
      expect(() =>
        globalImpactRowSchema.parse({ consumer, causes, reason, before, after }),
      ).not.toThrow();
      expect(() => globalReviewSchema.parse(row.review)).not.toThrow();
      expect(row.review.consumer).toEqual(consumer);
      expect(row.review.causes).toEqual(causes);
    }
});

it('invalidates an acknowledgement when only its impact digest changes', () => {
  const row = structuredClone(globalFixtureSnapshot.impacts.g_damage0001[0]);
  row.review.acknowledgement = {
    by: 'fixture',
    at: '2026-01-01T00:00:00Z',
    contentDigest: row.review.contentDigest,
    dependencyDigest: row.review.dependencyDigest,
    impactDigest: row.impactDigest,
    decision: 'no-text-change',
  };
  expect(globalReviewState(row)).toBe('acknowledged');
  row.impactDigest = fixtureDigest(9999);
  expect(globalReviewState(row)).toBe('stale');
});

it('renders the real S1 contract trees without treating their JSON as markup source', () => {
  const row = {
    ...globalImpactRowSchema.parse(coreFixture.impact.rows[0]),
    beforeSource: '#damage',
    afterSource: '#damage',
  };
  const rendered = renderToStaticMarkup(createElement(GlobalImpactComparison, { row, raw: false }));
  expect(rendered).toContain('>10<');
  expect(rendered).toContain('>20<');
  expect(rendered).not.toContain('linesContent');
  const raw = renderToStaticMarkup(createElement(GlobalImpactComparison, { row, raw: true }));
  expect(raw).toContain('#damage');
  const removed = { ...row, after: null };
  expect(
    renderToStaticMarkup(createElement(GlobalImpactComparison, { row: removed, raw: false })),
  ).toContain('Consumer absent.');
  expect(validGlobalImpact({ ...row, before: { ...row.before!, rendered: 'not-json' } })).toBe(
    false,
  );
});
