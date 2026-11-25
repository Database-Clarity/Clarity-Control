import {
  hasConflictMarkers,
  isTranslatable,
  languages,
  merge3,
  translationStateOf,
  type Lang,
  type Tooltip,
} from '@clarity/core';
import { stampRevisions } from '../../services/save/enrichers/metadata';
import { expectedSubmission } from '../../services/save/recovery';
import type { EditorData } from '../../stores/data';
import { translatableEntry } from './queue';
import type { TranslationRevisions } from '../../../../../packages/core/src/translationRevision';

/** A draft's two sides. */
interface Edit {
  base: Tooltip;
  next: Tooltip;
  translationRevisions?: TranslationRevisions;
}

export type Update = ReturnType<typeof translationStateOf> & {
  /** The English the state was judged against (the draft's, when it edits both). */
  english: string;
};

/**
 * The tooltip as saving the open draft would leave it, for judging `lang`: the save's own stamping
 * (`stampRevisions`), merged onto a newer save as the Worker would, with the number map it derives.
 * The saved tooltip stands while the draft leaves this language alone (an unsaved English edit is
 * not behind anything yet) and while the draft cannot be saved over it (a conflict).
 */
export function pendingTooltip(
  saved: Tooltip,
  draft: Edit | undefined,
  lang: Lang,
  now = new Date().toISOString(),
): Tooltip {
  const typed = draft?.next.text[lang]?.text;
  const revision = lang === 'en' ? undefined : draft?.translationRevisions?.[lang];
  if (
    !draft?.next.text.en ||
    (!revision && typed === draft.base.text[lang]?.text) ||
    hasConflictMarkers(typed ?? '')
  )
    return saved;
  const stamped = stampRevisions(
    draft.base,
    draft.next,
    '',
    now,
    false,
    draft.translationRevisions,
  );
  const revised = revision
    ? languages.filter((other) => other !== 'en' && draft.translationRevisions?.[other])
    : [];
  if (draft.base === saved) return expectedSubmission(saved, stamped, revised);
  const merged = merge3(draft.base, saved, stamped);
  return merged.ok ? expectedSubmission(saved, merged.merged, revised) : saved;
}

/**
 * What the editor's banner says needs updating, or null: the Translations tab's rule on the pending
 * tooltip, for the entries the tab can list, so the two never disagree about a saved translation.
 */
export function needsUpdate(
  saved: Tooltip,
  draft: Edit | undefined,
  lang: Lang,
  data: EditorData,
): Update | null {
  if (lang === 'en' || !isTranslatable(saved, data.aliases)) return null;
  const pending = pendingTooltip(saved, draft, lang);
  const state = translationStateOf(pending, lang);
  return state.state === 'outdated' && translatableEntry(saved, data)
    ? { ...state, english: pending.text.en!.text }
    : null;
}
