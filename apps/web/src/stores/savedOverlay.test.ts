import { beforeEach, expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import type { Bundle } from '../services/bundle';
import {
  applySavedOverlay,
  clearSavedOverlay,
  overlayClockSkewMs,
  overlayTtlMs,
  rememberSaved,
} from './savedOverlay';
const at = Date.parse('2026-11-01T00:00:00Z');
const tooltip = (text: string): Tooltip => ({
  hash: 10,
  text: { en: { text, updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'user' } },
  associated: [],
});
const bundle = (text: string | null, generatedAt = at): Bundle => ({
  sourceCommit: 'abc',
  generatedAt: new Date(generatedAt).toISOString(),
  tooltips: text === null ? {} : { 10: tooltip(text) },
  permissions: { users: {} },
  pushed: {},
});
beforeEach(clearSavedOverlay);
it('keeps stale and equal-time bundles, including the skew boundary', () => {
  rememberSaved([tooltip('mine')], [], at);
  for (const generatedAt of [at - 1, at, at + overlayClockSkewMs])
    expect(applySavedOverlay(bundle('old', generatedAt), at + 100).tooltips[10]).toEqual(
      tooltip('mine'),
    );
});
it('retires for newer edits by someone else before the TTL, without reapplying later', () => {
  rememberSaved([tooltip('mine')], [], at);
  const newer = bundle('theirs', at + overlayClockSkewMs + 1);
  expect(applySavedOverlay(newer, at + 100)).toBe(newer);
  const stale = bundle('old');
  expect(applySavedOverlay(stale, at + 101)).toBe(stale);
});
it('hides stale deleted copies, then allows a demonstrably newer recreation', () => {
  rememberSaved([], [10], at);
  expect(applySavedOverlay(bundle('old'), at + 1).tooltips[10]).toBeUndefined();
  expect(
    applySavedOverlay(bundle('recreated', at + overlayClockSkewMs + 1), at + 2).tooltips[10],
  ).toEqual(tooltip('recreated'));
});
it('equality, deletion catch-up, TTL, and later local saves retire or replace entries', () => {
  rememberSaved([tooltip('mine')], [], at);
  const equal = bundle('mine');
  expect(applySavedOverlay(equal, at)).toBe(equal);
  expect(applySavedOverlay(bundle('other'), at).tooltips[10]).toEqual(tooltip('other'));
  rememberSaved([], [10], at);
  expect(applySavedOverlay(bundle(null), at).tooltips[10]).toBeUndefined();
  rememberSaved([tooltip('newest')], [], at + overlayClockSkewMs * 2);
  expect(
    applySavedOverlay(bundle('other', at + overlayClockSkewMs + 1), at + overlayClockSkewMs * 2)
      .tooltips[10],
  ).toEqual(tooltip('newest'));
  const expired = bundle('other');
  expect(applySavedOverlay(expired, at + overlayClockSkewMs * 2 + overlayTtlMs + 1)).toBe(expired);
});

it('keeps edits and deletions when the browser is two minutes slow and the bundle predates the save', () => {
  const browserSavedAt = at - 2 * 60 * 1000;
  const beforeSave = {
    ...bundle('old', at - 30 * 1000),
    tooltips: { 10: tooltip('old'), 11: { ...tooltip('deleted old'), hash: 11 } },
  };
  rememberSaved([tooltip('mine')], [11], browserSavedAt);
  const result = applySavedOverlay(beforeSave, browserSavedAt + 1000);
  expect(result.tooltips[10]).toEqual(tooltip('mine'));
  expect(result.tooltips[11]).toBeUndefined();
  expect(beforeSave.tooltips[11]).toBeDefined();
  const atBoundary = {
    ...beforeSave,
    generatedAt: new Date(browserSavedAt + overlayClockSkewMs).toISOString(),
  };
  expect(applySavedOverlay(atBoundary, browserSavedAt + 2000).tooltips[10]).toEqual(
    tooltip('mine'),
  );
  expect(applySavedOverlay(atBoundary, browserSavedAt + 2000).tooltips[11]).toBeUndefined();
  const beyondBoundary = {
    ...beforeSave,
    generatedAt: new Date(browserSavedAt + overlayClockSkewMs + 1).toISOString(),
  };
  expect(applySavedOverlay(beyondBoundary, browserSavedAt + 3000)).toBe(beyondBoundary);
});
