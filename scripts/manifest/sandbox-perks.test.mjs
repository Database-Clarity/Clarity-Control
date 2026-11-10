import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract } from './sandbox-perks.mjs';

test('keeps only referenced perks that have a description', () => {
  const generator = { 1: { sandboxPerkHashes: [5, 6] }, 2: { sandboxPerkHashes: [6, 7] }, 3: {} };
  const definitions = {
    5: { displayProperties: { name: 'A', description: ' Text. ' } },
    6: { displayProperties: { name: '', description: '' } },
    8: { displayProperties: { name: 'Unreferenced', description: 'x' } },
  };
  assert.deepEqual(extract(generator, definitions), {
    referenced: 3,
    perks: { 5: ['A', 'Text.'] },
  });
});
