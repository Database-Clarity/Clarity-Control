import { expect, it } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { guidedDecisions } from './guidedDecisions';
import { loadManifestFacts } from './manifestFacts';
import { classifyScope, inScopeCategory, scopeConfig } from './reviewScope';

it('classifies ghost mods and stat-only manifest entries while protecting decisions', () => {
  const f = guidedFixture();
  const entry = f.categories[0].entries[0];
  expect(scopeConfig.includeGhostMods).toBe(false);
  expect(classifyScope(entry, 'catalog:ghost-mod')).toBe('ghost-mod');
  expect(classifyScope(entry, 'catalog:ghost-mod', { includeGhostMods: true })).toBeUndefined();
  const facts = loadManifestFacts();
  entry.manifestFacts = {
    item: structuredClone(facts.items['830282363']),
    version: facts.source.manifestVersion,
  };
  expect(classifyScope(entry, 'catalog:weapon-perk')).toBeUndefined();
  entry.manifestFacts.item = structuredClone(facts.items['5699512']);
  expect(classifyScope(entry, 'catalog:weapon-perk')).toBe('manifest-weapon-stat');
  entry.scopeRestored = true;
  expect(classifyScope(entry, 'catalog:weapon-perk')).toBeUndefined();
  entry.scopeRestored = false;
  entry.next.compendium = {} as NonNullable<typeof entry.next.compendium>;
  expect(classifyScope(entry, 'catalog:weapon-perk')).toBeUndefined();
});

it('keeps references and entries while scope takes precedence over an explicit reference', () => {
  const f = guidedFixture();
  const category = f.categories[0];
  const record = f.document.categories[category.id];
  const facts = loadManifestFacts();
  category.entries[0].manifestFacts = {
    item: structuredClone(facts.items['5699512']),
    version: facts.source.manifestVersion,
  };
  const oldId = category.id;
  category.id = 'catalog:weapon-perk';
  record.id = category.id;
  delete f.document.categories[oldId];
  f.document.categories[category.id] = record;
  const [group] = guidedDecisions(
    f.document,
    f.categories,
    f.proposals,
    f.source,
    f.baseline,
    f.scope,
  );
  expect(group.entries[0]).toMatchObject({
    confidence: 'out-of-scope',
    action: 'out-of-scope',
    ruleId: 'manifest-weapon-stat',
  });
  expect(group.outOfScope).toBe(1);
  expect(group.referenceEvidence).toHaveLength(Object.keys(record.references!).length);
  expect(group.entries).toHaveLength(record.hashes.length);
  expect(group.samples).not.toContain(category.entries[0].hash);
});

it('projects only in-scope owner reasons and samples while preserving canonical categories', () => {
  const f = guidedFixture();
  const category = f.categories[0];
  category.id = 'catalog:ghost-mod';
  const original = JSON.stringify(category);
  const ghost = inScopeCategory(category);
  expect(ghost.entries).toEqual([]);
  expect(ghost.samples).toEqual([]);
  expect(Object.values(ghost.reasons).flat()).toEqual([]);
  expect(JSON.stringify(category)).toBe(original);
  category.id = 'catalog:weapon-perk';
  const excluded = category.entries[0];
  excluded.manifestFacts = {
    item: structuredClone(loadManifestFacts().items['5699512']),
    version: 'test',
  };
  const mixed = inScopeCategory(category);
  expect(mixed.entries).toHaveLength(category.entries.length - 1);
  expect(mixed.samples).not.toContain(excluded);
  expect(Object.values(mixed.reasons).flat()).not.toContain(excluded);
});
