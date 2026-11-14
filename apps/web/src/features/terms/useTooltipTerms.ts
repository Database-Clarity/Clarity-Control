import { useEffect, useState } from 'react';
import type { Lang } from '@clarity/core';
import { requestTermMatches } from '../editor/diagnosticWorker';
import { readableProse } from '../editor/parity';
import type { Term, TermList } from './termList';
import { useTermList } from './useTermList';

const none: readonly Term[] = [];

/**
 * The terms in one tooltip's English, in reading order, each once: the Terms list in the editor's
 * status bar (keyboard and phone path to the same Insert as the English pane's marks). Matched
 * from the markup's readable prose, so it works while the English pane is not shown. Requested
 * when the English or the list changes, never per key.
 */
export function useTooltipTerms(lang: Lang, enabled: boolean, english: string | undefined) {
  const list = useTermList(lang, enabled && Boolean(english));
  const [found, setFound] = useState<{ list: TermList; english: string; terms: Term[] }>();
  useEffect(() => {
    if (!list || !english) return;
    let current = true;
    void requestTermMatches(list, readableProse(english)).then((matches) => {
      if (!current) return;
      const terms = [...new Set(matches.map((match) => list.terms[match.entry]!))];
      setFound({ list, english, terms });
    });
    return () => {
      current = false;
    };
  }, [list, english]);
  return {
    loading:
      enabled && Boolean(english) && (!list || found?.list !== list || found.english !== english),
    terms: found && found.list === list && found.english === english ? found.terms : none,
  };
}
