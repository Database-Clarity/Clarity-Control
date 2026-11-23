import { languages } from '../languages.js';
import { stableStringify } from '../contentHash.js';
import {
  globalAggregateKind,
  globalStoreSchema,
  type GlobalDefinition,
  type GlobalRecord,
  type GlobalStore,
} from '../globals/model.js';
import { projectGlobals } from '../globals/projection.js';

function definitionMetadata(definition: GlobalDefinition) {
  const { body, revision, provenance, sourceRevision, ...metadata } = definition;
  void body;
  void revision;
  void provenance;
  void sourceRevision;
  return metadata;
}

/** Retain existing literal bytes and recipes and attach new declarations.
 * A new language takes the same complete metadata as a later update to that language.
 */
export function reconcileGlobalStore(
  layout: GlobalStore['aggregates'],
  entries: GlobalRecord[],
  published?: GlobalStore,
): GlobalStore {
  const aggregates = structuredClone(layout);
  const liveEntries = new Set(
    published?.entries.filter((entry) => !entry.tombstone).map(({ id }) => id),
  );
  for (const aggregate of aggregates) {
    const kind = globalAggregateKind(aggregate.document.hash);
    const liveLayout = published?.aggregates.find(
      ({ document }) => document.hash === aggregate.document.hash,
    );
    for (const lang of languages) {
      const definitions = entries.filter(
        (entry) => !entry.tombstone && entry.kind === kind && entry.definitions[lang],
      );
      const latest = definitions
        .map((entry) => entry.definitions[lang]!)
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        .at(-1);
      let cell = aggregate.languages[lang];
      const liveStamp = liveLayout?.languages[lang]?.metadata;
      if (
        cell &&
        liveStamp &&
        entries.some((entry) => {
          const definition = entry.definitions[lang];
          return (
            entry.kind === kind &&
            entry.tombstone &&
            !liveEntries.has(entry.id) &&
            definition &&
            stableStringify(definitionMetadata(definition)) === stableStringify(cell!.metadata)
          );
        })
      ) {
        // Creating and removing an unpublished declaration must not age other translations.
        cell.metadata = structuredClone(liveStamp);
      }
      if (latest && !cell) {
        cell = aggregate.languages[lang] = {
          metadata: definitionMetadata(latest),
          segments: [{ literal: '' }],
        };
      } else if (
        latest &&
        cell &&
        Date.parse(latest.updatedAt) > Date.parse(cell.metadata.updatedAt)
      ) {
        cell.metadata = definitionMetadata(latest);
      }
      if (!cell) continue;
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

/** Old releases could drop the source date when a language was first created.
 * Attribute a repair to the entry owning that exact stamp so its readers can approve it.
 */
function missingSourceDates(published: GlobalStore, saved: GlobalStore) {
  const repairs: { id: string; hash: number; lang: (typeof languages)[number]; date: string }[] =
    [];
  for (const aggregate of published.aggregates) {
    const hash = aggregate.document.hash;
    const next = saved.aggregates.find(({ document }) => document.hash === hash);
    for (const lang of languages) {
      const previous = aggregate.languages[lang]?.metadata;
      const metadata = next?.languages[lang]?.metadata;
      if (!previous || previous.sourceUpdatedAt || !metadata?.sourceUpdatedAt) continue;
      const { sourceUpdatedAt, ...stamp } = metadata;
      if (stableStringify(previous) !== stableStringify(stamp)) continue;
      const owner = saved.entries.find((entry) => {
        const definition = entry.definitions[lang];
        return (
          !entry.tombstone &&
          entry.kind === globalAggregateKind(hash) &&
          definition !== undefined &&
          stableStringify(definitionMetadata(definition)) === stableStringify(metadata)
        );
      });
      if (owner) repairs.push({ id: owner.id, hash, lang, date: sourceUpdatedAt });
    }
  }
  return repairs;
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
  const repairs = missingSourceDates(published, saved).filter(({ id }) => replacements.has(id));
  const layout = repairs.length ? structuredClone(published.aggregates) : published.aggregates;
  for (const { hash, lang, date } of repairs)
    layout.find(({ document }) => document.hash === hash)!.languages[
      lang
    ]!.metadata.sourceUpdatedAt = date;
  return reconcileGlobalStore(layout, entries);
}

export function changedGlobalIds(published: GlobalStore, saved: GlobalStore): string[] {
  const next = new Map(saved.entries.map((entry) => [entry.id, entry]));
  for (const entry of published.entries)
    if (!next.has(entry.id)) throw new Error('Missing global tombstone');
  const repairs = new Set(missingSourceDates(published, saved).map(({ id }) => id));
  return saved.entries
    .filter((entry) => {
      const previous = published.entries.find((old) => old.id === entry.id);
      return repairs.has(entry.id) || stableStringify(previous ?? null) !== stableStringify(entry);
    })
    .map((entry) => entry.id);
}
