import {
  resolveCompendiumLink,
  snapshotCompendium,
  type CompendiumData,
  type Tooltip,
} from '@clarity/core';
import { loadCompendium } from '../../compendium';

/** Only an English text change records a fresh Compendium snapshot as reviewed. */
export function recordsCompendiumSnapshot(before: Tooltip | undefined, next: Tooltip): boolean {
  return Boolean(next.compendium) && before?.text.en?.text !== next.text.en?.text;
}

export async function compendiumEnricher({
  before,
  next,
  compendium,
}: {
  before: Tooltip | undefined;
  next: Tooltip;
  /** The exact source the save panel showed and had acknowledged; fetched when absent. */
  compendium?: CompendiumData;
}): Promise<Tooltip> {
  if (!next.compendium || !recordsCompendiumSnapshot(before, next)) return next;
  const resolved = resolveCompendiumLink(next.compendium, compendium ?? (await loadCompendium()));
  if (resolved.status === 'missing' || resolved.status === 'candidates') {
    throw new Error(
      `Compendium link for tooltip ${next.hash} needs relinking before saving English text`,
    );
  }
  return { ...next, compendium: snapshotCompendium(resolved) };
}
