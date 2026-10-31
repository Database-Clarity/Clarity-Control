import { resolveCompendiumLink, snapshotCompendium, type Tooltip } from '@clarity/core';
import { loadCompendium } from '../../compendium';

export async function compendiumEnricher({
  before,
  next,
}: {
  before: Tooltip | undefined;
  next: Tooltip;
}): Promise<Tooltip> {
  if (!next.compendium || before?.text.en?.text === next.text.en?.text) return next;
  const resolved = resolveCompendiumLink(next.compendium, await loadCompendium());
  if (resolved.status === 'missing' || resolved.status === 'candidates') {
    throw new Error(
      `Compendium link for tooltip ${next.hash} needs relinking before saving English text`,
    );
  }
  return { ...next, compendium: snapshotCompendium(resolved) };
}
