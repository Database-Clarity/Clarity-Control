import { expect, it } from 'vitest';
import { inactiveRemovalHash, publishableHash, type Aliases, type Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { publishMoves } from './cleared';
import { localKind } from './kinds';
import { pendingTooltips, publishableHashes, selectedPending } from './model';
import { publishDependencies } from './publishDependencies';

const at = '2026-11-25T00:00:00Z';
const entry = (text: string) => ({ text, updatedAt: at, updatedBy: 'alice' });
const full: Tooltip = {
  hash: 123,
  associated: [],
  text: { en: entry('Text'), de: { ...entry('Deutsch'), sourceUpdatedAt: at } },
};
const cleared: Tooltip = { ...full, text: { ...full.text, en: entry('') } };
const textless: Tooltip = { ...full, text: { en: entry('') } };
const aliases: Aliases = { 789: { to: 123, kind: 'frame' } };
const published = await publishableHash(full, aliases);
const removal = await inactiveRemovalHash(123);

function data({
  saved,
  built = saved,
  marker = published,
  englishChanged,
}: {
  saved: Tooltip;
  built?: Tooltip;
  marker?: string | null;
  englishChanged?: number[];
}): EditorData {
  const bundle = {
    sourceCommit: 'fixture',
    generatedAt: at,
    permissions: { users: {} },
    pushed: (marker === null ? {} : { 123: marker }) as Record<string, string>,
    ...(englishChanged ? { englishChanged } : {}),
  };
  return {
    items: {
      123: { hash: 123, name: 'Perk', categoryId: 'weapon-perk', icon: '', inGameDescription: '' },
    },
    categories: [],
    aliases,
    bundle: { ...bundle, tooltips: { 123: saved } },
    ...(built === saved
      ? {}
      : { tooltipSnapshot: { sourceCommit: 'fixture', tooltips: { 123: built } } }),
  };
}

it.each([
  ['from the bundle', data({ saved: cleared, englishChanged: [123] })],
  ['without any text', data({ saved: textless, englishChanged: [123] })],
  ['in this tab, before the next bundle', data({ saved: cleared, built: full })],
])('lists a clear as Removed (%s)', async (_name, current) => {
  const entries = await pendingTooltips(current);
  expect(entries).toEqual([
    expect.objectContaining({ inactiveChange: 'remove', cleared: true, markerOnly: false }),
  ]);
  expect(localKind(entries[0]!)).toEqual({ kind: 'Removed' });
  expect(publishableHashes(entries)).toEqual([123]);
  expect(selectedPending(new Set([123]), entries)).toEqual([123]);
  expect(publishMoves(current, entries)).toEqual({
    123: expect.objectContaining({ cleared: true }),
  });
});

const empty = await publishableHash(textless, aliases);
it.each([
  ['published empty', data({ saved: textless, marker: empty })],
  [
    'published empty, then associated',
    data({ saved: { ...textless, associated: [5] }, marker: empty }),
  ],
  [
    'published empty, associated in this tab',
    data({ saved: { ...textless, associated: [5] }, built: textless, marker: empty }),
  ],
  [
    'published empty, first text not published, cleared again in this tab',
    data({ saved: textless, built: full, marker: empty, englishChanged: [123] }),
  ],
  ['never published', data({ saved: textless, marker: null })],
  ['removed', data({ saved: textless, marker: removal })],
  ['removed, with translations', data({ saved: cleared, marker: removal })],
  [
    'removed, typed back, and cleared in this tab',
    data({ saved: cleared, built: full, marker: removal }),
  ],
])('lists nothing: %s', async (_name, current) => {
  expect(await pendingTooltips(current)).toEqual([]);
});

it('a clear typed back is an ordinary change, and after its removal brings the tooltip back', async () => {
  const edited = { ...full, text: { ...full.text, en: entry('New') } };
  expect(
    await pendingTooltips(data({ saved: full, built: cleared, englishChanged: [123] })),
  ).toEqual([]);
  const [change] = await pendingTooltips(data({ saved: edited }));
  expect(change).not.toHaveProperty('inactiveChange');
  const [restored] = await pendingTooltips(data({ saved: edited, marker: removal }));
  expect(restored).toMatchObject({ inactiveChange: 'restore' });
  expect(restored).not.toHaveProperty('cleared');
  expect(localKind(restored!)).toEqual({ kind: 'Restored' });
});

it('after a removal published in this session, later translations list nothing', async () => {
  const current = data({ saved: cleared, englishChanged: [123] });
  expect(await pendingTooltips(current, { 123: removal })).toEqual([]);
});

it('an Inactive move of a cleared tooltip keeps its own wording', async () => {
  const current = data({ saved: cleared, englishChanged: [123] });
  current.bundle.inactiveMoves = { 123: { by: 1, at } };
  const [entry] = await pendingTooltips(current);
  expect(entry).toMatchObject({ inactiveChange: 'remove' });
  expect(entry).not.toHaveProperty('cleared');
});

it('keeps a cleared removal with the live readers that stop reading it', async () => {
  const reader: Tooltip = {
    hash: 124,
    associated: [],
    text: { en: entry('import main from 123') },
  };
  const repaired = { ...reader, text: { en: entry('Own text') } };
  const current = data({ saved: cleared, englishChanged: [123] });
  const entries = await pendingTooltips(current);
  expect(
    publishDependencies(
      { 123: cleared, 124: repaired },
      aliases,
      new Set([123, 124]),
      [cleared, repaired],
      { moves: publishMoves(current, entries), published: { 123: full, 124: reader } },
    ).get(123),
  ).toEqual([124]);
});
