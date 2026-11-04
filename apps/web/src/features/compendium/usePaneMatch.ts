import type { CompendiumData, Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Drafts } from '../../services/draftStorage';
import { useDisplayMatches } from './useDisplayMatches';
export function usePaneMatch(
  base: Tooltip,
  editor: EditorData | null,
  source: CompendiumData | null,
  drafts: Drafts,
  userId?: string | number,
) {
  const result = useDisplayMatches(editor, source, drafts, userId);
  return base.compendium || drafts[base.hash]?.next.compendium
    ? undefined
    : result.matches?.get(base.hash);
}
