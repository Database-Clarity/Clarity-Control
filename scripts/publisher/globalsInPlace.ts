import {
  exportWithInactiveMoves,
  exportLegacy,
  globalPublishedSchema,
  globalsInPlaceClearance,
  globalsInPlaceDefinition,
  globalsInPlaceDefinitions,
  globalsInPlaceFenceSchema,
  globalsInPlaceLibraryText,
  globalsInPlacePath,
  globalsInPlaceSaveIssue,
  globalsReleasePaths,
  isLegacyAliasStub,
  isMovedInactive,
  isTextlessDescription,
  languages,
  legacyGlobalsInPlaceDefinitions,
  lowerConsumerMarkup,
  resolveGlobalsInPlace,
  resolveAlias,
  stableStringify,
  type Aliases,
  type GlobalRecord,
  type GlobalsInPlaceFence,
  type GlobalsInPlaceOptions,
  type GlobalsInPlaceReview,
  type InactiveMoves,
  type LegacyEntry,
  type Tooltip,
} from '../../packages/core/src/index.js';
import { provesInPlace, type LegacyInput } from '../../packages/export/src/index.js';
import { globalSourceText } from '../../packages/core/src/globals/source.js';
import { type Tree } from './git.js';
import { GlobalsPublisher } from './globals.js';
import type { Publisher, Receipt } from './publisher.js';

export function globalsFence(pub: Publisher, tree: Tree): GlobalsInPlaceFence | undefined {
  if (!tree[globalsInPlacePath]) return undefined;
  const fence = globalsInPlaceFenceSchema.parse(pub.read(tree, globalsInPlacePath));
  if (fence.destination !== pub.options.liveBranch)
    throw new Error('The shared text migration belongs to another LIVE branch.');
  return fence;
}

export function requireGlobalsMode(pub: Publisher, tree: Tree, revision?: string) {
  const fence = globalsFence(pub, tree);
  if (fence && !globalsInPlaceClearance(fence))
    throw new Error('Publication is paused for the shared text migration.');
  if (Boolean(fence) !== Boolean(revision))
    throw new Error('The publication mode changed. Review the tooltip again.');
  return fence;
}

export function assertInPlaceRoots(hashes: readonly number[]) {
  if (hashes.some((hash) => globalsInPlaceLibraryText(hash) !== undefined))
    throw new Error(
      'Shared definitions publish with their tooltips. Review the affected tooltip instead.',
    );
}

export function liveGlobalsInput(pub: Publisher, live: string): LegacyInput {
  const input = pub.read<LegacyInput>(pub.git.tree(live), 'liveDescriptions.json');
  if (!input?.perks || !input.databaseSettings) throw new Error('Invalid LIVE descriptions');
  return input;
}

export function assertInPlaceLibraries(input: LegacyInput) {
  for (const hash of [1, 2, 3]) {
    const row = input.perks[hash];
    if (
      !row ||
      row.hash !== hash ||
      !('editor' in row) ||
      (hash === 2 &&
        (row.editor.en?.main !== globalsInPlaceLibraryText(2) ||
          Object.values(row.editor).some(
            (cell) => cell?.main !== globalsInPlaceLibraryText(2) || cell.secondary !== '',
          ))) ||
      (hash !== 2 && Object.keys(row.editor).length !== 0)
    )
      throw new Error(`Invalid in-place LIVE library ${hash}`);
  }
}

export function migrateInPlace(input: LegacyInput): LegacyInput {
  const definitions = legacyGlobalsInPlaceDefinitions(
    input.perks as Parameters<typeof legacyGlobalsInPlaceDefinitions>[0],
  );
  const migrated = structuredClone(input);
  const variables = migrated.perks[2];
  if (!variables || !('editor' in variables)) throw new Error('Missing LIVE library 2');
  migrated.perks[1] ??= {
    hash: 1,
    name: '',
    type: variables.type,
    editor: {},
    uploadedBy: '',
    lastUpload: 0,
    updateTracker: { descriptions: {} },
    inLiveDatabase: false,
    uploadToLive: false,
  };
  for (const row of Object.values(migrated.perks)) {
    if (!('editor' in row)) continue;
    const sentinel = globalsInPlaceLibraryText(row.hash);
    if (sentinel === '') {
      row.editor = {};
      continue;
    }
    for (const lang of languages) {
      const cell = row.editor[lang];
      if (!cell) continue;
      if (sentinel !== undefined) row.editor[lang] = { main: sentinel, secondary: '' };
      else
        for (const part of ['main', 'secondary'] as const)
          try {
            cell[part] = resolveGlobalsInPlace(cell[part], lang, {
              definitions,
              missingTranslation: 'reject',
            });
          } catch (error) {
            throw new Error(`Tooltip ${row.name || row.hash} (${lang}): ${String(error)}`);
          }
    }
    if (sentinel && !row.editor.en) row.editor.en = { main: sentinel, secondary: '' };
  }
  assertInPlaceLibraries(migrated);
  const [refusal] = provesInPlace(input, migrated);
  if (refusal) throw new Error(refusal.message);
  return migrated;
}

