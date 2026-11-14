import {
  isMarkupOnly,
  languages,
  translationStateOf,
  usesEnglishFallback,
  type Lang,
  type Tooltip,
} from '@clarity/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Change, Me } from '../api';
import { noImpactApplies, stampEnglish, stampRevisions } from './enrichers/metadata';
import { liveFallback, noImpactAvailable } from './fallback';
import { editorData } from './fixtures.testSupport';
import { prepareChanges, validateChanges } from './pipeline';

vi.mock('./validationWorker', () => ({
  requestSaveValidation: async (
    changes: Change[],
    data: import('../../stores/data').EditorData,
    fallback?: import('./fallback').LiveFallback,
  ) => {
    const { validateChanges } = await import('./validation');
    return validateChanges(changes, data, fallback);
  },
}));
afterEach(() => vi.useRealTimers());

const DAY = 24 * 60 * 60 * 1000;
const LIMIT = 90 * DAY;
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse('2026-06-01T00:00:00.000Z');
const NOW = T0 + 30 * DAY;
const editor: Me = { id: 2, login: 'editor', role: 'editor' };

/** The metadata enricher exactly as it was before TR3 (reference for "unticked = as today"). */
function stampBeforeTr3(before: Tooltip | undefined, next: Tooltip, login: string, now: string) {
  const text: Tooltip['text'] = { ...next.text };
  for (const lang of languages) {
    const entry = text[lang];
    if (!entry) continue;
    const previous = before?.text[lang];
    if (entry.text === previous?.text) {
      text[lang] = previous;
      continue;
    }
    if (previous && isMarkupOnly(previous.text, entry.text)) {
      text[lang] = { ...previous, text: entry.text };
      continue;
    }
    text[lang] = { ...entry, updatedAt: now, updatedBy: login };
  }
  for (const lang of languages) {
    const entry = text[lang];
    const previous = before?.text[lang]?.text;
    if (lang === 'en' || !entry || entry.text === previous || isMarkupOnly(previous, entry.text))
      continue;
    if (text.en) text[lang] = { ...entry, sourceUpdatedAt: text.en.updatedAt };
    else throw new Error(`Cannot stamp ${lang} without an English source revision.`);
  }
  return { ...next, text };
}

const translation = (text: string, sourceUpdatedAt: number) => ({
  text,
  updatedAt: iso(sourceUpdatedAt + 1000),
  updatedBy: 'translator',
  sourceUpdatedAt: iso(sourceUpdatedAt),
});
/** English at T0; de current, fr outdated, ja exactly 90 days behind NOW, ko already falling back. */
const saved: Tooltip = {
  hash: 124,
  text: {
    en: { text: 'English one', updatedAt: iso(T0), updatedBy: 'author' },
    de: translation('Deutsch', T0),
    fr: translation('Francais', T0 - 10 * DAY),
    ja: translation('Nihongo', NOW - LIMIT),
    ko: translation('Hangug', T0 - 91 * DAY),
  },
  associated: [],
};
const withEnglish = (tooltip: Tooltip, text: string): Tooltip => ({
  ...tooltip,
  text: { ...tooltip.text, en: { ...tooltip.text.en!, text } },
});
const states = (tooltip: Tooltip) =>
  Object.fromEntries(
    languages
      .filter((lang) => lang !== 'en')
      .map((lang) => [
        lang,
        { ...translationStateOf(tooltip, lang), fallback: usesEnglishFallback(tooltip, lang) },
      ]),
  );

