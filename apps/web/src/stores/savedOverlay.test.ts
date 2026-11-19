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
  rememberSavedGlobal,
  applySavedGlobals,
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

it('keeps a saved global until the bundle is built from its head, holds it, or renamed it', () => {
  const saved = {
    version: 1 as const,
    id: 'g_damage0001',
    kind: 'variables' as const,
    name: 'Damage',
    revision: 'r2',
    nameHistory: [],
    definitions: {
      en: { body: '25%', revision: 'r2', updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'user' },
    },
  };
  const older = {
    ...saved,
    revision: 'r1',
    definitions: { en: { ...saved.definitions.en, body: '15%', revision: 'r1' } },
  };
  const meta = (sourceCommit: string) => ({
    sourceCommit,
    generatedAt: new Date(at).toISOString(),
  });
  rememberSavedGlobal(saved, 'b'.repeat(40), at);
  // Lagging bundle: the saved record shows, and a create the bundle lacks is added.
  expect(applySavedGlobals(meta('a'.repeat(40)), [older], at + 100)).toEqual([saved]);
  expect(applySavedGlobals(meta('a'.repeat(40)), [], at + 100)).toEqual([saved]);
  // The publisher completed a later rename of the saved revision: its record wins and retires.
  const renamed = {
    ...saved,
    name: 'Harm',
    revision: 'r3',
    nameHistory: [{ name: 'Damage', revision: 'r2', at: '2026-11-01T00:01:00Z', by: 'user' }],
  };
  expect(applySavedGlobals(meta('c'.repeat(40)), [renamed], at + 100)).toEqual([renamed]);
  expect(applySavedGlobals(meta('a'.repeat(40)), [older], at + 100)).toEqual([older]);
  // Built from the saved head: the bundle's own record shows, whatever it holds.
  rememberSavedGlobal(saved, 'b'.repeat(40), at);
  expect(applySavedGlobals(meta('b'.repeat(40)), [older], at + 100)).toEqual([older]);
  expect(applySavedGlobals(meta('a'.repeat(40)), [older], at + 100)).toEqual([older]);
  // Past the TTL the save no longer overrides.
  rememberSavedGlobal(saved, 'b'.repeat(40), at);
  expect(applySavedGlobals(meta('a'.repeat(40)), [older], at + overlayTtlMs + 1)).toEqual([older]);
});
