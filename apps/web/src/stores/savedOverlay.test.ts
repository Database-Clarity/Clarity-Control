import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import type { Bundle } from '../services/bundle';
import {
  applySavedOverlay,
  clearSavedOverlay,
  overlayClockSkewMs,
  overlayServerSkewMs,
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

afterEach(() => vi.useRealTimers());
it.each([-10, 10])(
  'uses server chronology for edits and deletions with a %i minute browser skew',
  (minutes) => {
    vi.useFakeTimers();
    vi.setSystemTime(at + minutes * 60 * 1000);
    rememberSaved([tooltip('mine')], [11], Date.now(), at);
    const stale = {
      ...bundle('old', at - 1),
      tooltips: { 10: tooltip('old'), 11: { ...tooltip('deleted'), hash: 11 } },
    };
    for (const generatedAt of [at - 1, at, at + overlayServerSkewMs]) {
      const result = applySavedOverlay({
        ...stale,
        generatedAt: new Date(generatedAt).toISOString(),
      });
      expect(result.tooltips[10]).toEqual(tooltip('mine'));
      expect(result.tooltips[11]).toBeUndefined();
    }
    vi.advanceTimersByTime(1000);
    const newer = { ...stale, generatedAt: new Date(at + overlayServerSkewMs + 1).toISOString() };
    expect(applySavedOverlay(newer)).toBe(newer);
    expect(applySavedOverlay(stale)).toBe(stale);
  },
);
it('bounds even a far-future server time by the browser TTL', () => {
  rememberSaved([tooltip('mine')], [11], at, at + 24 * 60 * 60 * 1000);
  const stale = bundle('old');
  expect(applySavedOverlay(stale, at + overlayTtlMs).tooltips[10]).toEqual(tooltip('mine'));
  expect(applySavedOverlay(stale, at + overlayTtlMs + 1)).toBe(stale);
});
it.each([NaN, Infinity, 0, at - 24 * 60 * 60 * 1000 - 1])(
  'falls back for an unusable server time %s',
  (serverAt) => {
    rememberSaved([tooltip('mine')], [], at, serverAt);
    expect(applySavedOverlay(bundle('old', at + overlayClockSkewMs), at).tooltips[10]).toEqual(
      tooltip('mine'),
    );
    const newer = bundle('other', at + overlayClockSkewMs + 1);
    expect(applySavedOverlay(newer, at)).toBe(newer);
  },
);

it.each([0, -10, 10])('keeps delayed pre-save builds with a %i minute browser skew', (minutes) => {
  vi.useFakeTimers();
  vi.setSystemTime(at + minutes * 60 * 1000);
  rememberSaved([tooltip('mine')], [11], Date.now(), at);
  for (const delaySeconds of [6, 30, 90, 300]) {
    const delayed = {
      ...bundle('old', at + delaySeconds * 1000),
      tooltips: { 10: tooltip('old'), 11: { ...tooltip('deleted old'), hash: 11 } },
    };
    const result = applySavedOverlay(delayed);
    expect(result.tooltips[10]).toEqual(tooltip('mine'));
    expect(result.tooltips[11]).toBeUndefined();
  }
});
