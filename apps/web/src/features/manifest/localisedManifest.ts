import { useEffect } from 'react';
import type { Lang } from '@clarity/core';
import { ensureNames, useNamesStore } from '../terms/names';

/** Shares the terms loader, its per-device cache, and its session revalidation. */
export function useLocalisedManifest(lang: Lang) {
  const state = useNamesStore((store) => (lang === 'en' ? undefined : store.byLang[lang]));
  useEffect(() => {
    if (lang !== 'en') ensureNames(lang);
  }, [lang]);
  return state?.status === 'ready' ? state.file : undefined;
}
