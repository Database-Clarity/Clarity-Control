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
  const { service } = createGlobalsFixture({ role: 'maintainer', languages: [] });
  const result = await service.mutate({
    expectedHead: 'fixture-head-1',
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
    result.value.impacts['g_damage0001'].every((row) => globalReviewState(row) === 'required'),
  ).toBe(true);
  const stale = await service.mutate({
    expectedHead: result.value.head,
    mutation: {
      operation: 'acknowledge',
      id: 'g_damage0001',
      consumerId: '10:en:live',
      contentDigest: fixtureDigest(10),
      dependencyDigest: fixtureDigest(110),
      impactDigest: fixtureDigest(210),
      decision: 'no-text-change',
    },
  });
  expect(stale.kind).toBe('conflict');
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
