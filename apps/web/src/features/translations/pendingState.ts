import { isTranslatable, merge3, translationStateOf, type Lang, type Tooltip } from '@clarity/core';
import { stampRevisions } from '../../services/save/enrichers/metadata';
import type { EditorData } from '../../stores/data';
import { translatableEntry } from './queue';

type State = ReturnType<typeof translationStateOf>;

/**
 * The state `lang` would have once the open draft is saved, by the two rules that decide it: the
 * save's own stamping (`stampRevisions`) on the draft, then the Translations tab's
 * `translationStateOf`. A draft that leaves this language's text alone shows the saved state: an
 * unsaved English edit is not behind anything yet. A draft started before a newer save merges
 * onto it the way the Worker will; while they conflict, the saved state stands.
 */
export function pendingTranslationState(
  saved: Tooltip,
  draft: { base: Tooltip; next: Tooltip } | undefined,
  lang: Lang,
  now = new Date().toISOString(),
): State {
  const typed = draft?.next.text[lang];
  if (!draft?.next.text.en || !typed || typed.text === draft.base.text[lang]?.text)
    return translationStateOf(saved, lang);
  const stamped = stampRevisions(draft.base, draft.next, '', now);
  const moved = (['en', lang] as const).some(
    (language) => draft.base.text[language]?.updatedAt !== saved.text[language]?.updatedAt,
  );
  if (!moved) return translationStateOf(stamped, lang);
  const merged = merge3(draft.base, saved, stamped);
  return translationStateOf(merged.ok ? merged.merged : saved, lang);
}

/**
 * What the editor's banner says needs updating, or null. Only entries the Translations tab can
 * list, so the two never disagree about a saved translation.
 */
export function needsUpdate(
  saved: Tooltip,
  draft: { base: Tooltip; next: Tooltip } | undefined,
  lang: Lang,
  data: EditorData,
): State | null {
  if (lang === 'en' || !isTranslatable(saved, data.aliases)) return null;
  const state = pendingTranslationState(saved, draft, lang);
  return state.state === 'outdated' && translatableEntry(saved, data) ? state : null;
}
