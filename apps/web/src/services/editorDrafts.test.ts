import { afterEach, expect, it, vi } from 'vitest';
import type { CompendiumData } from '@clarity/core';
import {
  editorDraft,
  editorDraftIndex,
  knownDraftIndex,
  rangeText,
  setEditorDraftFetch,
  sourceChanged,
  type EditorDraft,
} from './editorDrafts';

const draftFixture = (hash: number, text = 'Old source'): EditorDraft => ({
  schemaVersion: 1,
  hash,
  english: `Draft for ${hash}`,
  sourceCommit: 'a'.repeat(40),
  source: { tab: 'Weapon Perks', gid: '7', range: 'C3:D3', text },
  styleGuide: 'v1',
  createdAt: '2026-11-11T00:00:00Z',
  model: 'claude-opus-5-5',
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => setEditorDraftFetch(undefined));

it('asks for the index once per session and treats a failure as no drafts', async () => {
  const fetcher = vi.fn(async () => json({ schemaVersion: 1, hashes: [10, 11] }));
  setEditorDraftFetch(fetcher);
  expect(knownDraftIndex()).toBeUndefined();
  const [a, b] = await Promise.all([editorDraftIndex(), editorDraftIndex()]);
  expect(a).toBe(b);
  expect([...a]).toEqual([10, 11]);
  expect(knownDraftIndex()).toBe(a);
  await editorDraftIndex();
  expect(fetcher).toHaveBeenCalledTimes(1);

  for (const failing of [
    async () => json({}, 404),
    async () => json({ schemaVersion: 2, hashes: [] }),
    async () => {
      throw new TypeError('Failed to fetch');
    },
  ]) {
    setEditorDraftFetch(failing);
    expect((await editorDraftIndex()).size).toBe(0);
  }
});

it('reads one draft per tooltip, rejects another hash, and retries a failure', async () => {
  let fail = true;
  const fetcher = vi.fn(async (path: string) => {
    if (fail) throw new TypeError('Failed to fetch');
    if (path === 'drafts/10.json') return json(draftFixture(10));
    if (path === 'drafts/12.json') return json(draftFixture(99));
    return json({}, 404);
  });
  setEditorDraftFetch(fetcher);
  expect(await editorDraft(10)).toBeNull();
  fail = false;
  expect((await editorDraft(10))?.english).toBe('Draft for 10');
  await editorDraft(10);
  expect(fetcher.mock.calls.filter(([path]) => path === 'drafts/10.json')).toHaveLength(2);
  expect(await editorDraft(12)).toBeNull();
  expect(await editorDraft(13)).toBeNull();
});

it('compares the range text of the current Compendium with the draft source', () => {
  const cell = (row: number, col: number, plain: string) => ({
    row,
    col,
    cell: { plain, runs: [{ text: plain }] },
  });
  const data = {
    fetchedAt: '2026-11-11T00:00:00Z',
    tabs: [
      {
        gid: '7',
        name: 'Weapon Perks',
        rows: [],
        grid: [cell(3, 3, 'source'), cell(3, 2, 'Old'), cell(4, 2, 'outside'), cell(3, 4, 'E3')],
      },
    ],
  } as unknown as CompendiumData;
  expect(rangeText(data, '7', 'C3:D3')).toBe('Old\nsource');
  expect(rangeText(data, '7', 'C3, C4')).toBe('Old\noutside');
  expect(rangeText(data, '8', 'C3')).toBeUndefined();
  expect(rangeText(data, '7', 'Z9')).toBeUndefined();
  expect(sourceChanged(draftFixture(10), null)).toBeUndefined();
  expect(sourceChanged(draftFixture(10, 'Old  source'), data)).toBe(false);
  expect(sourceChanged(draftFixture(10, 'Older source'), data)).toBe(true);
  expect(
    sourceChanged({ ...draftFixture(10), source: { ...draftFixture(10).source, gid: '9' } }, data),
  ).toBe(true);
});
