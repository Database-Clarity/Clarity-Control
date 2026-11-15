import { expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { englishDiffFor, findTranslationSource } from './source';

function version(updatedAt: string, text = 'original English'): { tooltip: Tooltip } {
  return {
    tooltip: { hash: 1, associated: [], text: { en: { text, updatedAt, updatedBy: 'e' } } },
  };
}
const source = '2026-01-01T00:00:00.000Z';

it('searches paginated versions by English revision, not commit date or translation update date', async () => {
  const getHistory = vi
    .fn()
    .mockResolvedValueOnce({ commits: [{ commit: 'a' }] })
    .mockResolvedValueOnce({ commits: [{ commit: 'b' }] })
    // A match may continue on the next page (same-time markup edits), so one more page is read.
    .mockResolvedValueOnce({ commits: [] });
  const getVersion = vi
    .fn()
    .mockResolvedValueOnce(version('2026-02-01T00:00:00Z'))
    .mockResolvedValueOnce(version('2026-01-01T01:00:00+01:00'));
  expect(await findTranslationSource(1, source, { getHistory, getVersion })).toEqual({
    kind: 'found',
    text: 'original English',
  });
  expect(getHistory).toHaveBeenNthCalledWith(2, 1, 2, undefined);
});

it('reports missing revisions explicitly, including the bounded search limit', async () => {
  const getVersion = vi.fn();
  expect(
    await findTranslationSource(1, source, {
      getHistory: vi.fn().mockResolvedValue({ commits: [] }),
      getVersion,
    }),
  ).toMatchObject({ kind: 'missing', reason: expect.stringContaining('not found') });
  expect(getVersion).not.toHaveBeenCalled();
  const getHistory = vi.fn().mockResolvedValue({ commits: [{ commit: 'a' }] });
  getVersion.mockResolvedValue(version('2026-02-01T00:00:00Z'));
  expect(await findTranslationSource(1, source, { getHistory, getVersion })).toMatchObject({
    kind: 'missing',
    reason: expect.stringContaining('600'),
  });
  expect(getHistory).toHaveBeenCalledTimes(20);
  expect(getVersion).toHaveBeenCalledTimes(1);
});

it('propagates unavailable history instead of silently claiming no source exists', async () => {
  await expect(
    findTranslationSource(1, source, {
      getHistory: vi.fn().mockRejectedValue(new Error('HTTP 403')),
      getVersion: vi.fn(),
    }),
  ).rejects.toThrow('HTTP 403');
});

it('takes the oldest English sharing the source time: tagging keeps updatedAt (ELEMENT-TAGS-2)', async () => {
  const getHistory = vi
    .fn()
    .mockResolvedValueOnce({ commits: [{ commit: 'c' }, { commit: 'b' }, { commit: 'a' }] });
  const getVersion = vi
    .fn()
    .mockResolvedValueOnce(version(source, 'Gain <solar Scorch /> and <void Void Breaches />.'))
    .mockResolvedValueOnce(version(source, 'Gain <solar Scorch /> and <void/>Void Breaches.'))
    .mockResolvedValueOnce(version('2025-12-01T00:00:00.000Z', 'Older wording.'));
  expect(await findTranslationSource(1, source, { getHistory, getVersion })).toEqual({
    kind: 'found',
    text: 'Gain <solar Scorch /> and <void/>Void Breaches.',
  });
  // The last page ending on a match still finds it.
  const one = vi.fn().mockResolvedValueOnce({ commits: [{ commit: 'a' }] });
  one.mockResolvedValueOnce({ commits: [] });
  expect(
    await findTranslationSource(1, source, {
      getHistory: one,
      getVersion: vi.fn().mockResolvedValue(version(source, 'Gain <solar/>Scorch.')),
    }),
  ).toEqual({ kind: 'found', text: 'Gain <solar/>Scorch.' });
});

it('offers the English diff for an outdated translation, and for a current one over tagged English', () => {
  const tooltip = (english: string) =>
    ({
      hash: 7,
      associated: [],
      text: {
        en: { text: english, updatedAt: source, updatedBy: 'e' },
        de: { text: 'Deutsch', updatedAt: source, updatedBy: 't', sourceUpdatedAt: source },
      },
    }) as Tooltip;
  const diff = { hash: 7, sourceUpdatedAt: source, current: 'Gain <solar Scorch />.' };
  expect(englishDiffFor(tooltip('Gain <solar Scorch />.'), 'de', 'current')).toEqual(diff);
  // Unwrapping the last tag leaves its icon: the comparison stays reachable (code review F3).
  expect(englishDiffFor(tooltip('Gain <solar/>Scorch.'), 'de', 'current')).toMatchObject({
    current: 'Gain <solar/>Scorch.',
  });
  expect(englishDiffFor(tooltip('Gain Scorch.'), 'de', 'current')).toBeUndefined();
  // Every element the core tags, Prismatic included: untagging leaves its icon, diff reachable.
  expect(
    englishDiffFor(tooltip('Gain <prismatic Transcendence />.'), 'de', 'current'),
  ).toMatchObject({ current: 'Gain <prismatic Transcendence />.' });
  expect(englishDiffFor(tooltip('Gain <prismatic/>Transcendence.'), 'de', 'current')).toMatchObject(
    { current: 'Gain <prismatic/>Transcendence.' },
  );
  expect(englishDiffFor(tooltip('Gain <solar/>Scorch.'), 'de', 'outdated')).toMatchObject({
    current: 'Gain <solar/>Scorch.',
  });
  expect(englishDiffFor(tooltip('Gain <solar Scorch />.'), 'fr', 'missing')).toBeUndefined();
});
