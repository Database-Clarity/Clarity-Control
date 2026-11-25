import {
  clearedState,
  inactiveRemovalHash,
  isMovedInactive,
  isTextlessDescription,
  resolveAlias,
  withClearedMoves,
  withoutEnglish,
} from '@clarity/core';
import { publishedEnglish } from '../../services/publishedEnglish';
import type { EditorData } from '../../stores/data';
import type { PendingTooltip } from './model';

/** Each saved tooltip's cleared state (core clearedState), for the ones that have one. */
export async function clearedTooltips(
  data: EditorData,
  pushed: Readonly<Record<string, string>>,
): Promise<ReadonlyMap<number, 'removal' | 'removed'>> {
  const moves = data.bundle.inactiveMoves;
  const candidates = Object.values(data.bundle.tooltips).filter((tooltip) => {
    const { hash } = tooltip;
    const marker = pushed[hash];
    return (
      marker !== undefined &&
      withoutEnglish(tooltip) &&
      !isMovedInactive(hash, moves) &&
      resolveAlias(hash, data.aliases) === hash &&
      // Without any text, published without English: never listed, so nothing to work out.
      (!isTextlessDescription(tooltip) || publishedEnglish(data, hash, marker))
    );
  });
  const states = new Map<number, 'removal' | 'removed'>();
  for (const tooltip of candidates) {
    const { hash } = tooltip;
    const marker = pushed[hash]!;
    const english = publishedEnglish(data, hash, marker);
    const state = clearedState(tooltip, marker, await inactiveRemovalHash(hash), english);
    if (state) states.set(hash, state);
  }
  return states;
}

/** The moves a publish of these rows applies: the stored ones and their cleared removals. */
export const publishMoves = (data: EditorData, entries: readonly PendingTooltip[]) =>
  withClearedMoves(
    data.bundle.inactiveMoves ?? {},
    entries.flatMap(({ tooltip, cleared }) => (cleared ? [tooltip.hash] : [])),
  );
