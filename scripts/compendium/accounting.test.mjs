import { expect, it } from 'vitest';
import { countActions } from '../compendium-guidance/accounting.mjs';

it('counts no-equivalent decisions separately from links', () => {
  expect(
    countActions([
      {
        entries: [
          { confidence: 'high', action: 'link' },
          { confidence: 'high', action: 'no-equivalent' },
          { confidence: 'medium', action: 'link' },
          { confidence: 'unresolved', action: 'owner' },
        ],
      },
    ]),
  ).toEqual({
    linked: 2,
    highLinks: 1,
    highNoEquivalent: 1,
    excludedSunset: 0,
    artifactAbsent: 0,
    excludedParentLinks: 0,
  });
});

import { extract } from '../compendium-guidance/manifest-facts.mjs';
it('artifact parent extraction ignores reused preview identity', () => {
  const result = extract(
    { 7: {} },
    {
      1: { hash: 1, itemType: 28, displayProperties: { name: 'Current' } },
      2: {
        hash: 2,
        displayProperties: { iconHash: 1 },
        sockets: {
          socketEntries: [{ singleInitialItemHash: 7 }],
        },
      },
    },
    {},
    {},
  );
  expect(result[7].artifactMemberships).toEqual([
    { source: 'socket', artifactHash: 1, artifactName: 'Current', ownerHash: 2 },
  ]);
});

it('counts owner-excluded parent links separately from high links and exclusions without links', () => {
  expect(
    countActions([
      {
        entries: [
          { action: 'link', confidence: 'out-of-scope', ruleId: 'manifest-weapon-stat' },
          { action: 'out-of-scope', confidence: 'out-of-scope', ruleId: 'artifact-source-absent' },
        ],
      },
    ]),
  ).toMatchObject({ linked: 1, highLinks: 0, excludedParentLinks: 1, artifactAbsent: 1 });
});
