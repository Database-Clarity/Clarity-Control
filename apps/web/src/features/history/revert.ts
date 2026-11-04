import { languages, type Tooltip } from '@clarity/core';
import type { User } from '../../services/api';

export function revertDraft(current: Tooltip, version: Tooltip, user: User): Tooltip {
  if (current.hash !== version.hash) throw new Error('Cannot restore a different tooltip');
  if (!user.role) throw new Error('You do not have permission to restore history');
  if (user.role !== 'translator') return structuredClone(version);
  const next = structuredClone(current);
  for (const language of user.languages ?? []) {
    const text = version.text[language];
    if (text) next.text[language] = structuredClone(text);
    else delete next.text[language];
  }
  return next;
}

/** A legacy projection must never replace associations, identity, archives, or metadata. */
export function restoreLegacyText(
  current: Tooltip,
  version: Tooltip,
  user: User,
  verified: boolean,
): Tooltip {
  if (!verified) throw new Error('Legacy identity is not verified');
  if (current.hash !== version.hash) throw new Error('Cannot restore a different tooltip');
  if (!user.role) throw new Error('You do not have permission to restore history');
  const next = structuredClone(current);
  for (const language of user.role === 'translator' ? (user.languages ?? []) : languages) {
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
