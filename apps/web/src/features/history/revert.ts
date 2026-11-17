import { type Lang, type LangText, type Tooltip } from '@clarity/core';
import { englishScope, type HistoryScope } from './scope';
import type { User } from '../../services/api';

/**
 * A language entry as restored from `version`. With `fillSource` (a restore the user will save,
 * never a rebased draft base), a translation without its own source names that revision's
 * English, so restoring old text never becomes current against newer English; the save keeps
 * that older source and stamps the entry as revised now (root 2026-11-16).
 */
function restoredText(version: Tooltip, language: Lang, fillSource: boolean): LangText | undefined {
  const text = version.text[language];
  if (!text) return undefined;
  const source = text.sourceUpdatedAt ?? version.text.en?.updatedAt;
  return fillSource && language !== 'en' && source
    ? { ...structuredClone(text), sourceUpdatedAt: source }
    : structuredClone(text);
}

export function revertDraft(
  current: Tooltip,
  version: Tooltip,
  user: User,
  scope?: HistoryScope,
  fillSource = false,
): Tooltip {
  if (current.hash !== version.hash) throw new Error('Cannot restore a different tooltip');
  if (!user.role) throw new Error('You do not have permission to restore history');
  // Recovery and Review load whole versions; History always supplies its view scope.
  if (!scope) {
    if (user.role !== 'translator') return structuredClone(version);
    const next = structuredClone(current);
    for (const language of user.languages ?? []) {
      const text = restoredText(version, language, fillSource);
      if (text) next.text[language] = text;
      else delete next.text[language];
    }
    return next;
  }
  const next = structuredClone(current);
  for (const language of scope.languages) {
    if (user.role === 'translator' && (language === 'en' || !user.languages?.includes(language)))
      continue;
    const text = restoredText(version, language, fillSource);
    if (text) next.text[language] = text;
    else delete next.text[language];
  }
  if (user.role !== 'translator') {
    for (const field of scope.fields) {
      if (version[field] === undefined) delete next[field];
      else Object.assign(next, { [field]: structuredClone(version[field]) });
    }
  }
  return next;
}

/** A legacy projection must never replace associations, identity, archives, or metadata. */
export function restoreLegacyText(
  current: Tooltip,
  version: Tooltip,
  user: User,
  verified: boolean,
  scope: HistoryScope = englishScope,
): Tooltip {
  if (!verified) throw new Error('Legacy identity is not verified');
  if (current.hash !== version.hash) throw new Error('Cannot restore a different tooltip');
  if (!user.role) throw new Error('You do not have permission to restore history');
  const next = structuredClone(current);
  for (const language of scope.languages) {
    if (language !== 'en' || user.role === 'translator') continue;
    const text = version.text[language];
    if (text)
      next.text[language] = {
        ...next.text[language],
        text: text.text,
        updatedAt: text.updatedAt,
        updatedBy: text.updatedBy,
      };
    else delete next.text[language];
  }
  return next;
}
