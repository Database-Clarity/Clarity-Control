import { completeWeaponTypeLabels, type Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';

export const english = {
  text: 'Original English',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'author',
};
export const tooltip: Tooltip = { hash: 123, text: { en: english }, associated: [] };
export function editorData(): EditorData {
  return {
    categories: [{ id: 'perk', label: 'Perks', group: 'Weapons', order: 0 }],
    items: {
      123: { hash: 123, name: 'Perk', icon: '', categoryId: 'perk', inGameDescription: 'In-game' },
    },
    aliases: { 456: { to: 123, kind: 'sandbox' } },
    weaponTypeLabels: completeWeaponTypeLabels(),
    bundle: {
      sourceCommit: 'base-commit',
      generatedAt: english.updatedAt,
      permissions: { users: {} },
      pushed: {},
      tooltips: { 123: tooltip },
    },
  };
}
