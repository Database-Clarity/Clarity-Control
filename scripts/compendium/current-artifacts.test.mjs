import { expect, it } from 'vitest';
import { currentArtifacts } from '../compendium-guidance/current-artifacts.mjs';

const perk = (hash, name) => ({
  hash,
  displayProperties: { name },
  itemTypeDisplayName: 'Artifact Perk',
  plug: { plugCategoryIdentifier: 'artifact_perks' },
});
const socketed = (hash, name, seasonHash, plugSetHash) => ({
  hash,
  displayProperties: { name },
  itemTypeDisplayName: 'Artifact',
  itemType: 0,
  seasonHash,
  sockets: {
    socketEntries: [{ singleInitialItemHash: 9, reusablePlugSetHash: plugSetHash }],
  },
});
// Shapes of manifest 245114.26.10.13.2000-1-bnet.66137: a socketed artifact per current season,
// an itemType 28 "Seasonal Artifact" and a preview-only "Artifact" for the same and older seasons.
const inventory = {
  1014202826: socketed(1014202826, 'Encrypted Data Disk', 60, 500),
  3518286241: socketed(3518286241, 'Queensfoil Censer', 71, 501),
  3980449645: {
    hash: 3980449645,
    displayProperties: { name: 'Encrypted Data Disk' },
    itemTypeDisplayName: 'Seasonal Artifact',
    itemType: 28,
    preview: { derivedItemCategories: [{ items: [{ itemHash: 1 }] }] },
  },
  538867171: {
    hash: 538867171,
    displayProperties: { name: "Acolyte's Staff" },
    itemTypeDisplayName: 'Artifact',
    itemType: 28,
    preview: { derivedItemCategories: [{ items: [{ itemHash: 3 }] }] },
  },
  1: perk(1, 'Armorsmith'),
  2: perk(2, 'Dielectric'),
  3: perk(3, 'Old Perk'),
  9: {
    hash: 9,
    displayProperties: { name: 'Empty' },
    plug: { plugCategoryIdentifier: 'artifact_perks' },
  },
  10: {
    hash: 10,
    displayProperties: { name: 'Reset' },
    plug: { plugCategoryIdentifier: 'artifact_reset' },
  },
};
const plugSets = {
  500: { reusablePlugItems: [{ plugItemHash: 1 }, { plugItemHash: 2 }, { plugItemHash: 10 }] },
  501: { reusablePlugItems: [{ plugItemHash: 1 }] },
};
const seasons = { 60: { seasonNumber: 28 }, 71: { seasonNumber: 23 } };

it('finds the socketed artifacts only, newest season first, with their artifact perks', () => {
  expect(currentArtifacts(inventory, plugSets, seasons)).toEqual([
    {
      hash: 1014202826,
      name: 'Encrypted Data Disk',
      seasonHash: 60,
      seasonNumber: 28,
      perks: [
        { hash: 1, name: 'Armorsmith' },
        { hash: 2, name: 'Dielectric' },
      ],
    },
    {
      hash: 3518286241,
      name: 'Queensfoil Censer',
      seasonHash: 71,
      seasonNumber: 23,
      perks: [{ hash: 1, name: 'Armorsmith' }],
    },
  ]);
});
