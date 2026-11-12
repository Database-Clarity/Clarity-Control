import { isMarkupOnly, languages, type Tooltip } from '@clarity/core';
import type { SaveEnricher } from './index';

/**
 * One content-revision policy for every consumer of the timestamps: `updatedAt`/`updatedBy` move
 * only when the lowered text changed. A tagging-only edit keeps the previous revision (and a
 * translation its `sourceUpdatedAt`), so the translation queue and status, the 90-day English
 * fallback, and the exported `lastUpdate` stay neutral to tagging. Who made such an edit is
 * recorded by the save itself: the commit author and its `Clarity-Changed` trailer (History).
 */
export const metadata: SaveEnricher = async ({ before, next, user }) => {
  const text: Tooltip['text'] = { ...next.text };
  const now = new Date().toISOString();
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
    text[lang] = {
      ...entry,
      updatedAt: now,
      updatedBy: user.login,
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
};
