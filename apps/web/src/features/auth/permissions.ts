import type { Lang } from '@clarity/core';
import type { User } from '../../services/api';

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

export function canPushLive(user: User | null | undefined): boolean {
  return user?.role === 'maintainer' || user?.role === 'editor';
}
