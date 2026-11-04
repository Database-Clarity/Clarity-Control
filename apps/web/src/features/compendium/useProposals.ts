import { useEffect, useState } from 'react';
import type { CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { ReviewProposal } from './rapidReview';
import { matchingSession, peekMatchingSession } from './matchingSession';
const emptyProposals = new Map<number, ReviewProposal>();
// Matching runs off the UI thread; drafts and local decisions do not restart it.
export function useProposals(editor: EditorData, source: CompendiumData) {
  const [result, setResult] = useState<{
    editor: EditorData;
    source: CompendiumData;
    proposals: Map<number, ReviewProposal>;
    error?: string;
  }>();
  useEffect(() => {
    if (peekMatchingSession(editor, source)?.currentProposals) return;
    let cancelled = false;
    void matchingSession(editor, source)
      .proposals.then((proposals) => {
        if (!cancelled) setResult({ editor, source, proposals });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setResult({
            editor,
            source,
            proposals: new Map(),
            error: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [editor, source]);
  const current = result?.editor === editor && result?.source === source ? result : undefined;
  const cached = peekMatchingSession(editor, source)?.currentProposals;
  return {
    proposals: current?.proposals ?? cached ?? emptyProposals,
    loading: !current && !cached,
    error: current?.error,
  };
}