/** Library inputs for the old readers, including the intended stand-in in the target language. */
function proofLibraries(live: LegacyInput, options: GlobalsInPlaceOptions) {
  const rows = {} as LegacyInput['perks'];
  for (const [hash, kind] of [
    [1, 'exports'],
    [2, 'variables'],
    [3, 'titles'],
  ] as const) {
    const row = live.perks[hash];
    if (!row || !('editor' in row)) throw new Error(`Missing LIVE library ${hash}`);
    const editor: typeof row.editor = {};
    for (const lang of languages) {
      const lines = Object.entries(options.definitions[kind] ?? {}).flatMap(([name, entry]) => {
        if (kind === 'variables' && name === 'e') return [];
        const selected = globalsInPlaceDefinition(entry, lang, options.missingTranslation);
        if (!selected) return [];
        const { body } = selected;
        if (kind === 'variables') return [`var ${name} = ${body.trim() || 'empty'}`];
        return [`${kind === 'exports' ? 'export' : 'title'} ${name} (\n${body}\n)`];
      });
      if (hash === 2) lines.unshift(globalsInPlaceLibraryText(2)!);
      editor[lang] = { main: lowerConsumerMarkup(lines.join('\n')), secondary: '' };
    }
    rows[hash] = { ...row, editor };
  }
  return rows;
}

function affectedRows(before: LegacyInput, after: LegacyInput, roots: readonly number[]) {
  const affected = new Set(roots.map(String));
  const parents = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    if (!parents.has(to)) parents.set(to, new Set());
    parents.get(to)!.add(from);
  };
  for (const { perks } of [before, after])
    for (const [hash, row] of Object.entries(perks)) {
      if ('aliasOf' in row) link(hash, String(row.aliasOf));
      else
        for (const { main, secondary } of Object.values(row.editor))
          for (const cell of [main, secondary]) {
            if (!cell.includes('import ')) continue;
            for (const match of cell.matchAll(/^import [A-z0-9 ]+? from (\d+) *\r?$/gm))
              link(hash, String(Number(match[1])));
          }
    }
  for (const root of affected) for (const parent of parents.get(root) ?? []) affected.add(parent);
  return affected;
}

/** One prospective LIVE merge per representation, with identical non-global inputs. */
export function provePublication(
  pub: Publisher,
  tree: Tree,
  live: LegacyInput,
  documents: readonly Tooltip[],
  aliases: Aliases,
  moves: InactiveMoves,
  now: number,
  exported: Receipt['exported'],
  options: GlobalsInPlaceOptions,
) {
  assertInPlaceLibraries(live);
  const hashes = documents.map(({ hash }) => hash);
  for (const entry of Object.values(exported)) {
    if (isLegacyAliasStub(entry)) continue;
    for (const [lang, cell] of Object.entries(entry.editor))
      for (const value of new Set([cell.main, cell.secondary]))
        if (resolveGlobalsInPlace(value, lang as (typeof languages)[number], options) !== value)
          throw new Error(
            `Tooltip ${entry.name || entry.hash} (${lang}) still reads shared text after export.`,
          );
  }
  const raw = exportWithInactiveMoves(documents, now, pub.options.facts, aliases, moves);
  const merge = (entries: Receipt['exported']) =>
    pub.mergePublicationPerks(tree, live.perks, entries, hashes) as LegacyInput['perks'];
  proveInPlaceInputs(
    live,
    { ...live, perks: merge(raw) },
    { ...live, perks: merge(exported) },
    options,
    hashes,
  );
}

