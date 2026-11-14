import { useEffect, useMemo } from 'react';
import type { Lang } from '@clarity/core';
import { useDataStore } from '../../stores/data';
import { ensureNames, useNamesStore } from './names';
import { buildTermList, type TermList } from './termList';

/** The official-name list for `lang`, once its names file is here; undefined until then. */
export function useTermList(lang: Lang, enabled: boolean): TermList | undefined {
  useEffect(() => {
    if (enabled) ensureNames(lang);
  }, [enabled, lang]);
  const state = useNamesStore((store) => (enabled ? store.byLang[lang] : undefined));
  const items = useDataStore((store) => store.data?.items);
  return useMemo(
    () => (state?.status === 'ready' && items ? buildTermList(items, state.file, lang) : undefined),
    [state, items, lang],
  );
}
