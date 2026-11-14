import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMarkupOnly, translationStateOf, type Tooltip } from '@clarity/core';
import { englishDiffFor } from '../../../features/translations/source';
import type { Me } from '../../api';
import type { Item } from '../../generator';
import { enrichTooltip, saveEnrichers } from './index';

const en = { text: 'English', updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'original' };
const fr = {
  text: 'French',
  updatedAt: '2026-01-02T00:00:00.000Z',
  updatedBy: 'translator',
  sourceUpdatedAt: en.updatedAt,
};
const before: Tooltip = { hash: 10, text: { en, fr }, associated: [] };
const user: Me = { id: 1, login: 'current', role: 'editor' };
const item: Item = {
  hash: 10,
  name: 'Perk',
  icon: '',
  categoryId: 'perk',
  inGameDescription: 'Manifest',
};
const now = '2026-10-27T13:00:00.000Z';

afterEach(() => vi.useRealTimers());
describe('save enrichers', () => {
  it('stamps changed English, leaving every translation byte-for-byte unchanged', async () => {
    vi.useFakeTimers().setSystemTime(new Date(now));
    const next = { ...before, text: { ...before.text, en: { ...en, text: 'New English' } } };
    const enriched = await enrichTooltip({ before, next, user, item });
    expect(enriched.text.en).toEqual({
      ...en,
      text: 'New English',
      updatedAt: now,
      updatedBy: user.login,
    });
    expect(enriched.text.fr).toBe(fr);
    expect(enriched.bungieSnapshot).toEqual({ description: 'Manifest', snapshotAt: now });
    expect(before.text.en).toBe(en);
  });
  it('stamps changed translations against the current English revision', async () => {
    vi.useFakeTimers().setSystemTime(new Date(now));
    const next = { ...before, text: { ...before.text, fr: { ...fr, text: 'New French' } } };
    const enriched = await enrichTooltip({ before, next, user });
    expect(enriched.text.en).toBe(en);
    expect(enriched.text.fr).toEqual({
      text: 'New French',
      updatedAt: now,
      updatedBy: 'current',
      sourceUpdatedAt: en.updatedAt,
    });
  });
  it('uses the newly stamped English when both languages change in one save', async () => {
    vi.useFakeTimers().setSystemTime(new Date(now));
    const next = {
      ...before,
      text: { en: { ...en, text: 'New' }, fr: { ...fr, text: 'Nouveau' } },
    };
    expect((await enrichTooltip({ before, next, user })).text.fr?.sourceUpdatedAt).toBe(now);
  });
  it('does not stamp text metadata for snapshot-only saves', async () => {
    const result = await enrichTooltip({
      before,
      next: {
        ...before,
        bungieSnapshot: { description: 'Manifest', snapshotAt: now },
      },
      user,
      item,
    });
    expect(result.text).toEqual(before.text);
    expect(result.bungieSnapshot?.description).toBe('Manifest');
  });
  it('leaves snapshots untouched for translation-only edits, for every role', async () => {
    const snapshot = { description: 'Old manifest', snapshotAt: en.updatedAt };
    const original = { ...before, bungieSnapshot: snapshot };
    const next = { ...original, text: { ...original.text, fr: { ...fr, text: 'Nouveau' } } };
    for (const role of ['editor', 'maintainer', 'trial', 'translator'] as const) {
      const result = await enrichTooltip({ before: original, next, user: { ...user, role }, item });
      expect(result.bungieSnapshot).toBe(snapshot);
    }
  });
  it('retains current author metadata when restoring identical text from history', async () => {
    const next = { ...before, text: { ...before.text, en: { ...en, updatedBy: 'older-author' } } };
    expect((await enrichTooltip({ before, next, user })).text.en).toBe(en);
  });
  it('supports new tooltips and rejects a translation without an English revision', async () => {
    vi.useFakeTimers().setSystemTime(new Date(now));
    expect(
      (await enrichTooltip({ before: undefined, next: before, user })).text.en?.updatedAt,
    ).toBe(now);
    await expect(
      enrichTooltip({ before: undefined, next: { ...before, text: { fr } }, user }),
    ).rejects.toThrow('English source');
  });
  it('runs extensions sequentially and propagates errors rather than saving partial enrichment', async () => {
    const first = vi.fn(async ({ next }: { next: Tooltip }) => ({ ...next, associated: [20] }));
    const second = vi.fn(async ({ next }: { next: Tooltip }) => {
      expect(next.associated).toEqual([20]);
      throw new Error('snapshot unavailable');
    });
    saveEnrichers.push(first, second);
    try {
      await expect(enrichTooltip({ before, next: before, user })).rejects.toThrow(
        'snapshot unavailable',
      );
      expect(first).toHaveBeenCalledOnce();
    } finally {
      saveEnrichers.splice(-2);
    }
  });
});

