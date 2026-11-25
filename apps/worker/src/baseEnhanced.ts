import {
  baseEnhancedPublishMessage,
  isTextlessDescription,
  markupImports,
  resolveAlias,
  tooltipSchema,
  type Aliases,
  type InactiveMoves,
  type Tooltip,
} from '@clarity/core';
import { refuseReservedNames } from './elementTags.js';
import type { GitHub } from './github.js';
import type { AliasScope } from './catalog.js';
import { HttpError } from './http.js';
import { clearedStates } from './inactiveMoves.js';

/**
 * A text without English, published with it, reads as having none. `removals` collects the roots
 * a publish removes for that, with their reviewed digest: they are left out of the checks and of
 * the result.
 */
interface Clearing {
  moves: InactiveMoves;
  removals?: Map<number, string>;
}

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
  scope?: AliasScope,
  { moves, removals }: Clearing = { moves: {} },
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
  const loadedStates = (hashes: readonly number[]) =>
    clearedStates(
      github,
      head,
      hashes.flatMap((hash) => known.get(hash) ?? []),
      moves,
    );
  const visited = new Set<number>();
  let pending = [...roots, 2, 3];
  while (pending.length) {
    if (scope) aliases = scope.extend(pending);
    const first = !visited.size;
    const targets = [...new Set(pending.map((hash) => resolveAlias(hash, aliases)))];
    const imported = first ? undefined : targets.find((hash) => removals?.has(hash));
    if (imported !== undefined)
      throw new HttpError(422, `A selected tooltip imports cleared tooltip ${imported}`);
    const hashes = targets.filter((hash) => !visited.has(hash));
    if (!hashes.length) break;
    hashes.forEach((hash) => visited.add(hash));
    await loadMissing(hashes);
    const states = await loadedStates(hashes);
    pending = [];
    for (const hash of hashes) {
      const tooltip = known.get(hash);
      if (!tooltip) continue;
      const cleared = states.get(hash);
      if (first && removals && cleared?.state === 'removal') {
        removals.set(hash, cleared.reviewed);
        continue;
      }
      if (first && removals && cleared?.state === 'removed')
        throw new HttpError(409, `Tooltip ${hash} changed since review; refresh saved changes`);
      if (cleared && !first)
        throw new HttpError(422, `A selected tooltip imports cleared tooltip ${hash}`);
      if (cleared || isTextlessDescription(tooltip))
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
  const targets = roots.flatMap((hash) => {
    const root = resolveAlias(hash, aliases);
    return removals?.has(root) ? [] : (known.get(root)?.associated ?? []);
  });
  if (scope) aliases = scope.extend(targets);
  const associated = [...new Set(targets.map((hash) => resolveAlias(hash, aliases)))];
  await loadMissing(associated);
  const states = await loadedStates(associated);
  for (const hash of associated) {
    const target = known.get(hash);
    if (target && states.has(hash))
      throw new HttpError(422, `A selected tooltip associates cleared tooltip ${hash}`);
    if (target && isTextlessDescription(target))
      throw new HttpError(422, `Tooltip ${hash} has no text to publish`);
  }
  for (const hash of removals?.keys() ?? []) known.delete(hash);
  // Variable names starting like a brace holder (Zb1w…) would take a holder's place in the
  // export: refused in every document a publish or push reads, as /save refuses them.
  for (const tooltip of known.values()) refuseReservedNames(tooltip);
  return known;
}
