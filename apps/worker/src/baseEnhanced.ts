import {
  baseEnhancedPublishMessage,
  isTextlessDescription,
  markupImports,
  resolveAlias,
  tooltipSchema,
  type Aliases,
  type Tooltip,
} from '@clarity/core';
import { refuseReservedNames } from './elementTags.js';
import type { GitHub } from './github.js';
import { HttpError } from './http.js';

/** Fail closed, at one immutable data commit, before signing or writing consumer input.
 * Scan all languages and whole imported documents, including named exports and globals.
 * A visited set bounds cycles; GitHub's request budget bounds arbitrarily deep graphs.
 */
export async function refuseBaseEnhanced(
  github: GitHub,
  head: string,
  roots: readonly number[],
  aliases: Aliases,
  loaded: readonly Tooltip[] = [],
): Promise<ReadonlyMap<number, Tooltip>> {
  const known = new Map(loaded.map((tooltip) => [tooltip.hash, tooltip]));
  const loadMissing = async (hashes: readonly number[]) => {
    const missing = hashes.filter((hash) => !known.has(hash));
    if (!missing.length) return;
    const files = await github.files(
      missing.map((hash) => `tooltips/${hash}.json`),
      head,
    );
    files.forEach((file, index) => {
      if (!file) return;
      const tooltip = tooltipSchema.parse(file.value);
      if (tooltip.hash !== missing[index]) throw new HttpError(502, 'Stored tooltip hash mismatch');
      known.set(tooltip.hash, tooltip);
    });
  };
  const visited = new Set<number>();
  let pending = [...roots, 2, 3];
  while (pending.length) {
    const hashes = [...new Set(pending.map((hash) => resolveAlias(hash, aliases)))].filter(
      (hash) => !visited.has(hash),
    );
    if (!hashes.length) break;
    hashes.forEach((hash) => visited.add(hash));
    await loadMissing(hashes);
    pending = [];
    for (const hash of hashes) {
      const tooltip = known.get(hash);
      if (!tooltip) continue;
      if (isTextlessDescription(tooltip))
        throw new HttpError(422, `Tooltip ${hash} has no text to publish`);
      for (const translation of Object.values(tooltip.text)) {
        if (!translation) continue;
        const text = translation.text;
        if (text.includes('{{')) throw new HttpError(422, baseEnhancedPublishMessage);
        for (const line of markupImports(text)) {
          const from = line.match(/ from (\d+|global) *$/)?.[1];
          if (from) pending.push(from === 'global' ? 1 : Number(from));
        }
      }
    }
  }
  // Associations reference live entries, not their draft markup or draft associations.
  // Check only direct targets of the selected roots, separately from the import walk.
  const associated = [
    ...new Set(
      roots
        .flatMap((hash) => known.get(resolveAlias(hash, aliases))?.associated ?? [])
        .map((hash) => resolveAlias(hash, aliases)),
    ),
  ];
  await loadMissing(associated);
  for (const hash of associated) {
    const target = known.get(hash);
    if (target && isTextlessDescription(target))
      throw new HttpError(422, `Tooltip ${hash} has no text to publish`);
  }
  // Variable names starting like a brace holder (Zb1w…) would take a holder's place in the
  // export: refused in every document a publish or push reads, as /save refuses them.
  for (const tooltip of known.values()) refuseReservedNames(tooltip);
  return known;
}
