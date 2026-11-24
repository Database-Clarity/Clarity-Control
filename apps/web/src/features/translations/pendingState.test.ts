import { describe, expect, it } from 'vitest';
import type { Lang, Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { stampRevisions } from '../../services/save/enrichers/metadata';
import { needsUpdate, pendingTranslationState } from './pendingState';
import { translationIndex } from './queue';

const start = Date.parse('2026-01-01T00:00:00.000Z');
const at = (days: number) => new Date(start + days * 86_400_000).toISOString();

/** English on day 200; German from the English of `source` (undefined: unknown, null: none). */
function tooltip(source: number | null | undefined, hash = 101): Tooltip {
  const german = {
    text: 'Mehr Schaden.',
    updatedAt: at(150),
    updatedBy: 'b',
    ...(source == null ? {} : { sourceUpdatedAt: at(source) }),
  };
  return {
    hash,
    associated: [],
    text: {
      en: { text: 'Deals more damage.', updatedAt: at(200), updatedBy: 'a' },
      ...(source === null ? {} : { de: german }),
    },
  };
}

/** A draft as the editor makes it: typed text names the English it was typed against. */
function typed(base: Tooltip, text: string, lang: Lang = 'de') {
  const entry = {
    text,
    updatedAt: at(300),
    updatedBy: 'me',
    ...(lang === 'en' ? {} : { sourceUpdatedAt: base.text.en!.updatedAt }),
  };
  return { base, next: { ...base, text: { ...base.text, [lang]: entry } } };
}

const state = (saved: Tooltip, draft?: { base: Tooltip; next: Tooltip }) =>
  pendingTranslationState(saved, draft, 'de', at(300));

describe('the state once the draft is saved', () => {
  it('is the saved state without a draft', () => {
    expect(state(tooltip(null)).state).toBe('missing');
    expect(state(tooltip(200)).state).toBe('current');
    expect(state(tooltip(undefined)).state).toBe('current');
    expect(state(tooltip(199))).toMatchObject({ state: 'outdated', exportedInEnglish: false });
    expect(state(tooltip(110)).exportedInEnglish).toBe(false); // Exactly 90 days.
    expect(state(tooltip(109)).exportedInEnglish).toBe(true);
  });

  it('is current once new words are typed, and outdated again on undo', () => {
    const saved = tooltip(100);
    expect(state(saved, typed(saved, 'Viel mehr Schaden.')).state).toBe('current');
    expect(state(saved, typed(saved, saved.text.de!.text)).state).toBe('outdated');
  });

  it('stays outdated for a markup-only edit, which the save does not stamp', () => {
    const saved = tooltip(100);
    saved.text.de!.text = '<solar/>Mehr Schaden.';
    expect(state(saved, typed(saved, '<solar Mehr /> Schaden.')).state).toBe('outdated');
  });

  it('keeps the saved state under an unsaved English edit alone', () => {
    const saved = tooltip(200);
    expect(state(saved, typed(saved, 'Deals much more damage.', 'en')).state).toBe('current');
    const behind = tooltip(100);
    expect(state(behind, typed(behind, 'Deals much more damage.', 'en')).state).toBe('outdated');
  });

  it('shows a History restore of old text as behind', () => {
    const saved = tooltip(200);
    const draft = typed(saved, 'Alter Text.');
    draft.next.text.de = { ...draft.next.text.de!, updatedAt: at(40), sourceUpdatedAt: at(30) };
    expect(state(saved, draft)).toMatchObject({ state: 'outdated', exportedInEnglish: true });
  });

  it('stays outdated when English moved on after the draft was started', () => {
    const base = tooltip(100);
    const saved = structuredClone(base);
    saved.text.en = { text: 'Deals less damage.', updatedAt: at(250), updatedBy: 'c' };
    expect(state(saved, typed(base, 'Viel mehr Schaden.')).state).toBe('outdated');
  });

  it('shows the saved state while another save conflicts with the draft', () => {
    const base = tooltip(100);
    const draft = typed(base, 'Viel mehr Schaden.');
    const saved = structuredClone(base);
    saved.text.de = { ...saved.text.de!, text: 'Andere Worte.', updatedAt: at(260) };
    expect(state(saved, draft).state).toBe('outdated');
    saved.text.de.sourceUpdatedAt = at(200);
    expect(state(saved, draft).state).toBe('current');
  });

  it('follows a removed number until its token is gone', () => {
    const saved = tooltip(200);
    saved.text.en!.numbers = { ids: [], next: 2, retired: { 1: '5' } };
    saved.text.de!.text = 'Schaden: #{=1}';
    expect(state(saved)).toMatchObject({ state: 'outdated', reason: 'numbers', ageMs: 0 });
    expect(state(saved, typed(saved, 'Nur Schaden: #{=1}')).state).toBe('outdated');
    expect(state(saved, typed(saved, 'Schaden.')).state).toBe('current');
  });
});

it('agrees with the Translations tab on a generated set, saved and as it will be saved', () => {
  let seed = 7;
  const random = (max: number) => (seed = (seed * 48_271) % 2_147_483_647) % max;
  const tooltips: Record<number, Tooltip> = {};
  const items: Record<number, unknown> = {};
  for (let hash = 1000; hash < 1600; hash++) {
    const entry = tooltip([null, undefined, 200, 199, 150, 110, 109, 20][random(8)], hash);
    if (random(10) === 0) entry.text.en!.text = ' ';
    if (random(10) === 0)
      entry.archive = {
        removedAt: at(1),
        lastSeen: { name: 'Gone', categoryId: 'perks', manifestVersion: 'v1' },
      };
    tooltips[hash] = entry;
    items[hash] = {
      hash,
      name: `Item ${hash}`,
      icon: '',
      categoryId: random(10) ? 'perks' : 'inactive-placeholder',
      inGameDescription: '',
    };
  }
  const data = {
    items,
    categories: [{ id: 'perks', label: 'Perks', legacyType: 'perks' }],
    aliases: { 1001: 1002 },
    bundle: { tooltips, pushed: {} },
  } as unknown as EditorData;
  const outdated = (source: EditorData) =>
    new Map(
      translationIndex(source)
        .queue('de')
        .filter((row) => row.state === 'outdated')
        .map((row) => [row.hash, row.exportedInEnglish]),
    );
  const saved = outdated(data);
  expect(saved.size).toBeGreaterThan(100);
  const texts = ['Neu.', 'Mehr Schaden.', '<solar/>Mehr Schaden.'];
  const after: Record<number, Tooltip> = {};
  const pending = new Map<number, boolean | undefined>();
  for (const entry of Object.values(tooltips)) {
    expect(needsUpdate(entry, undefined, 'en', data)).toBeNull();
    expect([entry.hash, needsUpdate(entry, undefined, 'de', data)?.exportedInEnglish]).toEqual([
      entry.hash,
      saved.get(entry.hash),
    ]);
    const draft = typed(entry, texts[random(3)]!);
    if (draft.next.text.de?.text === entry.text.de?.text) draft.next = entry;
    after[entry.hash] = stampRevisions(entry, draft.next, 'me', at(300));
    const update = needsUpdate(entry, draft, 'de', data);
    if (update) pending.set(entry.hash, update.exportedInEnglish);
  }
  const then = outdated({ ...data, bundle: { ...data.bundle, tooltips: after } });
  expect(then.size).toBeGreaterThan(20);
  expect(pending).toEqual(then);
});
