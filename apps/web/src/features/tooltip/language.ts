import { langSchema, type Lang } from '@clarity/core';
import type { User } from '../../services/api';

export function firstAssignedLanguage(user: User | null | undefined): Lang | undefined {
  return user?.role === 'translator' ? user.languages?.[0] : undefined;
}

/** URL `?lang=` → remembered choice → first assigned language (translators) → English. */
export function defaultLanguage(
  user: User | null | undefined,
  search: URLSearchParams,
  stored: Lang | undefined,
): Lang {
  return (
    langSchema.safeParse(search.get('lang')).data ?? stored ?? firstAssignedLanguage(user) ?? 'en'
  );
}

/** Copy of the query string with only `lang` replaced, so `variant` and `line` survive. */
export function withLanguage(search: URLSearchParams, lang: Lang): URLSearchParams {
  const next = new URLSearchParams(search);
  next.set('lang', lang);
  return next;
}
