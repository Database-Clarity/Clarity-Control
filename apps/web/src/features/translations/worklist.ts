import { languages, type Lang, type TranslationQueueEntry } from '@clarity/core';
import type { User } from '../../services/api';

/** Translators work only in their assigned languages; everyone else sees all of them. */
export function availableLanguages(user: User | null | undefined): Lang[] {
  return languages.filter(
    (lang) => lang !== 'en' && (user?.role !== 'translator' || user.languages?.includes(lang)),
  );
}

/** The editor in translate mode for one tooltip and language. */
export function entryPath(
  entry: Pick<TranslationQueueEntry, 'language'> & { hash: number },
): string {
  return `/t/${entry.hash}?lang=${entry.language}`;
}