export function proveInPlaceInputs(
  live: LegacyInput,
  raw: LegacyInput,
  after: LegacyInput,
  options: GlobalsInPlaceOptions,
  hashes: readonly number[],
) {
  const before = { ...raw, perks: { ...raw.perks, ...proofLibraries(live, options) } };
  assertInPlaceLibraries(after);
  const [failure] = provesInPlace(before, after, affectedRows(before, after, hashes));
  if (failure) throw new Error(failure.message);
}

export function inPlaceSource(pub: Publisher, revision: string, fence: GlobalsInPlaceFence) {
  const tree = pub.git.tree(revision);
  const sourceFence = globalsFence(pub, tree);
  if (!sourceFence || stableStringify(sourceFence) !== stableStringify(fence))
    throw new Error('Review the tooltip in the current shared text mode.');
  const entries = new GlobalsPublisher(pub).store(tree).entries;
  return {
    entries,
    options: {
      definitions: globalsInPlaceDefinitions(entries),
      missingTranslation: fence.missingTranslation,
    } satisfies GlobalsInPlaceOptions,
  };
}

export function assertInPlaceDocuments(
  documents: readonly Tooltip[],
  options: GlobalsInPlaceOptions,
) {
  assertInPlaceRoots(documents.map(({ hash }) => hash));
  const titleNames = new Set(Object.keys(options.definitions.titles ?? {}));
  for (const tooltip of documents)
    for (const [lang, cell] of Object.entries(tooltip.text)) {
      const issue = globalsInPlaceSaveIssue(cell.text, titleNames);
      if (issue)
        throw new Error(`Tooltip ${tooltip.custom?.name || tooltip.hash} (${lang}): ${issue}`);
    }
}

function editorOf(value: unknown): LegacyEntry['editor'] | undefined {
  return (value as LegacyEntry | undefined)?.editor;
}

function primary(editor: LegacyEntry['editor'] | undefined, lang: (typeof languages)[number]) {
  const cell = editor?.[lang];
  return cell && [cell.main, cell.englishFallback === true];
}

export function resolvedPrimaryDiffers(before: unknown, after: unknown) {
  return languages.some(
    (lang) =>
      JSON.stringify(primary(editorOf(before), lang)) !==
      JSON.stringify(primary(editorOf(after), lang)),
  );
}

export function publicationChanges(
  entries: Receipt['entries'],
  pushed: Record<string, string>,
  exported: Receipt['exported'],
  live?: LegacyInput,
) {
  return entries
    .filter(
      ({ hash, digest }) =>
        pushed[hash] !== digest ||
        (live && resolvedPrimaryDiffers(live.perks[hash], exported[hash])),
    )
    .map(({ hash }) => hash);
}

/** A scheduled change cannot replace LIVE shared text in an unchanged authored language. */
export function unreviewedScheduledGlobals(
  current: Tooltip,
  published: Tooltip | undefined,
  live: LegacyInput,
  exported: Receipt['exported'],
) {
  if (!published || !editorOf(live.perks[current.hash])) return false;
  return languages.some(
    (lang) =>
      globalSourceText(current, lang, 'live') === globalSourceText(published, lang, 'live') &&
      JSON.stringify(primary(editorOf(live.perks[current.hash]), lang)) !==
        JSON.stringify(primary(editorOf(exported[current.hash]), lang)),
  );
}

/** The latest receipt for each row is the existing record of its reviewed definitions. */
export function reviewRevisions(pub: Publisher, live: string, fence: GlobalsInPlaceFence) {
  const tree = pub.git.tree(live);
  const byHash = new Map<number, string>();
  if (live === fence.migratedLive) return byHash;
  for (const { path } of pub.git.additions(live, '.publish/receipts', fence.migratedLive)) {
    if (!tree[path]) continue;
    const receipt = pub.read<Receipt>(tree, path);
    if (!receipt?.globalsRevision) continue;
    for (const { hash } of receipt.entries) byHash.set(hash, receipt.globalsRevision);
  }
  return byHash;
}

export function migrationBaseline(pub: Publisher, fence: GlobalsInPlaceFence): GlobalRecord[] {
  const tree = pub.git.tree(fence.legacyData);
  const published = globalPublishedSchema.parse(
    pub.read(tree, globalsReleasePaths.published(pub.options.liveBranch)),
  );
  return published.store.entries;
}