describe('TR3 stamps: which move and which do not', () => {
  it('a ticked English wording change keeps the English revision and every translation state', () => {
    const next = withEnglish(saved, 'English one, fixed');
    const stamped = stampRevisions(saved, next, 'editor', iso(NOW), true);
    expect(stamped.text.en).toEqual({ ...saved.text.en, text: 'English one, fixed' });
    for (const lang of ['de', 'fr', 'ja', 'ko'] as const)
      expect(stamped.text[lang]).toBe(saved.text[lang]);
    expect(states(stamped)).toEqual(states(saved));
    // The before-state the proof relies on: current, outdated, exactly 90 days (not over), over.
    expect(states(saved)).toMatchObject({
      de: { state: 'current', fallback: false },
      fr: { state: 'outdated', fallback: false },
      ko: { state: 'outdated', fallback: true },
    });
  });
  it('an unticked save behaves exactly as before TR3 (same stamps, translations outdated)', () => {
    const next = withEnglish(saved, 'English one, fixed');
    const stamped = stampRevisions(saved, next, 'editor', iso(NOW));
    expect(stamped).toEqual(stampBeforeTr3(saved, next, 'editor', iso(NOW)));
    expect(stamped.text.en?.updatedAt).toBe(iso(NOW));
    expect(states(stamped)).toMatchObject({
      de: { state: 'outdated', fallback: false },
      ja: { state: 'outdated', fallback: false },
    });
  });
  it('the 90-day boundary: exactly 90 days of English revision gap keeps the translation', () => {
    const next = withEnglish(saved, 'English two');
    const atLimit = stampRevisions(saved, next, 'editor', iso(NOW));
    expect(
      Date.parse(atLimit.text.en!.updatedAt) - Date.parse(saved.text.ja!.sourceUpdatedAt!),
    ).toBe(LIMIT);
    expect(usesEnglishFallback(atLimit, 'ja')).toBe(false);
    const overLimit = stampRevisions(saved, next, 'editor', iso(NOW + 1));
    expect(usesEnglishFallback(overLimit, 'ja')).toBe(true);
    // Ticked, the same save one millisecond later flips nothing.
    expect(
      usesEnglishFallback(stampRevisions(saved, next, 'editor', iso(NOW + 1), true), 'ja'),
    ).toBe(false);
  });
  it('a later unticked save measures its gap as if the ticked change never happened', () => {
    const ticked = stampRevisions(
      saved,
      withEnglish(saved, 'English one, fixed'),
      'e',
      iso(NOW),
      true,
    );
    const later = NOW + 5 * DAY;
    const afterBoth = stampRevisions(ticked, withEnglish(ticked, 'English two'), 'f', iso(later));
    const direct = stampRevisions(saved, withEnglish(saved, 'English two'), 'f', iso(later));
    expect(afterBoth).toEqual(direct);
    expect(states(afterBoth)).toEqual(states(direct));
  });
  it('the tick applies only where it can matter: English wording on a translated tooltip', () => {
    const lone: Tooltip = { hash: 9, text: { en: saved.text.en! }, associated: [] };
    const loneNext = withEnglish(lone, 'Changed');
    expect(noImpactApplies(lone, loneNext)).toBe(false);
    expect(stampRevisions(lone, loneNext, 'e', iso(NOW), true).text.en?.updatedAt).toBe(iso(NOW));
    // Translation-only save: the tick changes nothing.
    const de = { ...saved, text: { ...saved.text, de: { ...saved.text.de!, text: 'Neu' } } };
    expect(noImpactApplies(saved, de)).toBe(false);
    expect(stampRevisions(saved, de, 'e', iso(NOW), true)).toEqual(
      stampRevisions(saved, de, 'e', iso(NOW)),
    );
    // Markup-only English keeps the revision either way; a new tooltip has nothing to keep.
    const tagged = withEnglish(
      { ...saved, text: { ...saved.text, en: { ...saved.text.en!, text: '<solar/>Scorch' } } },
      '<solar Scorch />',
    );
    expect(
      noImpactApplies(
        { ...saved, text: { ...saved.text, en: { ...saved.text.en!, text: '<solar/>Scorch' } } },
        tagged,
      ),
    ).toBe(false);
    expect(noImpactApplies(undefined, saved)).toBe(false);
    expect(noImpactAvailable([{ hash: 124, base: saved, next: withEnglish(saved, 'x') }])).toBe(
      true,
    );
    expect(noImpactAvailable([{ hash: 9, base: lone, next: loneNext }])).toBe(false);
  });
  it('editing a translation in the same ticked save bases it on the kept English revision', () => {
    const next = withEnglish(saved, 'English one, fixed');
    next.text.fr = { ...saved.text.fr!, text: 'Francais neuf' };
    const stamped = stampRevisions(saved, next, 'editor', iso(NOW), true);
    expect(stamped.text.fr?.sourceUpdatedAt).toBe(iso(T0));
    expect(translationStateOf(stamped, 'fr').state).toBe('current');
  });
  it('a client clock behind the stored English revision still stamps a newer one', () => {
    const stamped = stampRevisions(saved, withEnglish(saved, 'x'), 'e', iso(T0 - DAY));
    expect(stamped.text.en?.updatedAt).toBe(iso(T0 + 1));
  });

  it('property: ticked saves never move a state; unticked saves equal the pre-TR3 enricher', () => {
    let seed = 0x7e3;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)];
    const others = ['de', 'fr', 'ja'] as const satisfies readonly Lang[];
    for (let run = 0; run < 300; run++) {
      let clock = T0;
      let current: Tooltip = {
        hash: 1000 + run,
        text: { en: { text: 'e0', updatedAt: iso(clock), updatedBy: 'a' } },
        associated: [],
      };
      let skipped: Tooltip = current; // the same history with every ticked English change left out
      for (let step = 0; step < 12; step++) {
        // Steps around the boundary: hours to a little over 90 days.
        clock += pick([1000, DAY, 30 * DAY, LIMIT, LIMIT + 1, LIMIT - 1, 45 * DAY]);
        const now = iso(clock);
        const kind = pick(['en', 'en-ticked', 'translation'] as const);
        if (kind === 'translation') {
          const lang = pick(others);
          const edit = (tooltip: Tooltip): Tooltip => ({
            ...tooltip,
            text: {
              ...tooltip.text,
              [lang]: { text: `${lang}${step}`, updatedAt: now, updatedBy: 't' },
            },
          });
          current = stampRevisions(current, edit(current), 't', now);
          skipped = stampRevisions(skipped, edit(skipped), 't', now);
        } else if (kind === 'en') {
          const next = withEnglish(current, `e${step}`);
          const stamped = stampRevisions(current, next, 'e', now);
          expect(stamped).toEqual(stampBeforeTr3(current, next, 'e', now));
          current = stamped;
          skipped = stampRevisions(skipped, withEnglish(skipped, `e${step}`), 'e', now);
        } else if (!noImpactApplies(current, withEnglish(current, `e${step}!`))) {
          // No translation yet: the tick does not apply and the save stamps as usual.
          const next = withEnglish(current, `e${step}!`);
          expect(stampRevisions(current, next, 'e', now, true)).toEqual(
            stampBeforeTr3(current, next, 'e', now),
          );
          current = stampRevisions(current, next, 'e', now, true);
          skipped = stampRevisions(skipped, withEnglish(skipped, `e${step}!`), 'e', now);
        } else {
          const stamped = stampRevisions(
            current,
            withEnglish(current, `e${step}!`),
            'e',
            now,
            true,
          );
          expect(states(stamped)).toEqual(states(current));
          expect(stamped.text.en?.updatedAt).toBe(current.text.en?.updatedAt);
          current = stamped;
        }
        // Same outdated and fallback state as the history without ticked changes: no hidden
        // accumulation, whatever the order.
        expect(states(current)).toEqual(states(skipped));
      }
    }
  });
});

