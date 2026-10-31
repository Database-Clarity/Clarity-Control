import { describe, expect, it } from 'vitest';
import { publishableHash, type Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { canPush, pendingTooltips, selectedPending, stepIndex, toggleSelection } from './model';

const tooltip: Tooltip = {
  hash: 123,
  text: { en: { text: 'Original', updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'alice' } },
  associated: [],
};
function data(tooltips: Tooltip[], pushed: Record<string, string> = {}): EditorData {
  return {
    items: {
      123: { hash: 123, name: 'Demo', categoryId: 'perk', icon: '', inGameDescription: '' },
    },
    categories: [{ id: 'perk', label: 'Perks', group: 'Weapons', order: 1 }],
    aliases: {},
    bundle: {
      sourceCommit: 'abc',
      generatedAt: '2026-01-01T00:00:00Z',
      tooltips: Object.fromEntries(tooltips.map((entry) => [entry.hash, entry])),
      pushed,
      permissions: { users: {} },
    },
  };
}

describe('review pending content', () => {
  it('lists never-pushed and content changes, not metadata-only changes', async () => {
    const pushed = { 123: await publishableHash(tooltip) };
    expect(await pendingTooltips(data([tooltip], pushed))).toEqual([]);
    const metadata = structuredClone(tooltip);
    metadata.text.en!.updatedBy = 'bob';
    metadata.bungieSnapshot = { description: 'changed', snapshotAt: '2026-10-27T00:00:00Z' };
    expect(await pendingTooltips(data([metadata], pushed))).toEqual([]);
    expect((await pendingTooltips(data([tooltip]))).map((entry) => entry.tooltip.hash)).toEqual([
      123,
    ]);
    metadata.text.en!.text = 'Changed';
    expect(await pendingTooltips(data([metadata], pushed))).toHaveLength(1);
  });
  it('includes association/custom changes and excludes aliases', async () => {
    const changed = { ...tooltip, associated: [456] };
    const state = data([changed, { ...tooltip, hash: 456 }], {
      123: await publishableHash(tooltip),
    });
    state.aliases = { 456: { to: 123, kind: 'frame' } };
    const entries = await pendingTooltips(state);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'Demo', category: 'Perks', tooltip: { hash: 123 } });
  });
  it('keeps canonical enhanced tooltips even when navigation pairs them with a base', async () => {
    const state = data([tooltip, { ...tooltip, hash: 456 }]);
    state.items[456] = { ...state.items[123], hash: 456, name: 'Enhanced', baseHash: 123 };
    expect(await pendingTooltips(state)).toHaveLength(2);
  });
});

describe('review selection and navigation', () => {
  it('toggles without mutation and only submits still-pending hashes', async () => {
    const original = new Set([123, 999]);
    expect(toggleSelection(original, 123)).toEqual(new Set([999]));
    expect(original).toEqual(new Set([123, 999]));
    expect(toggleSelection(original, 456)).toEqual(new Set([123, 456, 999]));
    expect(selectedPending(original, await pendingTooltips(data([tooltip])))).toEqual([123]);
  });
  it('bounds previous/next including empty lists', () => {
    expect(stepIndex(0, -1, 2)).toBe(0);
    expect(stepIndex(1, 1, 2)).toBe(1);
    expect(stepIndex(0, 1, 2)).toBe(1);
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
  it.each(['trial', 'translator', null] as const)('does not let %s publish', (role) => {
    expect(canPush({ id: 1, login: 'user', role })).toBe(false);
  });
  it('allows only editor and maintainer', () => {
    expect(canPush(null)).toBe(false);
    expect(canPush({ id: 1, login: 'user', role: 'editor' })).toBe(true);
    expect(canPush({ id: 1, login: 'user', role: 'maintainer' })).toBe(true);
  });
});