export function inPlaceDiff(
  before: unknown,
  after: unknown,
): GlobalsInPlaceReview['rows'][string]['diff'] {
  const left = editorOf(before);
  const right = editorOf(after);
  return Object.fromEntries(
    languages.flatMap((lang) =>
      JSON.stringify(primary(left, lang)) === JSON.stringify(primary(right, lang))
        ? []
        : [[lang, { before: left?.[lang] ?? null, after: right?.[lang] ?? null }]],
    ),
  );
}

function rowCauses(
  tooltip: Tooltip,
  now: number,
  before: ReturnType<typeof inPlaceSource>,
  after: ReturnType<typeof inPlaceSource>,
) {
  const reads = (source: ReturnType<typeof inPlaceSource>) => {
    const values = new Map<string, [GlobalRecord['kind'], string, string | undefined]>();
    try {
      exportLegacy(
        [tooltip],
        now,
        undefined,
        {},
        {
          globalsInPlace: {
            ...source.options,
            onRead(kind, name, lang, body) {
              values.set(JSON.stringify([kind, name, lang]), [kind, name, body]);
            },
          },
        },
      );
    } catch {
      // A missing prior export is still attributable to the saved definition that supplies it.
    }
    return values;
  };
  const oldReads = reads(before);
  const newReads = reads(after);
  const causes = new Map<string, { id: string; name: string }>();
  for (const [key, [kind, name]] of new Map([...oldReads, ...newReads])) {
    if (oldReads.get(key)?.[2] === newReads.get(key)?.[2]) continue;
    const previous = before.entries.find((entry) => entry.kind === kind && entry.name === name);
    const current = after.entries.find((entry) => entry.kind === kind && entry.name === name);
    for (const entry of [previous, current]) {
      if (!entry || entry.tombstone) continue;
      causes.set(entry.id, {
        id: entry.id,
        name: after.entries.find(({ id }) => id === entry.id)?.name ?? entry.name,
      });
    }
  }
  return [...causes.values()];
}

export function bundleInPlaceReview(
  pub: Publisher,
  revision: string,
  tree: Tree,
  tooltips: Record<string, Tooltip>,
  fence: GlobalsInPlaceFence,
): GlobalsInPlaceReview {
  const live = pub.head(pub.options.liveBranch);
  if (!pub.git.ancestor(fence.migratedLive, live))
    throw new Error('LIVE has no in-place migration');
  const input = liveGlobalsInput(pub, live);
  assertInPlaceLibraries(input);
  const saved = inPlaceSource(pub, revision, fence);
  const released = reviewRevisions(pub, live, fence);
  const baseline = {
    entries: migrationBaseline(pub, fence),
    options: {
      definitions: legacyGlobalsInPlaceDefinitions(
        liveGlobalsInput(pub, fence.legacyLive).perks as Parameters<
          typeof legacyGlobalsInPlaceDefinitions
        >[0],
      ),
      missingTranslation: 'reject' as const,
    },
  };
  const sources = new Map([[revision, saved]]);
  const aliases = pub.aliasesAt(tree);
  const moves = pub.movesAt(tree);
  const now = pub.options.now();
  const rows: GlobalsInPlaceReview['rows'] = {};
  for (const tooltip of Object.values(tooltips)) {
    const { hash } = tooltip;
    if (globalsInPlaceLibraryText(hash) !== undefined || resolveAlias(hash, aliases) !== hash)
      continue;
    const before = input.perks[hash];
    const removed = isMovedInactive(hash, moves);
    if (!removed && isTextlessDescription(tooltip)) continue;
    let after;
    let refusal: string | undefined;
    try {
      if (!removed) {
        assertInPlaceDocuments([tooltip], saved.options);
        after = exportLegacy([tooltip], now, undefined, {}, { globalsInPlace: saved.options })[
          hash
        ];
      }
    } catch (error) {
      refusal = String(error);
    }
    const differs = !refusal && resolvedPrimaryDiffers(before, after);
    if (!differs && !refusal) continue;
    const prior = released.get(hash);
    if (prior && !sources.has(prior)) sources.set(prior, inPlaceSource(pub, prior, fence));
    rows[hash] = {
      differs,
      causes:
        !removed && before && 'editor' in before
          ? rowCauses(tooltip, now, prior ? sources.get(prior)! : baseline, saved)
          : [],
      diff: differs ? inPlaceDiff(before, after) : {},
      ...(refusal ? { refusal } : {}),
    };
  }
  return { revision, rows };
}