describe('EXPORT-FALLBACK-VALIDATION: the live English fallback is validated', () => {
  const newline = String.fromCharCode(10);
  const lines = (...parts: string[]) => parts.join(newline);
  const hidden = (name: string, body: string) => lines(`export hidden ${name} (`, body, ')');
  const entry = (text: string, at = T0) => ({ text, updatedAt: iso(at), updatedBy: 'a' });
  /**
   * 124 imports foo from 125 in English; 125 exports foo only in English, so the English text
   * fails in German. 124's German translation is `old` days of English revisions behind. 126's
   * German imports bar, which 124 exports in German but not in English.
   */
  function fixture(old: number) {
    const data = editorData();
    const t124: Tooltip = {
      hash: 124,
      text: {
        en: entry('import foo from 125'),
        de: translation(hidden('bar', 'Bar'), T0 - old),
      },
      associated: [],
    };
    const t125: Tooltip = {
      hash: 125,
      text: { en: entry(hidden('foo', 'Foo')), de: translation('Kein Export', T0) },
      associated: [],
    };
    const t126: Tooltip = {
      hash: 126,
      text: { en: entry('English 126'), de: translation('import bar from 124', T0) },
      associated: [],
    };
    Object.assign(data.bundle.tooltips, { 124: t124, 125: t125, 126: t126 });
    const edit = (text: string): Change => ({
      hash: 124,
      base: t124,
      next: { ...t124, text: { ...t124.text, en: { ...t124.text.en!, text } } },
    });
    return { data, edit };
  }
  const english2 = lines('import foo from 125', 'More text.');
  const errors = (issues: ReturnType<typeof validateChanges>) =>
    issues.filter((issue) => issue.severity === 'error');

  it('predicts flips at the boundary (exactly 90 days kept, over 90 flips), not when ticked', () => {
    const { edit } = fixture(LIMIT - (NOW - T0));
    const change = edit(english2);
    expect(liveFallback([change], iso(NOW), false)).toEqual({});
    expect(liveFallback([change], iso(NOW + 1), false)).toEqual({ 124: ['de'] });
    expect(liveFallback([change], iso(NOW + 1), true)).toEqual({});
  });
  it('lists an already falling-back language for every save that keeps its stamps', () => {
    const { edit, data } = fixture(91 * DAY);
    expect(liveFallback([edit(english2)], iso(NOW), false)).toEqual({ 124: ['de'] });
    const t124 = data.bundle.tooltips[124]!;
    expect(
      liveFallback(
        [{ hash: 124, base: t124, next: { ...t124, associated: [5] } }],
        iso(NOW),
        false,
      ),
    ).toEqual({ 124: ['de'] });
  });
  it('a translation edited in the same save is stamped current: no flip', () => {
    const { edit } = fixture(LIMIT);
    const change = edit(english2);
    change.next.text.de = { ...change.next.text.de!, text: 'Neu' };
    expect(liveFallback([change], iso(NOW), false)).toEqual({});
  });
  it('blocks a save whose flip breaks the English text in German, and its German dependent', () => {
    const { data, edit } = fixture(LIMIT);
    const change = edit(english2);
    const fallback = liveFallback([change], iso(NOW), false);
    expect(fallback).toEqual({ 124: ['de'] });
    // Without the fallback view (the old raw-language model) the save looked clean.
    expect(errors(validateChanges([change], data))).toEqual([]);
    const issues = errors(validateChanges([change], data, fallback));
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hash: 124,
          lang: 'de',
          message: expect.stringContaining(
            'After this save, live German output uses the English text',
          ),
        }),
        expect.objectContaining({
          hash: 126,
          lang: 'de',
          message: expect.stringContaining(
            'uses "Tooltip 124" (124) (live German output falls back to its English text), which this save changes',
          ),
        }),
      ]),
    );
    expect(issues.every((issue) => issue.lang === 'de')).toBe(true);
  });
  it('prepareChanges uses one revision time for the prediction and the stamps', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(NOW);
    const { data, edit } = fixture(LIMIT);
    const change = edit(english2);
    await expect(prepareChanges([change], editor, data)).rejects.toThrow(
      'This save would break dependent tooltip(s): 126.',
    );
    // Ticked: nothing flips, the save is valid, and English keeps its revision.
    const [prepared] = await prepareChanges([change], editor, data, undefined, {
      noTranslationImpact: true,
    });
    expect(prepared!.next.text.en).toEqual({ ...change.base!.text.en, text: english2 });
    expect(usesEnglishFallback(prepared!.next, 'de')).toBe(false);
    // Under the limit the unticked save is valid too, and stamps the validated `now`.
    const fresh = fixture(LIMIT - 2 * (NOW - T0));
    const [unticked] = await prepareChanges([fresh.edit(english2)], editor, fresh.data);
    expect(unticked!.next.text.en?.updatedAt).toBe(iso(NOW));
    expect(usesEnglishFallback(unticked!.next, 'de')).toBe(false);
  });
  it('refuses the tick for trials and translators before any request', async () => {
    const { data, edit } = fixture(DAY);
    for (const role of ['trial', 'translator'] as const)
      await expect(
        prepareChanges([edit(english2)], { ...editor, role, languages: ['de'] }, data, undefined, {
          noTranslationImpact: true,
        }),
      ).rejects.toThrow(/editors and maintainers|cannot edit/);
  });
  /**
   * 124's German flips; it imports foo from 125, whose German already falls back, so live German
   * resolves 125's English, which imports bar from 126 in German: 126 has no German bar.
   */
  function nested() {
    const data = editorData();
    const t124: Tooltip = {
      hash: 124,
      text: { en: entry('import foo from 125'), de: translation('Deutsch bisher', T0 - LIMIT) },
      associated: [],
    };
    const t125: Tooltip = {
      hash: 125,
      text: {
        en: entry(hidden('foo', 'import bar from 126')),
        de: translation(hidden('foo', 'Deutsch sicher <solar/>Scorch'), T0 - 91 * DAY),
      },
      associated: [],
    };
    const t126: Tooltip = {
      hash: 126,
      text: { en: entry(hidden('bar', 'Bar')), de: translation('Kein Export', T0) },
      associated: [],
    };
    Object.assign(data.bundle.tooltips, { 124: t124, 125: t125, 126: t126 });
    const change: Change = {
      hash: 124,
      base: t124,
      next: { ...t124, text: { ...t124.text, en: { ...t124.text.en!, text: english2 } } },
    };
    return { data, change, t125 };
  }
  const unresolvedBar = (from: number) =>
    expect.stringContaining(`Unresolved import "bar" from ${from}`);
  it('resolves imports through unchanged tooltips that already fall back (code review F1)', () => {
    const { data, change } = nested();
    const fallback = liveFallback([change], iso(T0 + DAY), false);
    expect(fallback).toEqual({ 124: ['de'] });
    expect(errors(validateChanges([change], data, fallback))).toEqual([
      expect.objectContaining({
        hash: 124,
        lang: 'de',
        message: expect.stringMatching(/Unresolved import "bar" from 126.*live German output/),
      }),
    ]);
  });
  it('a markup-only translation edit in the same save keeps the import target live (F1a)', () => {
    const { data, change, t125 } = nested();
    const markup = hidden('foo', 'Deutsch sicher <solar Scorch />');
    expect(isMarkupOnly(t125.text.de!.text, markup)).toBe(true);
    const target: Change = {
      hash: 125,
      base: t125,
      next: { ...t125, text: { ...t125.text, de: { ...t125.text.de!, text: markup } } },
    };
    const fallback = liveFallback([change, target], iso(T0 + DAY), false);
    expect(fallback).toEqual({ 124: ['de'], 125: ['de'] });
    expect(errors(validateChanges([change, target], data, fallback))).toEqual([
      expect.objectContaining({ hash: 124, lang: 'de', message: unresolvedBar(126) }),
    ]);
  });
  /**
   * 131's German falls back, so live German runs its English, which imports bar from 130 in
   * German. Rewriting 130's German drops bar: the dependent breaks in live output.
   */
  function dependent() {
    const data = editorData();
    const t130: Tooltip = {
      hash: 130,
      text: { en: entry('English 130'), de: translation(hidden('bar', 'Bar'), T0) },
      associated: [],
    };
    const t131: Tooltip = {
      hash: 131,
      text: {
        en: entry('import bar from 130'),
        de: translation('Kein Import', T0 - 91 * DAY),
      },
      associated: [],
    };
    Object.assign(data.bundle.tooltips, { 130: t130, 131: t131 });
    const change: Change = {
      hash: 130,
      base: t130,
      next: { ...t130, text: { ...t130.text, de: { ...t130.text.de!, text: 'Neu' } } },
    };
    return { data, change, t131 };
  }
  it('validates an unchanged dependent by its live text when its translation falls back', () => {
    const { data, change } = dependent();
    expect(liveFallback([change], iso(NOW), false)).toEqual({});
    expect(errors(validateChanges([change], data))).toEqual([
      expect.objectContaining({ hash: 131, lang: 'de', message: unresolvedBar(130) }),
    ]);
  });
  it('a falling-back dependent in the save for a metadata edit is still checked live (F1b)', () => {
    const { data, change, t131 } = dependent();
    const metadata: Change = { hash: 131, base: t131, next: { ...t131, associated: [130] } };
    const fallback = liveFallback([change, metadata], iso(NOW), false);
    expect(fallback).toEqual({ 131: ['de'] });
    expect(errors(validateChanges([change, metadata], data, fallback))).toEqual([
      expect.objectContaining({ hash: 131, lang: 'de', message: unresolvedBar(130) }),
    ]);
  });
  it('an unchanged fallback (no English change) keeps warning-only behaviour', () => {
    // 124's live German (its English) fails in German, but reads nothing this save changes.
    const { data } = fixture(91 * DAY);
    const t124 = data.bundle.tooltips[124]!;
    const change = { hash: 124, base: t124, next: { ...t124, associated: [5] } };
    const fallback = liveFallback([change], iso(NOW), false);
    expect(fallback).toEqual({ 124: ['de'] });
    const issues = validateChanges([change], data, fallback);
    expect(errors(issues)).toEqual([]);
    expect(issues).toContainEqual(
      expect.objectContaining({ hash: 124, lang: 'de', severity: 'warning' }),
    );
  });
  it('a markup-only edit of a translation that still falls back is checked as edited text', () => {
    const { data } = fixture(91 * DAY);
    const t124 = data.bundle.tooltips[124]!;
    const rawBefore = lines('import nope from 125', 'Mehr <solar/>Scorch');
    const rawAfter = lines('import nope from 125', 'Mehr <solar Scorch />');
    const base = { ...t124, text: { ...t124.text, de: { ...t124.text.de!, text: rawBefore } } };
    data.bundle.tooltips[124] = base;
    const change: Change = {
      hash: 124,
      base,
      next: { ...base, text: { ...base.text, de: { ...base.text.de!, text: rawAfter } } },
    };
    expect(isMarkupOnly(rawBefore, rawAfter)).toBe(true);
    const fallback = liveFallback([change], iso(NOW), false);
    expect(fallback).toEqual({ 124: ['de'] });
    expect(errors(validateChanges([change], data, fallback))).toContainEqual(
      expect.objectContaining({
        hash: 124,
        lang: 'de',
        message: expect.stringContaining('Unresolved import "nope" from 125'),
      }),
    );
  });
});

describe('stampEnglish (batch rebase): the Worker revision rule, translations untouched', () => {
  const current = saved;
  const upcoming = (text: string, at: number) => ({
    ...saved,
    text: { ...saved.text, en: { text, updatedAt: iso(at), updatedBy: 'proposer' } },
  });
  it('keeps a newer upcoming revision, restamps an older one, and aligns unchanged text', () => {
    const newer = upcoming('Upcoming', T0 + DAY);
    expect(stampEnglish(current, newer, 'e', iso(NOW))).toBe(newer);
    const older = stampEnglish(current, upcoming('Upcoming', T0 - DAY), 'e', iso(NOW));
    expect(older.text.en).toEqual({ text: 'Upcoming', updatedAt: iso(NOW), updatedBy: 'e' });
    expect(older.text.de).toBe(saved.text.de);
    const behind = stampEnglish(current, upcoming('Upcoming', T0 - DAY), 'e', iso(T0 - 2 * DAY));
    expect(behind.text.en?.updatedAt).toBe(iso(T0 + 1));
    const same = stampEnglish(current, upcoming('English one', T0 + DAY), 'e', iso(NOW));
    expect(same.text.en).toEqual(saved.text.en);
  });
});
