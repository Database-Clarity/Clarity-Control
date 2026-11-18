import { stableStringify } from '../contentHash.js';
import { markupDefinitions } from '../markup/clashes.js';
import { reservedNamePattern } from '../markup/braces.js';
import { extractBlocks, extractVariables } from '../markup/syntax.js';
import { removeMarkupComments } from '../markup/prepare.js';
import { languages } from '../languages.js';
import type { Tooltip } from '../schemas.js';
import { globalStoreSchema, type GlobalStore } from './model.js';
import { projectGlobals } from './projection.js';
import { globalSourceText } from './source.js';

/** Structural/data guards only; permissions, impact review, and atomic commits belong to S2. */
export function assertGlobalTransition(
  beforeInput: GlobalStore,
  afterInput: GlobalStore,
  tooltips: Readonly<Record<string, Tooltip>>,
): void {
  const before = globalStoreSchema.parse(beforeInput),
    after = globalStoreSchema.parse(afterInput);
  const beforeAggregates = projectGlobals(before),
    afterAggregates = projectGlobals(after);
  for (const old of before.entries) {
    const next = after.entries.find((entry) => entry.id === old.id);
    if (!next || next.kind !== old.kind)
      throw new Error('Global IDs and kinds are immutable; use tombstones');
    if (old.tombstone && stableStringify(old) !== stableStringify(next))
      throw new Error('Tombstones are immutable');
    if (old.kind === 'variables' && old.name === 'e' && (next.name !== old.name || next.tombstone))
      throw new Error('The legacy enhanced arrow identity is protected');
    if (
      old.kind === 'variables' &&
      old.name === 'e' &&
      Object.keys(old.definitions).some((lang) => !Object.hasOwn(next.definitions, lang))
    )
      throw new Error('The legacy enhanced arrow definitions are protected');
    if (stableStringify(old) !== stableStringify(next) && old.revision === next.revision)
      throw new Error('Changed global requires a new revision');
    if (
      next.name !== old.name &&
      (next.nameHistory.length !== old.nameHistory.length + 1 ||
        stableStringify(next.nameHistory.slice(0, -1)) !== stableStringify(old.nameHistory) ||
        next.nameHistory.at(-1)?.name !== old.name ||
        next.nameHistory.at(-1)?.revision !== old.revision)
    )
      throw new Error('Rename must append the previous identity to name history');
    if (
      next.name === old.name &&
      stableStringify(next.nameHistory) !== stableStringify(old.nameHistory)
    )
      throw new Error('Name history is append-only on rename');
    for (const [lang, definition] of Object.entries(old.definitions)) {
      const replacement = next.definitions[lang as keyof typeof next.definitions];
      if (
        replacement &&
        stableStringify(definition.provenance ?? null) !==
          stableStringify(replacement.provenance ?? null)
      )
        throw new Error('Migration ancestry is immutable');
      if (
        replacement &&
        stableStringify(definition) !== stableStringify(replacement) &&
        definition.revision === replacement.revision
      )
        throw new Error('Changed definition requires a new revision');
    }
  }
  for (const entry of after.entries) {
    if (entry.tombstone) continue;
    if (entry.kind === 'variables' && reservedNamePattern.test(entry.name))
      throw new Error('Generated variable names are reserved');
    if (
      entry.kind === 'variables' &&
      entry.name === 'e' &&
      Object.values(entry.definitions).some((definition) => definition.body !== '🡅')
    )
      throw new Error('The legacy enhanced arrow value is protected');
  }
  // Check additions in both stored and exported inputs. Aggregate or consumer fallback can
  // introduce a clash in a language with no per-entry definition of its own.
  for (const mode of ['authored', 'live'] as const) {
    for (const hash of [1, 2, 3] as const) {
      for (const lang of languages) {
        const old = beforeAggregates[hash],
          next = afterAggregates[hash];
        const beforeText = old ? (globalSourceText(old, lang, mode) ?? '') : '';
        const afterText = next ? (globalSourceText(next, lang, mode) ?? '') : '';
        const names = (text: string) =>
          hash === 2
            ? extractVariables(text)
            : extractBlocks(text, hash === 1 ? 'export' : 'title');
        const oldNames = names(beforeText);
        const added = new Set(
          Object.keys(names(afterText)).filter((name) => !Object.hasOwn(oldNames, name)),
        );
        if (!added.size) continue;
        for (const tooltip of Object.values(tooltips)) {
          if (tooltip.hash === hash) continue;
          const source = globalSourceText(tooltip, lang, mode) ?? '';
          const locals =
            hash === 1
              ? Object.keys(extractBlocks(removeMarkupComments(source), 'export')).map((name) => ({
                  kind: 'export',
                  name,
                }))
              : markupDefinitions(source);
          for (const local of locals) {
            if (
              local.kind === (hash === 2 ? 'variable' : hash === 1 ? 'export' : 'title') &&
              added.has(local.name)
            )
              throw new Error(
                `Local/global name clash: ${local.name}, tooltip ${tooltip.hash}, ${lang}`,
              );
          }
        }
      }
    }
  }
}
