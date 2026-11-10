import { languages, langSchema, type Lang, type TranslationQueueEntry } from '@clarity/core';
import type { User } from '../../services/api';
import { parseStateFilter, type QueueFilters } from './queue';

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
  /** The row the entry was opened for, when the page shows it under another (base) hash. */
  at?: number;
}

/**
 * Queue mode travels in the history entry's state, next to an unchanged tooltip URL: the filters of
 * the Translations view the tooltip was opened from (the language is the URL's own `lang`). The
 * browser keeps it across reload, Back, and Forward; a copied link, the finder, or another
 * language opens the tooltip as an ordinary visit, without it.
 */
export function queueState(
  filters: QueueFilters,
  at?: number,
): { queue: QueueFilters & { at?: number } } {
  return { queue: { state: filters.state, category: filters.category, query: filters.query, at } };
}

/** The queue a tooltip route was opened from, or null on an ordinary editor visit. */
export function queueContext(
  search: URLSearchParams,
  state: unknown,
  user: User | null | undefined,
): QueueContext | null {
  const queue = (state as { queue?: Partial<Record<keyof QueueFilters | 'at', unknown>> } | null)
    ?.queue;
  if (!queue || typeof queue !== 'object') return null;
  const requested = langSchema.safeParse(search.get('lang')).data;
  const language = availableLanguages(user).find((lang) => lang === requested);
  if (!language) return null;
  return {
    language,
    state: parseStateFilter(typeof queue.state === 'string' ? queue.state : null),
    category: typeof queue.category === 'string' && queue.category ? queue.category : null,
    query: typeof queue.query === 'string' ? queue.query : '',
    at: typeof queue.at === 'number' ? queue.at : undefined,
  };
}

/** The Translations tab showing `context` again (its default language is never written). */
export function queuePath(context: QueueContext, user: User | null | undefined): string {
  const params = new URLSearchParams();
  if (context.language !== availableLanguages(user)[0]) params.set('lang', context.language);
  if (context.category) params.set('cat', context.category);
  if (context.query) params.set('q', context.query);
  if (context.state) params.set('state', context.state);
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
