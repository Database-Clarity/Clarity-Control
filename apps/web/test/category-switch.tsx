// The real shell (shell.tsx) plus two weapon parts the editor classifies from the bundled manifest
// facts: Tempered Truss Rod (Stat-only Parts), Swap Mag (Parts with Effects, with text), and
// Hitmark IS (a stat-only part with text: needs a tooltip, No tooltip disabled with its hint).
import type { Tooltip } from '@clarity/core';
import { useDataStore } from '../src/stores/data';
import './shell.tsx';

const stamp = '2026-10-27T00:00:00Z';
const own = (hash: number, text: string): Tooltip => ({
  hash,
  text: { en: { text, updatedAt: stamp, updatedBy: 'fixture' } },
  associated: [],
});
const parts = {
  5699512: {
    hash: 5699512,
    name: 'Tempered Truss Rod',
    icon: '',
    categoryId: 'weapon-perk',
    inGameDescription:
      'High stiffness for quick handling.\n  •  Greatly increases handling speed\n  •  Slightly decreases reload speed\n  •  Slightly decreases range',
  },
  13792278: {
    hash: 13792278,
    name: 'Hitmark IS',
    icon: '',
    categoryId: 'weapon-perk',
    inGameDescription:
      'Agile sight. Short zoom. \n  •  Greatly increases handling speed\n  •  Slightly increases range',
  },
  3721627275: {
    hash: 3721627275,
    name: 'Swap Mag',
    icon: '',
    categoryId: 'weapon-perk',
    inGameDescription: "Increases this weapon's ready and stow speed.",
  },
};
const current = useDataStore.getState().data!;
useDataStore.setState({
  data: {
    ...current,
    categories: [
      ...current.categories,
      { id: 'weapon-perk', label: 'Weapon Parts', group: 'Weapons', order: 150 },
    ],
    items: { ...current.items, ...parts },
    bundle: {
      ...current.bundle,
      tooltips: {
        ...current.bundle.tooltips,
        3721627275: own(3721627275, 'Increases ready and stow speed.'),
        13792278: own(13792278, 'Greatly increases handling speed.'),
      },
    },
  },
});
