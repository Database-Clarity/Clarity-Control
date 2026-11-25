import {
  clearedState,
  inactiveRemovalHash,
  isMovedInactive,
  isTextlessDescription,
  resolveAlias,
  withClearedMoves,
  withoutEnglish,
} from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { PendingTooltip } from './model';

/** Whether the published version has English: the bundle names where saved and published differ. */
function publishedEnglish(data: EditorData, hash: number, marker: string): boolean {
  // Published by this session, after the bundle was built.
  if (marker !== data.bundle.pushed[hash]) return true;
  const built = (data.tooltipSnapshot ?? data.bundle).tooltips[hash];
  const differs = data.bundle.englishChanged?.includes(hash) ?? false;
  return (!!built && !withoutEnglish(built)) !== differs;
}

/** Each saved tooltip's cleared state (core clearedState), for the ones that have one. */
export async function clearedTooltips(
  data: EditorData,
  pushed: Readonly<Record<string, string>>,
): Promise<ReadonlyMap<number, 'removal' | 'removed'>> {
  const moves = data.bundle.inactiveMoves;
  const states = new Map<number, 'removal' | 'removed'>();
  await Promise.all(
    Object.values(data.bundle.tooltips).map(async (tooltip) => {
      const { hash } = tooltip;
      const marker = pushed[hash];
      if (
        marker === undefined ||
        !withoutEnglish(tooltip) ||
        isMovedInactive(hash, moves) ||
        resolveAlias(hash, data.aliases) !== hash
      )
        return;
      const english = publishedEnglish(data, hash, marker);
      // Without any text, published without English: never listed, so nothing to work out.
      if (!english && isTextlessDescription(tooltip)) return;
      const state = clearedState(tooltip, marker, await inactiveRemovalHash(hash), english);
      if (state) states.set(hash, state);
    }),
  );
  return states;
}

/** The moves a publish of these rows applies: the stored ones and their cleared removals. */
export const publishMoves = (data: EditorData, entries: readonly PendingTooltip[]) =>
  withClearedMoves(
    data.bundle.inactiveMoves ?? {},
    entries.flatMap(({ tooltip, cleared }) => (cleared ? [tooltip.hash] : [])),
  );
