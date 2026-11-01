import type { Lang } from '@clarity/core';
import type { User } from '../../services/api';
import { canEditLanguage } from '../auth/permissions';
import { firstAssignedLanguage } from './language';

export interface EditorAccess {
  /** Why the editor is read-only; `null` when it is editable. */
  reason: string | null;
  /** Translator-only shortcut to the first assigned language, set only for the language reason. */
  switchTo?: Lang;
}

export interface EditorAccessInput {
  apiConfigured: boolean;
  hydrated: boolean;
  saving: boolean;
  user: User | null | undefined;
  lang: Lang;
}

export function editorAccess({
  apiConfigured,
  hydrated,
  saving,
  user,
  lang,
}: EditorAccessInput): EditorAccess {
  if (!apiConfigured) return { reason: 'Read-only: this build is not connected to the save API.' };
  if (!hydrated) return { reason: 'Read-only: loading your local drafts.' };
  if (saving) return { reason: 'Read-only: finish or cancel the open save review first.' };
  if (!user) return { reason: 'Read-only: sign in to edit.' };
  if (canEditLanguage(user, lang)) return { reason: null };
  if (user.role === 'translator') {
    const assigned = user.languages ?? [];
    if (!assigned.length) {
      return { reason: 'Read-only: no languages are assigned to your translator account.' };
    }
    return {
      reason: `Read-only: you can translate ${assigned.join(', ')}, not ${lang}.`,
      switchTo: firstAssignedLanguage(user),
    };
  }
  return { reason: 'Read-only: your account has no editing role.' };
}
