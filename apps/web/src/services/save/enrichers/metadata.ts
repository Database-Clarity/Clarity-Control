import { isMarkupOnly, languages, type Tooltip } from '@clarity/core';
import type { SaveEnricher } from './index';

/** Whether a tooltip has any saved or drafted translation the English revision is compared with. */
function hasTranslation(tooltip: Tooltip): boolean {
  return languages.some((lang) => lang !== 'en' && tooltip.text[lang] !== undefined);
}

/**
 * Whether "No translation impact" applies to this tooltip in this save: its English text changes
 * beyond markup, it already had English, and it has a translation to keep current. Elsewhere the
 * tick has nothing to protect, so the save stamps a new English revision as usual.
 */
export function noImpactApplies(before: Tooltip | undefined, next: Tooltip): boolean {
  const previous = before?.text.en;
  const english = next.text.en;
  return Boolean(
    previous &&
    english &&
    english.text !== previous.text &&
    // Cheapest first: the review evaluates this for every change on the main thread.
    hasTranslation(next) &&
    !isMarkupOnly(previous.text, english.text),
  );
}

/**
 * One content-revision policy for every consumer of the timestamps: `updatedAt`/`updatedBy` move
 * only when the lowered text changed. A tagging-only edit keeps the previous revision (and a
 * translation its `sourceUpdatedAt`), so the translation queue and status, the 90-day English
 * fallback, and the exported `lastUpdate` stay neutral to tagging. Who made such an edit is
 * recorded by the save itself: the commit author and its `Clarity-Changed` trailer (History).
 *
 * "No translation impact" (TR3, editors and maintainers; the Worker enforces the role) treats an
 * English wording change the same way: English keeps its previous revision (`updatedAt` and
 * `updatedBy`), so every translation keeps its outdated and fallback state exactly, and the change
 * adds nothing to the 90-day gap. The Worker records it in the commit's
 * `Clarity-No-Translation-Impact` trailer (History).
 *
 * A new English revision is never older than the one it replaces (the Worker refuses that, since
 * a backdated revision would also keep translations current): a client clock behind the previous
 * stamp takes the previous stamp plus 1 ms instead.
 */
export function stampRevisions(
  before: Tooltip | undefined,
  next: Tooltip,
  login: string,
  now: string,
  noTranslationImpact = false,
): Tooltip {
  const text: Tooltip['text'] = { ...next.text };
  const keepEnglish = noTranslationImpact && noImpactApplies(before, next);
  for (const lang of languages) {
    const entry = text[lang];
    if (!entry) continue;
    const previous = before?.text[lang];
    if (entry.text === previous?.text) {
      text[lang] = previous;
      continue;
    }
    if (previous && (isMarkupOnly(previous.text, entry.text) || (lang === 'en' && keepEnglish))) {
      text[lang] = { ...previous, text: entry.text };
      continue;
    }
    const kept = lang === 'en' && previous ? Date.parse(previous.updatedAt) : NaN;
    text[lang] = {
      ...entry,
      updatedAt: kept >= Date.parse(now) ? new Date(kept + 1).toISOString() : now,
      updatedBy: login,
    };
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

/**
 * `next` with its English aligned to `current` by the Worker's English revision rule, for writes
 * that compose English from elsewhere (a batch rebase choosing the upcoming English): the same or
 * markup-only text keeps current's revision; other text keeps its own revision when that is newer
 * than current's, else gets a new one (now, or current's plus 1 ms). Translations are untouched.
 */
export function stampEnglish(
  current: Tooltip | null,
  next: Tooltip,
  login: string,
  now: string,
): Tooltip {
  const english = next.text.en;
  const previous = current?.text.en;
  if (!english || !previous) return next;
  let en = english;
  if (english.text === previous.text || isMarkupOnly(previous.text, english.text))
    en = { ...previous, text: english.text };
  else if (!(Date.parse(english.updatedAt) > Date.parse(previous.updatedAt))) {
    const kept = Date.parse(previous.updatedAt);
    en = {
      ...english,
      updatedAt: kept >= Date.parse(now) ? new Date(kept + 1).toISOString() : now,
      updatedBy: login,
    };
  }
  return en === english ? next : { ...next, text: { ...next.text, en } };
}

export const metadata: SaveEnricher = async ({ before, next, user, now, noTranslationImpact }) =>
  stampRevisions(before, next, user.login, now ?? new Date().toISOString(), noTranslationImpact);
