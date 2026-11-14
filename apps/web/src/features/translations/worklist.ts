import { languages, type Lang, type TranslationQueueEntry } from '@clarity/core';
import type { User } from '../../services/api';
import type { QueueFilters } from './queue';

/** Translators work only in their assigned languages; everyone else sees all of them. */
export function availableLanguages(user: User | null | undefined): Lang[] {
  return languages.filter(
    (lang) => lang !== 'en' && (user?.role !== 'translator' || user.languages?.includes(lang)),
  );
}

/**
 * The editor in translate mode for one tooltip and language. An enhanced version that keeps text
 * of its own is edited on its base's page: pass that page's hash as `canonical` and the link opens
 * the override there (`variant`), instead of redirecting to the base's text.
 */
export function entryPath(
  entry: Pick<TranslationQueueEntry, 'language'> & { hash: number },
  canonical = entry.hash,
): string {
  const variant = canonical === entry.hash ? '' : `&variant=${entry.hash}`;
  return `/t/${canonical}?lang=${entry.language}${variant}`;
}

/** One view of the Translations tab: a language and its filters. */
export interface QueueContext extends QueueFilters {
  language: Lang;
}

/** The Translations tab showing `context` again (its default language is never written). */
export function queuePath(context: QueueContext, user: User | null | undefined): string {
  const params = new URLSearchParams();
  if (context.language !== availableLanguages(user)[0]) params.set('lang', context.language);
  if (context.category) params.set('cat', context.category);
  if (context.query) params.set('q', context.query);
  if (context.state) params.set('state', context.state);
  if (context.sort === 'small') params.set('sort', 'small');
  const query = params.toString();
  return `/translations${query ? `?${query}` : ''}`;
}

/** The queue a visit came from, in words: "German, all categories" (the phone's More sheet). */
export function queueSummary(
  context: Pick<QueueContext, 'language' | 'category'>,
  languageName: (language: Lang) => string,
  categoryName: (id: string) => string,
): string {
  return `${languageName(context.language)}, ${context.category ? categoryName(context.category) : 'all categories'}`;
}
