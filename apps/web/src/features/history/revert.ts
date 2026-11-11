import { type Tooltip } from '@clarity/core';
import { englishScope, type HistoryScope } from './scope';
import type { User } from '../../services/api';

export function revertDraft(
  current: Tooltip,
  version: Tooltip,
  user: User,
  scope: HistoryScope = englishScope,
): Tooltip {
  if (current.hash !== version.hash) throw new Error('Cannot restore a different tooltip');
  if (!user.role) throw new Error('You do not have permission to restore history');
  const next = structuredClone(current);
  for (const language of scope.languages) {
    if (user.role === 'translator' && (language === 'en' || !user.languages?.includes(language)))
      continue;
    const text = version.text[language];
    if (text) next.text[language] = structuredClone(text);
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
