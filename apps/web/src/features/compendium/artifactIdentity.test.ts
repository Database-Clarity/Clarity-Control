import { expect, it } from 'vitest';
import { loadManifestFacts } from './manifestFacts';
import { artifactParents } from './artifactIdentity';
import { guidedFixture } from '../../../test/guided-fixture';
import { classifyScope, inScopeCategory } from './reviewScope';

it('uses artifact loadout socket owners, not the reused preview artifact family', () => {
  const f = guidedFixture(),
    entry = f.categories[0].entries[2];
  const facts = loadManifestFacts();
  entry.manifestFacts = { item: facts.items['2903198437'], version: facts.source.manifestVersion };
  // 3369784250 is its sandbox-perk alias, not a second inventory plug/parent.
  expect(facts.items['3369784250']).toBeUndefined();
  expect(artifactParents(entry).sort()).toEqual(['Encrypted Data Disk', 'Queensfoil Censer']);
  entry.artifactSunset = true;
  const category = { ...f.categories[0], id: 'catalog:armor-mod-seasonal', entries: [entry] };
  expect(classifyScope(entry, category.id)).toBe('artifact-sunset');
  expect(inScopeCategory(category).entries).toHaveLength(0);
});
