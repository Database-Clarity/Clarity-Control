import {
  resolveCompendiumLink,
  sameCell,
  stableStringify,
  type CompendiumCell,
  type CompendiumData,
} from '@clarity/core';
import type { Change } from '../api';
import { recordsCompendiumSnapshot } from './enrichers/compendium';

export interface ChangedSource {
  hash: number;
  /** What the editor was shown (or, if the Compendium was never loaded, the reviewed snapshot). */
  shown: CompendiumCell;
  /** What saving would record as reviewed. */
  fresh: CompendiumCell;
}

/**
 * Saving English text on a linked tooltip records the Compendium cell as reviewed. When that
 * cell differs from the one the editor was shown (`shown` is the store's data; the panel and
 * its diff render from it), the reviewer has not seen what they would be signing off.
 * Links that no longer resolve are left to the enricher, which blocks the save itself.
 */
export function changedSources(
  changes: readonly Change[],
  shown: CompendiumData | null,
  fresh: CompendiumData,
): ChangedSource[] {
  const found: ChangedSource[] = [];
  for (const { hash, base, next } of changes) {
    const link = next.compendium;
    if (!link || !recordsCompendiumSnapshot(base ?? undefined, next)) continue;
    const now = resolveCompendiumLink(link, fresh);
    if (
      now.status === 'missing' ||
      now.status === 'candidates' ||
      now.status === 'relink-suggested'
    )
      continue;
    const before = shown ? resolveCompendiumLink(link, shown) : undefined;
    const seen = before && 'row' in before ? before.row.cell : link.snapshot;
    if (!sameCell(seen, now.row.cell)) found.push({ hash, shown: seen, fresh: now.row.cell });
  }
  return found;
}

/** Identity of the fresh cells a reviewer acknowledged; a further change needs a new tick. */
export const sourceKey = (sources: readonly ChangedSource[]): string =>
  stableStringify(sources.map(({ hash, fresh }) => [hash, fresh]));

export const linksCompendium = (changes: readonly Change[]): boolean =>
  changes.some(({ base, next }) => recordsCompendiumSnapshot(base ?? undefined, next));
