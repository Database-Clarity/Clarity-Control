import type { Lang, TranslationLanguage } from '@clarity/core';
import type { User } from '../../services/api';
import { publisherEnabled } from '../../services/publisher/flag';

export function canEditTooltipFields(user: User | null | undefined): boolean {
  return user?.role === 'maintainer' || user?.role === 'editor' || user?.role === 'trial';
}

export function canEditLanguage(user: User | null | undefined, lang: Lang): boolean {
  return (
    canEditTooltipFields(user) ||
    (user?.role === 'translator' && user.languages?.includes(lang) === true)
  );
}

/** Translation manager of `lang`: manages its translators and rolls back its uploads. */
export function managesLanguage(user: User | null | undefined, lang: Lang): boolean {
  return user?.role === 'translator' && lang !== 'en' && user.manages?.includes(lang) === true;
}

/** Upload rollback (owner 2026-11-16): managers in their languages, maintainers in any but English. */
export function canRollBackUpload(user: User | null | undefined, lang: Lang): boolean {
  return lang !== 'en' && (user?.role === 'maintainer' || managesLanguage(user, lang));
}

type Publisher = Pick<User, 'role'> & Partial<Pick<User, 'languages' | 'translationPublish'>>;
const none: readonly TranslationLanguage[] = [];

/**
 * Languages a translator publishes by themselves from Review (managers included); none unless the
 * Worker offers it and this build has the publisher. Never English, and never an editor's rows.
 */
export function publishLanguages(
  user: Publisher | null | undefined,
): readonly TranslationLanguage[] {
  if (user?.role !== 'translator' || !user.translationPublish || !publisherEnabled()) return none;
  const languages = user.languages?.filter((lang) => lang !== 'en');
  return languages?.length ? languages : none;
}

export function canPublishTranslations(user: Publisher | null | undefined): boolean {
  return publishLanguages(user).length > 0;
}

/** Editors and maintainers fold the rows that translators publish once the Worker lets them. */
export function foldsTranslations(user: User | null | undefined): boolean {
  return canPushLive(user) && !!user?.translationPublish && publisherEnabled();
}

export function canPushLive(user: User | null | undefined): boolean {
  return user?.role === 'maintainer' || user?.role === 'editor';
}
