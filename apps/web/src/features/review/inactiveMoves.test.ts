import { expect, it } from 'vitest';
import {
  inactivePublishableHash,
  inactiveRemovalHash,
  publishableHash,
  type InactiveMoves,
  type Tooltip,
} from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { pendingTooltips, publishableHashes, selectedPending } from './model';

const stamp = { by: 1, at: '2026-11-14T00:00:00Z' };
const tooltip: Tooltip = {
  hash: 123,
  associated: [],
  text: {
    en: { text: 'Original text', updatedAt: stamp.at, updatedBy: 'alice' },
  },
};
function data(
  moves: InactiveMoves,
  pushed: Record<string, string>,
  withTooltip = true,
): EditorData {
  return {
    items: {
      123: { hash: 123, name: 'Perk', categoryId: 'weapon-perk', icon: '', inGameDescription: '' },
    },
    categories: [],
    aliases: { 789: { to: 123, kind: 'frame' } },
    bundle: {
      sourceCommit: 'fixture',
      generatedAt: stamp.at,
      tooltips: withTooltip ? { 123: tooltip } : {},
      permissions: { users: {} },
      pushed,
      inactiveMoves: moves,
    },
  };
}

it('lists an inactive item as a pending removal, and hides it only after its removal marker lands', async () => {
  const current = data({ 123: stamp }, {});
  current.bundle.pushed[123] = await publishableHash(tooltip, current.aliases);
  const [entry] = await pendingTooltips(current);
  expect(entry).toMatchObject({ inactiveChange: 'remove', markerOnly: false });
  expect(entry.tooltip).toBe(tooltip);
  expect(publishableHashes([entry])).toEqual([123]);
  const published = data({ 123: stamp }, { 123: await inactiveRemovalHash(123) });
  expect(await pendingTooltips(published)).toEqual([]);
});

it('shows a pending re-add after move-out, then returns to ordinary edits after publishing', async () => {
  const restored = data(
    { 123: { ...stamp, inactive: false } },
    { 123: await inactiveRemovalHash(123) },
  );
  expect((await pendingTooltips(restored))[0]).toMatchObject({
    inactiveChange: 'restore',
    markerOnly: false,
  });
  restored.bundle.pushed = {
    123: await inactivePublishableHash(tooltip, restored.aliases, restored.bundle.inactiveMoves),
  };
  expect(await pendingTooltips(restored)).toEqual([]);
});

it('makes textless or unstored removals selectable without creating a tooltip document', async () => {
  const current = data({ 123: stamp }, {}, false);
  const entries = await pendingTooltips(current);
  expect(entries[0]).toMatchObject({ inactiveChange: 'remove', tooltip: { hash: 123, text: {} } });
  expect(selectedPending(new Set([123]), entries)).toEqual([123]);
  expect(publishableHashes(entries)).toEqual([123]);
  expect(current.bundle.tooltips).toEqual({});
});

it('hides a textless re-add until there is real saved content to export', async () => {
  const restored = data(
    { 123: { ...stamp, inactive: false } },
    { 123: await inactiveRemovalHash(123) },
    false,
  );
  expect(await pendingTooltips(restored)).toEqual([]);
  const edited = data(restored.bundle.inactiveMoves!, restored.bundle.pushed, true);
  const entries = await pendingTooltips(edited);
  expect(entries[0].inactiveChange).toBe('restore');
  expect(selectedPending(new Set([123]), entries)).toEqual([123]);
});

it('reviews an alias-only removal and re-add on its canonical row instead of hiding it as marker-only', async () => {
  const moved = data({ 789: stamp }, {});
  moved.bundle.pushed[123] = await publishableHash(tooltip, moved.aliases);
  expect((await pendingTooltips(moved))[0]).toMatchObject({
    inactiveAliases: [789],
    markerOnly: false,
  });
  const digest = await inactivePublishableHash(tooltip, moved.aliases, moved.bundle.inactiveMoves);
  const restored = data({ 789: { ...stamp, inactive: false } }, { 123: digest });
  expect((await pendingTooltips(restored))[0]).toMatchObject({
    inactiveAliases: [789],
    markerOnly: false,
  });
  expect(restored.bundle.tooltips[123]).toBe(tooltip);
});