// ELEMENT-TAGS-2 metadata policy: a tagging-only edit (the lowered text is unchanged) keeps the
// content revision, so the translation queue, the 90-day fallback, the exported lastUpdate, and
// Bungie drift stay neutral to tagging; a real wording change still stamps.
describe('markup-only edits (element tags)', () => {
  const tagged = { ...en, text: 'Gain <solar/>Scorch.' };
  const original: Tooltip = {
    hash: 10,
    text: { en: tagged, fr: { ...fr, text: 'Gagne <solar/>Brûlure.' } },
    associated: [],
    bungieSnapshot: { description: 'Old manifest', snapshotAt: en.updatedAt },
  };
  const edit = (lang: 'en' | 'fr', text: string): Tooltip => ({
    ...original,
    text: { ...original.text, [lang]: { ...original.text[lang]!, text } },
  });

  it('tagging English keeps updatedAt, updatedBy, and the Bungie snapshot', async () => {
    vi.useFakeTimers().setSystemTime(new Date(now));
    const result = await enrichTooltip({
      before: original,
      next: edit('en', 'Gain <solar Scorch />.'),
      user,
      item,
    });
    expect(result.text.en).toEqual({ ...tagged, text: 'Gain <solar Scorch />.' });
    expect(result.text.fr).toBe(original.text.fr);
    expect(result.bungieSnapshot).toBe(original.bungieSnapshot);
  });

  it('untagging is markup-only; changing the element is a real change and stamps', async () => {
    vi.useFakeTimers().setSystemTime(new Date(now));
    const taggedBefore = edit('en', 'Gain <solar Scorch />.');
    const untagged = await enrichTooltip({
      before: taggedBefore,
      next: edit('en', 'Gain <solar/>Scorch.'),
      user,
    });
    expect(untagged.text.en?.updatedAt).toBe(en.updatedAt);
    // Another element lowers to another icon: the consumer text changes.
    const changed = await enrichTooltip({
      before: taggedBefore,
      next: edit('en', 'Gain <arc Scorch />.'),
      user,
    });
    expect(changed.text.en?.updatedAt).toBe(now);
  });

  it('unwrapping the last tag: the translation stays current and its pane offers the diff', async () => {
    vi.useFakeTimers().setSystemTime(new Date(now));
    const taggedBefore = edit('en', 'Gain <solar Scorch />.');
    const saved = await enrichTooltip({
      before: taggedBefore,
      next: edit('en', 'Gain <solar/>Scorch.'),
      user,
    });
    expect(translationStateOf(saved, 'fr').state).toBe('current');
    expect(englishDiffFor(saved, 'fr', 'current')).toEqual({
      hash: 10,
      sourceUpdatedAt: en.updatedAt,
      current: 'Gain <solar/>Scorch.',
    });
    expect(isMarkupOnly('Gain <solar Scorch />.', 'Gain <solar/>Scorch.')).toBe(true);
  });

  it('tagging a translation keeps its revision and its sourceUpdatedAt', async () => {
    vi.useFakeTimers().setSystemTime(new Date(now));
    const result = await enrichTooltip({
      before: original,
      next: edit('fr', 'Gagne <solar Brûlure />.'),
      user,
    });
    expect(result.text.fr).toEqual({ ...original.text.fr, text: 'Gagne <solar Brûlure />.' });
  });

  it('a real wording change with tags still stamps (and re-snapshots Bungie)', async () => {
    vi.useFakeTimers().setSystemTime(new Date(now));
    const result = await enrichTooltip({
      before: original,
      next: edit('en', 'Gain <solar Scorch /> twice.'),
      user,
      item,
    });
    expect(result.text.en).toMatchObject({ updatedAt: now, updatedBy: 'current' });
    expect(result.bungieSnapshot?.snapshotAt).toBe(now);
  });

  it('an outdated or near-fallback translation stays exactly as outdated after tagging', async () => {
    // The French follows an older English revision (outdated); tagging English must not move
    // the English revision, so the gap that drives the queue and the 90-day fallback is unchanged.
    const outdated: Tooltip = {
      ...original,
      text: {
        ...original.text,
        fr: { ...original.text.fr!, sourceUpdatedAt: '2025-01-01T00:00:00.000Z' },
      },
    };
    const next = {
      ...outdated,
      text: { ...outdated.text, en: { ...tagged, text: 'Gain <solar Scorch />.' } },
    };
    const result = await enrichTooltip({ before: outdated, next, user });
    expect(result.text.en?.updatedAt).toBe(outdated.text.en?.updatedAt);
    expect(result.text.fr?.sourceUpdatedAt).toBe('2025-01-01T00:00:00.000Z');
  });
});

describe('markup-only edits (delimited variables and the arrow symbol)', () => {
  const english = { ...en, text: 'Lasts #d s.\nenhanced (\nvar d = 1\n#e Faster.\n)' };
  const original: Tooltip = {
    hash: 10,
    text: { en: english, fr: { ...fr, text: 'Dure #d s.' } },
    associated: [],
  };
  const withEnglish = (text: string): Tooltip => ({
    ...original,
    text: { ...original.text, en: { ...english, text } },
  });

  it('braces and the symbol keep the English revision and leave the translation current', async () => {
    vi.useFakeTimers().setSystemTime(new Date(now));
    const text = 'Lasts #{d} s.\nenhanced (\nvar d = 1\n<enhanced/> Faster.\n)';
    const result = await enrichTooltip({ before: original, next: withEnglish(text), user });
    expect(result.text.en).toEqual({ ...english, text });
    expect(result.text.fr).toBe(original.text.fr);
  });

  it('braces that change what is read (#dx to #{d}x) are a real change and stamp', async () => {
    vi.useFakeTimers().setSystemTime(new Date(now));
    const before = withEnglish('var d = 1\nLasts #dx.');
    const result = await enrichTooltip({
      before,
      next: { ...before, text: { ...before.text, en: { ...before.text.en!, text: 'var d = 1\nLasts #{d}x.' } } },
      user,
    });
    expect(result.text.en?.updatedAt).toBe(now);
  });
});
