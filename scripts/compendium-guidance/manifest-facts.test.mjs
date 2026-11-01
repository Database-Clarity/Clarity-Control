import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract } from './manifest-facts.mjs';

test('extracts all socket sources and artifact preview without inferring status', () => {
  const result = extract({ 12: {}, 99: {} }, {
    12: { hash: 12, displayProperties: { name: 'Plug', description: 'Text' }, investmentStats: [{ statTypeHash: 2, value: 3, isConditionallyActive: false }] },
    20: { hash: 20, itemType: 3, sockets: { socketEntries: [{ singleInitialItemHash: 12, reusablePlugItems: [{ plugItemHash: 12 }], randomizedPlugSetHash: 30, reusablePlugSetHash: 30 }], socketCategories: [{ socketCategoryHash: 4241085061, socketIndexes: [0] }] } },
    21: { hash: 21, preview: { artifactHash: 40, derivedItemCategories: [{ items: [{ itemHash: 12, vendorItemIndex: 4 }] }] } },
  }, { 30: { reusablePlugItems: [{ plugItemHash: 12 }] } }, { 40: { hash: 40, tiers: [{ items: [{ itemHash: 12 }] }] } });
  assert.equal(result[12].plugUsages.length, 1);
  assert.equal(result[12].plugUsages[0].count, 4);
  assert.equal(result[12].plugUsages[0].exemplar.source, 'singleInitialItemHash');
  assert.equal(result[12].plugUsages[0].ordinal, 0);
  assert.deepEqual(result[12].artifactMemberships.map(x => x.source), ['inventoryPreview', 'artifact']);
  assert.equal(result[12].currentArtifact, null);
  assert.equal(result[12].inventory.description, 'Text');
  assert.equal(result[99].inventory, null);
});
