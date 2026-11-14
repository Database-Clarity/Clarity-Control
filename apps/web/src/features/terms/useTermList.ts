import { useEffect, useMemo } from 'react';
import type { Lang } from '@clarity/core';
import { useDataStore } from '../../stores/data';
import { ensureNames, useNamesStore } from './names';
import { buildTermList, mergeGlossary, type TermList } from './termList';
import { useAuthStore } from '../../stores/auth';
import { ensureGlossary, useGlossaryStore } from '../../stores/glossary';

/** The official-name list for `lang`, once its names file is here; undefined until then. */
export function useTermList(lang: Lang, enabled: boolean): TermList | undefined {
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  useEffect(() => {
    if (enabled) {
      ensureNames(lang);
      ensureGlossary(lang);
    }
  }, [enabled, lang, user, token]);
  const glossary = useGlossaryStore((store) =>
    enabled && user?.role ? store.byLang[lang]?.remote : undefined,
  );
  const state = useNamesStore((store) => (enabled ? store.byLang[lang] : undefined));
  const items = useDataStore((store) => store.data?.items);
  return useMemo(() => {
    const names =
      state?.status === 'ready' && items ? buildTermList(items, state.file, lang) : undefined;
    return glossary ? mergeGlossary(names, glossary.glossary, glossary.revision) : names;
  }, [state, items, lang, glossary]);
}
