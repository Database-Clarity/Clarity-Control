import { stableStringify } from '../contentHash.js';
import { markupDefinitions } from '../markup/clashes.js';
import { reservedNamePattern } from '../markup/braces.js';
import type { Tooltip } from '../schemas.js';
import { globalStoreSchema, type GlobalStore } from './model.js';
import { projectGlobals } from './projection.js';

/** Structural/data guards only; permissions, impact review, and atomic commits belong to S2. */
export function assertGlobalTransition(
  beforeInput: GlobalStore,
  afterInput: GlobalStore,
  tooltips: Readonly<Record<string, Tooltip>>,
): void {
  const before = globalStoreSchema.parse(beforeInput),
    after = globalStoreSchema.parse(afterInput);
  projectGlobals(after);
  for (const old of before.entries) {
    const next = after.entries.find((entry) => entry.id === old.id);
    if (!next || next.kind !== old.kind)
      throw new Error('Global IDs and kinds are immutable; use tombstones');
    if (old.tombstone && stableStringify(old) !== stableStringify(next))
      throw new Error('Tombstones are immutable');
    if (old.kind === 'variables' && old.name === 'e' && (next.name !== old.name || next.tombstone))
      throw new Error('The legacy enhanced arrow identity is protected');
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
        stableStringify(definition.provenance) !== stableStringify(replacement.provenance)
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
    const old = before.entries.find((v) => v.id === entry.id);
    for (const [lang] of Object.entries(entry.definitions)) {
      if (old?.name === entry.name && Object.hasOwn(old.definitions, lang)) continue;
      for (const tooltip of Object.values(tooltips)) {
        if (tooltip.hash === 2 || tooltip.hash === 3) continue;
        const local = markupDefinitions(
          tooltip.text[lang as keyof typeof tooltip.text]?.text ?? '',
        );
        if (
          local.some(
            (d) =>
              d.name === entry.name &&
              d.kind === (entry.kind === 'variables' ? 'variable' : 'title'),
          )
        )
          throw new Error(
            `Local/global name clash: ${entry.name}, tooltip ${tooltip.hash}, ${lang}`,
          );
      }
    }
  }
}
