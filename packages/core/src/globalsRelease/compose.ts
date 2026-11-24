import { languages } from '../languages.js';
import { stableStringify } from '../contentHash.js';
import {
  globalAggregateKind,
  globalStoreSchema,
  type GlobalRecord,
  type GlobalStore,
} from '../globals/model.js';
import { projectGlobals } from '../globals/projection.js';

/** Retain literal bytes and recipes, and add newly introduced declarations.
 * Saved drafts keep the new language's complete stamp while entry-only releases
 * use the original publication metadata.
 */
export function reconcileGlobalStore(
  layout: GlobalStore['aggregates'],
  entries: GlobalRecord[],
  { preserveNewLanguageSourceStamp = false } = {},
): GlobalStore {
  const aggregates = structuredClone(layout);
  for (const aggregate of aggregates) {
    const kind = globalAggregateKind(aggregate.document.hash);
    for (const lang of languages) {
      const definitions = entries.filter(
        (entry) => !entry.tombstone && entry.kind === kind && entry.definitions[lang],
      );
      let cell = aggregate.languages[lang];
      const latest = definitions
        .map((entry) => entry.definitions[lang]!)
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        .at(-1);
      if (!cell && latest) {
        const definition = preserveNewLanguageSourceStamp
          ? latest
          : definitions[0].definitions[lang]!;
        const { updatedAt, updatedBy, sourceUpdatedAt } = definition;
        cell = aggregate.languages[lang] = {
          metadata: {
            updatedAt,
            updatedBy,
            ...(preserveNewLanguageSourceStamp && sourceUpdatedAt !== undefined && {
              sourceUpdatedAt,
            }),
          },
          segments: [{ literal: '' }],
        };
      }
      if (!cell) continue;
      if (latest && Date.parse(latest.updatedAt) > Date.parse(cell.metadata.updatedAt)) {
        const {
          body: _body,
          revision: _revision,
          provenance: _provenance,
          sourceRevision: _sourceRevision,
          ...metadata
        } = latest;
        void _body;
        void _revision;
        void _provenance;
        void _sourceRevision;
        cell.metadata = metadata;
      }
      const valid = new Set(definitions.map((entry) => entry.id));
      cell.segments = cell.segments.filter(
        (segment) => !('entryId' in segment) || valid.has(segment.entryId),
      );
      const present = new Set(
        cell.segments.flatMap((segment) => ('entryId' in segment ? [segment.entryId] : [])),
      );
      for (const entry of definitions) {
        if (present.has(entry.id)) continue;
        // A new declaration must have a line boundary even after a non-newline literal.
        cell.segments.push(
          { literal: '\n' },
          {
            entryId: entry.id,
            beforeName: kind === 'variables' ? 'var ' : kind === 'exports' ? 'export ' : 'title ',
            afterName: kind === 'variables' ? ' = ' : ' (\n',
            afterBody: kind === 'variables' ? '' : '\n)',
          },
        );
      }
    }
  }
  const result = globalStoreSchema.parse({ version: 1, entries, aggregates });
  projectGlobals(result);
  return result;
}

/** A release starts with last-published records, never with the saved aggregate. */
export function composeGlobalRelease(
  published: GlobalStore,
  saved: GlobalStore,
  ids: readonly string[],
): GlobalStore {
  globalStoreSchema.parse(published);
  globalStoreSchema.parse(saved);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate release global');
  const replacements = new Map(
    saved.entries.filter((entry) => ids.includes(entry.id)).map((entry) => [entry.id, entry]),
  );
  if (replacements.size !== ids.length) throw new Error('Deleted release dependency');
  const entries = published.entries.map((entry) => replacements.get(entry.id) ?? entry);
  for (const entry of replacements.values())
    if (!entries.some((old) => old.id === entry.id)) entries.push(entry);
  return reconcileGlobalStore(published.aggregates, entries);
}

export function changedGlobalIds(published: GlobalStore, saved: GlobalStore): string[] {
  const next = new Map(saved.entries.map((entry) => [entry.id, entry]));
  for (const entry of published.entries)
    if (!next.has(entry.id)) throw new Error('Missing global tombstone');
  return saved.entries
    .filter((entry) => {
      const previous = published.entries.find((old) => old.id === entry.id);
      return stableStringify(previous ?? null) !== stableStringify(entry);
    })
    .map((entry) => entry.id);
}
