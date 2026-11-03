import { expect, test } from 'vitest';
import { merge3 } from '../src/merge3.js';
import { tooltip } from './helpers.js';

test('independent language and atomic-field edits merge without mutating input', () => {
  const base = tooltip();
  const head = structuredClone(base);
  const next = structuredClone(base);
  head.text.de = { ...head.text.en!, text: 'Deutsch' };
  next.text.en!.text = 'Changed';
  next.custom = { name: 'Verb', categoryId: 'verbs' };
  const original = structuredClone([base, head, next]);
  expect(merge3(base, head, next)).toEqual({
    ok: true, merged: { ...next, text: { ...next.text, de: head.text.de } },
  });
  expect([base, head, next]).toEqual(original);
});
test('identical edits and unchanged branches merge', () => {
  const base = tooltip();
  const head = { ...tooltip(), custom: { name: 'Verb', categoryId: 'verbs' } };
  expect(merge3(base, head, head)).toEqual({ ok: true, merged: head });
  expect(merge3(base, head, base)).toEqual({ ok: true, merged: head });
  expect(merge3(base, base, head)).toEqual({ ok: true, merged: head });
});
test('reports all same-language and atomic conflicts, not partial success', () => {
  const base = tooltip();
  const head = structuredClone(base);
  const next = structuredClone(base);
  head.text.en!.text = 'Theirs';
  next.text.en!.text = 'Mine';
  head.custom = { name: 'Theirs', categoryId: 'verbs' };
  next.custom = { name: 'Mine', categoryId: 'verbs' };
  const result = merge3(base, head, next);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.conflicts.map((conflict) => conflict.field).sort()).toEqual(['custom', 'text.en']);
  expect(result).not.toHaveProperty('merged');
});
test('association additions union and removals win for existing members', () => {
  const base = { ...tooltip(), associated: [1, 2] };
  const head = { ...base, associated: [2, 3] };
  const next = { ...base, associated: [1, 4] };
  expect(merge3(base, head, next)).toEqual({
    ok: true, merged: { ...base, associated: [4, 3] },
  });
});
test('association reorder merges with an untouched side in either direction', () => {
  const base = { ...tooltip(), associated: [1, 2, 3] };
  const reordered = { ...base, associated: [3, 1, 2] };
  expect(merge3(base, base, reordered)).toEqual({ ok: true, merged: reordered });
  expect(merge3(base, reordered, base)).toEqual({ ok: true, merged: reordered });
});
test('association reorder keeps its order and appends the other side additions', () => {
  const base = { ...tooltip(), associated: [1, 2, 3] };
  const head = { ...base, associated: [1, 2, 3, 4, 5] };
  const next = { ...base, associated: [3, 2, 1] };
  expect(merge3(base, head, next)).toEqual({
    ok: true, merged: { ...base, associated: [3, 2, 1, 4, 5] },
  });
});
test('association reorder on both sides never conflicts and keeps mine', () => {
  const base = { ...tooltip(), associated: [1, 2, 3] };
  const head = { ...base, associated: [2, 3, 1] };
  const next = { ...base, associated: [3, 1, 2] };
  expect(merge3(base, head, next)).toEqual({
    ok: true, merged: { ...base, associated: [3, 1, 2] },
  });
});
test('association removal merges with a reorder on the other side', () => {
  const base = { ...tooltip(), associated: [1, 2, 3] };
  const removed = { ...base, associated: [1, 3] };
  const reordered = { ...base, associated: [3, 2, 1] };
  expect(merge3(base, removed, reordered)).toEqual({
    ok: true, merged: { ...base, associated: [3, 1] },
  });
  expect(merge3(base, reordered, removed)).toEqual({
    ok: true, merged: { ...base, associated: [1, 3] },
  });
});
test('deletion merges with unchanged but conflicts with editing the deleted field', () => {
  const base = { ...tooltip(), custom: { name: 'Verb', categoryId: 'verbs' } };
  const head = tooltip();
  expect(merge3(base, head, base)).toEqual({ ok: true, merged: head });
  expect(merge3(base, head, { ...base, custom: { name: 'Changed', categoryId: 'verbs' } }).ok).toBe(false);
  const removedLanguage = { ...base, text: {} };
  expect(merge3(base, removedLanguage, base).ok).toBe(true);
  const edited = structuredClone(base);
  edited.text.en!.text = 'new';
  expect(merge3(base, removedLanguage, edited).ok).toBe(false);
});
test('rejects cross-tooltip merges', () => {
  expect(() => merge3(tooltip(), tooltip(), { ...tooltip(), hash: 99 })).toThrow('different tooltip');
});

test('a retried save that re-stamped identical text is not a conflict and keeps the first stamps', () => {
  const base = tooltip();
  const first = structuredClone(base);
  first.text.en = { text: 'Edited', updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'alice' };
  first.bungieSnapshot = { description: 'Game text', snapshotAt: '2026-11-01T00:00:00Z' };
  const retry = structuredClone(first);
  retry.text.en = { text: 'Edited', updatedAt: '2026-11-01T00:05:00Z', updatedBy: 'alice' };
  retry.bungieSnapshot = { description: 'Game text', snapshotAt: '2026-11-01T00:05:00Z' };
  expect(merge3(base, first, retry)).toEqual({ ok: true, merged: first });
  // Different text is still a conflict.
  retry.text.en!.text = 'Edited differently';
  expect(merge3(base, first, retry)).toMatchObject({ ok: false });
});
test('a metadata-only change on an unchanged text is still applied', () => {
  const base = tooltip();
  const next = structuredClone(base);
  next.text.en!.updatedBy = 'bob';
  expect(merge3(base, base, next)).toEqual({ ok: true, merged: next });
});
