import { describe, expect, it } from 'vitest';
import { publishableHash, setBonusHoldMessage, type Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { queueView } from './queueModel';
import {
  canPush,
  pendingTooltips,
  publishableHashes,
  publishSelection,
  selectedPending,
  stepIndex,
  toggleSelection,
  type PendingTooltip,
} from './model';

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
  it('labels the aggregate rows and their Review group Globals', async () => {
    const hashes = [1, 2, 3];
    const state = data([0, ...hashes].map((hash) => ({ ...tooltip, hash })));
    for (const hash of [0, ...hashes])
      state.items[hash] = { ...state.items[123], hash, categoryId: 'none' };
    const entries = await pendingTooltips(state);
    expect(entries.map((entry) => entry.category)).toEqual([
      'Globals',
      'Globals',
      'Globals',
      'Other: none',
    ]);
    expect(
      queueView(entries, '', '', new Set(), 'hidden').items.filter(({ kind }) => kind === 'group'),
    ).toMatchObject([
      { label: 'Globals', publishable: hashes },
      { label: 'Other: none', publishable: [0] },
    ]);
  });
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
  it('lists a canonical again when a new alias must reach live', async () => {
    const state = data([tooltip], { 123: await publishableHash(tooltip) });
    expect(await pendingTooltips(state)).toEqual([]);
    state.aliases = { 456: { to: 123, kind: 'frame' } };
    expect((await pendingTooltips(state)).map((entry) => entry.tooltip.hash)).toEqual([123]);
    const pushed = { 123: await publishableHash(tooltip, state.aliases) };
    expect(await pendingTooltips(state, pushed)).toEqual([]);
    state.aliases = { 457: { to: 123, kind: 'frame' } };
    expect(await pendingTooltips(state, pushed)).toHaveLength(1);
  });
  it('keeps canonical enhanced tooltips even when navigation pairs them with a base', async () => {
    const state = data([tooltip, { ...tooltip, hash: 456 }]);
    state.items[456] = { ...state.items[123], hash: 456, name: 'Enhanced', baseHash: 123 };
    expect(await pendingTooltips(state)).toHaveLength(2);
  });
});

describe('unpublishable rows', () => {
  it('flags tooltips with no generator entry unless custom, and never selects them', async () => {
    const orphan = { ...tooltip, hash: 777 };
    const custom = {
      ...tooltip,
      hash: 888,
      custom: { name: 'Mine', categoryId: 'perk' },
    } as Tooltip;
    const entries = await pendingTooltips(data([tooltip, orphan, custom]));
    const flagged = Object.fromEntries(
      entries.map((entry) => [entry.tooltip.hash, Boolean(entry.unpublishable)]),
    );
    expect(flagged).toEqual({ 123: false, 777: true, 888: false });
    const all = new Set([123, 777, 888]);
    expect(selectedPending(all, entries).sort()).toEqual([123, 888]);
    expect(publishableHashes(entries).sort()).toEqual([123, 888]);
  });
  it('holds set bonuses until cut-over: listed, with the reason, never selected', async () => {
    const generator = { ...tooltip, hash: 900 };
    const custom = {
      ...tooltip,
      hash: 901,
      custom: { name: 'Example Set (2 pc): Bonus', categoryId: 'armor-set-bonus' },
    } as Tooltip;
    const state = data([tooltip, generator, custom]);
    state.items[900] = {
      hash: 900,
      name: 'Example Set (4 pc): Bonus',
      categoryId: 'armor-set-bonus',
      icon: '',
      inGameDescription: '',
    };
    const entries = await pendingTooltips(state);
    const reasons = Object.fromEntries(
      entries.map((entry) => [entry.tooltip.hash, entry.unpublishable]),
    );
    expect(reasons).toEqual({
      123: undefined,
      900: `${setBonusHoldMessage}.`,
      901: `${setBonusHoldMessage}.`,
    });
    const all = new Set([123, 900, 901]);
    expect(selectedPending(all, entries)).toEqual([123]);
    expect(publishableHashes(entries)).toEqual([123]);
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
  it('publishes exactly the included rows: still pending, publishable, not running, list order', () => {
    const row = (hash: number, extra: Partial<PendingTooltip> = {}): PendingTooltip => ({
      tooltip: { ...tooltip, hash },
      name: `Row ${hash}`,
      category: 'Perks',
      categoryId: 'perk',
      categoryOrder: 1,
      markerOnly: false,
      isNew: false,
      ...extra,
    });
    const pending = [
      row(1),
      row(2),
      row(3, { unpublishable: 'Set bonuses wait.' }),
      row(4, { markerOnly: true }),
      row(5),
      row(6, { tooltip: { hash: 6, text: {}, associated: [] } }),
    ];
    // Ticked: 5, 1, 3 (held), 4 (a leftover ticked by hand), 6 (no text), 9 (no longer pending),
    // and 2 inside a running publish. Nothing is included that was not ticked.
    const sent = publishSelection(new Set([5, 1, 3, 4, 6, 9, 2]), pending, new Set([2]));
    expect(sent.map(({ tooltip }) => tooltip.hash)).toEqual([1, 4, 5]);
    expect(publishSelection(new Set(), pending, new Set())).toEqual([]);
    // The entries are the pending rows themselves (the confirm dialog's list and the payload).
    expect(sent[0]).toBe(pending[0]);
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

it('keeps text-less records out of Review and selection, then includes them after text is added', async () => {
  const empty = { ...tooltip, text: {} };
  expect(await pendingTooltips(data([empty]))).toEqual([]);
  const written = await pendingTooltips(data([tooltip]));
  expect(publishableHashes(written)).toEqual([123]);
  expect(selectedPending(new Set([123]), written)).toEqual([123]);
  const injected = written.map((entry) => ({ ...entry, tooltip: empty }));
  expect(publishableHashes(injected)).toEqual([]);
  expect(selectedPending(new Set([123]), injected)).toEqual([]);
});

it('keeps an intentionally emptied reserved global library in Review and selection', async () => {
  const global = {
    ...tooltip,
    hash: 2,
    text: {},
    custom: { name: 'Variables', categoryId: 'global' },
  };
  const entries = await pendingTooltips(data([global]));
  expect(entries).toHaveLength(1);
  expect(publishableHashes(entries)).toEqual([2]);
  expect(selectedPending(new Set([2]), entries)).toEqual([2]);
});
