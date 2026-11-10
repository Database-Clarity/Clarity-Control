import { languages, langSchema, type Lang, type TranslationQueueEntry } from '@clarity/core';
import type { User } from '../../services/api';
import { parseStateFilter, type QueueFilters } from './queue';

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

/** One view of the Translations tab: a language and its filters. */
export interface QueueContext extends QueueFilters {
  language: Lang;
}

/**
 * Queue mode travels in the history entry's state, next to an unchanged tooltip URL: the filters of
 * the Translations view the tooltip was opened from (the language is the URL's own `lang`). The
 * browser keeps it across reload, Back, and Forward; a copied link, the finder, or another
 * language opens the tooltip as an ordinary visit, without it.
 */
export function queueState(filters: QueueFilters): { queue: QueueFilters } {
  return { queue: { state: filters.state, category: filters.category, query: filters.query } };
}

/** The queue a tooltip route was opened from, or null on an ordinary editor visit. */
export function queueContext(
  search: URLSearchParams,
  state: unknown,
  user: User | null | undefined,
): QueueContext | null {
  const queue = (state as { queue?: Partial<Record<keyof QueueFilters, unknown>> } | null)?.queue;
  if (!queue || typeof queue !== 'object') return null;
  const requested = langSchema.safeParse(search.get('lang')).data;
  const language = availableLanguages(user).find((lang) => lang === requested);
  if (!language) return null;
  return {
    language,
    state: parseStateFilter(typeof queue.state === 'string' ? queue.state : null),
    category: typeof queue.category === 'string' && queue.category ? queue.category : null,
    query: typeof queue.query === 'string' ? queue.query : '',
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
