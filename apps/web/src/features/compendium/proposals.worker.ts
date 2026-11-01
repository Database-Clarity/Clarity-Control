import type { CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { reviewEvidence } from './reviewQueue';
import { proposalFor } from './rapidReview';
self.onmessage = ({ data }: MessageEvent<{ editor: EditorData; source: CompendiumData }>) => {
  try {
    const { editor, source } = data;
    const proposals = reviewEvidence(editor, source, {}, '')
      .filter((entry) => !entry.valid)
      .map((entry) => [entry.hash, proposalFor(entry.base, editor, source)] as const);
    self.postMessage({ proposals });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
