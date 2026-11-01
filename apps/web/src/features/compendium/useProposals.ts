import { useEffect, useState } from 'react';
import type { CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { ReviewProposal } from './rapidReview';
// Matching runs off the UI thread; drafts and local decisions do not restart it.
export function useProposals(editor: EditorData, source: CompendiumData) {
  const [result, setResult] = useState<{
    editor: EditorData;
    source: CompendiumData;
    proposals: Map<number, ReviewProposal>;
    error?: string;
  }>();
  useEffect(() => {
    const worker = new Worker(new URL('./proposals.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = ({
      data,
    }: MessageEvent<{ proposals?: [number, ReviewProposal][]; error?: string }>) => {
      setResult({ editor, source, proposals: new Map(data.proposals), error: data.error });
    };
    worker.onerror = () =>
      setResult({
        editor,
        source,
        proposals: new Map(),
        error: 'Proposal matching failed. Pick other remains available.',
      });
    worker.postMessage({ editor, source });
    return () => worker.terminate();
  }, [editor, source]);
  const current = result?.editor === editor && result?.source === source ? result : undefined;
  return {
    proposals: current?.proposals ?? new Map<number, ReviewProposal>(),
    loading: !current,
    error: current?.error,
  };
}
