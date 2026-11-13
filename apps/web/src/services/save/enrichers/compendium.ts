import {
  isMarkupOnly,
  resolveCompendiumLink,
  snapshotCompendium,
  type CompendiumData,
  type Tooltip,
} from '@clarity/core';
import { loadCompendium } from '../../compendium';

/**
 * Only an English text change records a fresh Compendium snapshot as reviewed. Tagging alone
 * (`<solar/>Scorch` to `<solar Scorch />`, same lowered text) reviews nothing, as in the metadata
 * and Bungie enrichers; the save panel's source check shares this rule.
 */
export function recordsCompendiumSnapshot(before: Tooltip | undefined, next: Tooltip): boolean {
  const previous = before?.text.en?.text;
  const current = next.text.en?.text;
  return Boolean(next.compendium) && previous !== current && !isMarkupOnly(previous, current ?? '');
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
  if (
    resolved.status === 'missing' ||
    resolved.status === 'candidates' ||
    resolved.status === 'relink-suggested'
  ) {
    throw new Error(
      `Compendium link for tooltip ${next.hash} needs relinking before saving English text`,
    );
  }
  return { ...next, compendium: snapshotCompendium(resolved) };
}
