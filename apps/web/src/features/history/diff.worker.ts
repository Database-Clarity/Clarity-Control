import { diffWords } from '../../ui/diff/diffWords';
import type { Tooltip } from '@clarity/core';
import { classifyRevision } from './scope';
self.onmessage = (
  event: MessageEvent<
    | { id: number; kind?: 'words'; before: string; after: string }
    | { id: number; kind: 'classify'; before: Tooltip | null; after: Tooltip | null }
  >,
) => {
  if (event.data.kind === 'classify') {
    const { id, before, after } = event.data;
    self.postMessage({ id, changes: classifyRevision(before, after) });
    return;
  }
  const { id, before, after } = event.data;
  self.postMessage({ id, parts: diffWords(before, after) });
};
