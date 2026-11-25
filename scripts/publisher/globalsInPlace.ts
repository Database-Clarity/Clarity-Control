import {
  exportWithInactiveMoves,
  exportLegacy,
  globalPublishedSchema,
  activeAliases,
  composeGlobalRelease,
  effectiveSharedNotes,
  globalAggregateHash,
  globalReferenceSpans,
  globalsInPlaceDefinition,
  globalsInPlaceDefinitions,
  globalsInPlaceFenceSchema,
  globalsInPlaceLibraryText,
  globalsInPlacePath,
  globalsInPlaceSaveIssue,
  inPlaceLabelVariable,
  inPlaceLinkVariables,
  inPlaceReferenceIssue,
  plainInPlaceDestination,
  globalsReleasePaths,
  isLegacyAliasStub,
  isTextlessDescription,
  languages,
  legacyGlobalsInPlaceDefinitions,
  lowerConsumerMarkup,
  withImportedGlobalsFallback,
  publishableHashInput,
  protectCommentedGlobalImports,
  pushedSchema,
  reconcileGlobalStore,
  rewriteGlobalRenames as rewrite,
  rewriteTooltipGlobals as rewriteTooltip,
  resolveAlias,
  resolveGlobalsInPlace,
  stableStringify,
  UnpublishedGlobal,
  type Aliases,
  type GlobalRecord,
  type GlobalRename as Rename,
  type GlobalsInPlaceFence,
  type GlobalsInPlaceDefinitions,
  type GlobalsInPlaceOptions,
  type GlobalsPending,
  type GlobalStore,
  type PublishPayload,
  type InactiveMoves,
  type LegacyEntry,
  type LegacyCatalog,
  type Lang,
  type Tooltip,
} from '../../packages/core/src/index.js';
import { provesInPlace, type LegacyInput } from '../../packages/export/src/index.js';
import { variableReferences } from '../../packages/core/src/markup/braces.js';
import { removeMarkupComments } from '../../packages/core/src/markup/comments.js';
import { markupImports } from '../../packages/core/src/markup/prepare.js';
import { extractBlocks, extractVariables } from '../../packages/core/src/markup/syntax.js';
import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import { type Tree } from './git.js';
import { GlobalsPublisher } from './globals.js';
import { unloweredEntry } from './consumerOutput.js';
import { ConsumerOutputRejected, type Publisher, type Receipt } from './publisher.js';

export function globalsFence(pub: Publisher, tree: Tree): GlobalsInPlaceFence | undefined {
  if (!tree[globalsInPlacePath]) return undefined;
  const fence = globalsInPlaceFenceSchema.parse(pub.read(tree, globalsInPlacePath));
  if (fence.destination !== pub.options.liveBranch)
    throw new Error('The shared text migration belongs to another LIVE branch.');
  return fence;
}

export function activeGlobalsFence(pub: Publisher, tree: Tree) {
  const fence = globalsFence(pub, tree);
  if (!fence)
    throw new Error('Publication requires an active config/globals-in-place.json migration.');
  if (fence.state === 'active') return fence;
}

export function requireGlobalsMode(pub: Publisher, tree: Tree) {
  const fence = activeGlobalsFence(pub, tree);
  if (!fence) throw new Error('Publication is paused for the shared text migration.');
  return fence;
}

export function assertInPlaceRoots(hashes: readonly number[]) {
  if (hashes.some((hash) => globalsInPlaceLibraryText(hash) !== undefined))
    throw new Error('Publish shared definitions in Review → Globals.');
}

export function liveGlobalsInput(pub: Publisher, live: string): LegacyInput {
  const input = pub.read<LegacyInput>(pub.git.tree(live), 'liveDescriptions.json');
  if (!input?.perks || !input.databaseSettings) throw new Error('Invalid LIVE descriptions');
  return input;
}

function independentSecondary(cell: { main: string; secondary: string }) {
  return cell.secondary !== cell.main && cell.secondary.trim() !== 'import self';
}

export function historicalSecondaryUses(
  input: LegacyInput,
  definitions: GlobalsInPlaceDefinitions,
) {
  return Object.values(input.perks).flatMap((row) => {
    if (!('editor' in row) || globalsInPlaceLibraryText(row.hash) !== undefined) return [];
    return languages.flatMap((lang) => {
      const cell = row.editor[lang];
      if (!cell || !cell.secondary || !independentSecondary(cell)) return [];
      return (['variables', 'titles', 'exports'] as const).flatMap((kind) =>
        globalReferenceSpans(cell.secondary, kind).flatMap(({ name }) =>
          !(kind === 'variables' && name === 'e') && Object.hasOwn(definitions[kind] ?? {}, name)
            ? [{ hash: row.hash, lang, kind, name }]
            : [],
        ),
      );
    });
  });
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

function proofLibraries(live: LegacyInput, options: GlobalsInPlaceOptions, english?: Set<Lang>) {
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
        const selected = globalsInPlaceDefinition(entry, english?.has(lang) ? 'en' : lang);
        if (!selected) return [];
        const body = protectCommentedGlobalImports(selected.body);
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

export function publicationReaders(...inputs: LegacyInput[]) {
  const parents = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    if (!parents.has(to)) parents.set(to, new Set());
    parents.get(to)!.add(from);
  };
  for (const { perks } of inputs)
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
  return (roots: readonly number[]) => {
    const affected = new Set(roots.map(String));
    for (const root of affected) for (const parent of parents.get(root) ?? []) affected.add(parent);
    return affected;
  };
}

function affectedRows(before: LegacyInput, after: LegacyInput, roots: readonly number[]) {
  return publicationReaders(before, after)(roots);
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
  const publishedOnly = { definitions: options.definitions };
  for (const entry of Object.values(exported)) {
    if (isLegacyAliasStub(entry)) continue;
    for (const [lang, cell] of Object.entries(entry.editor))
      for (const value of new Set([cell.main, cell.secondary]))
        if (
          resolveGlobalsInPlace(
            value,
            cell.englishFallback ? 'en' : (lang as Lang),
            publishedOnly,
          ) !== value
        )
          throw new Error(
            `Tooltip ${entry.name || entry.hash} (${lang}) still reads shared text after export.`,
          );
  }
  const raw = exportGlobalsProof(documents, now, pub.options.facts, aliases, moves, options);
  // `moves` adds the selected cleared removals to the stored ones.
  const allMoves = { ...pub.movesAt(tree), ...moves };
  const merge = (entries: Receipt['exported']) => {
    try {
      return pub.mergePublicationPerks(
        tree,
        live.perks,
        entries,
        hashes,
        allMoves,
      ) as LegacyInput['perks'];
    } catch (error) {
      throw new ConsumerOutputRejected(String(error));
    }
  };
  proveInPlaceInputs(
    live,
    { ...live, perks: merge(raw) },
    { ...live, perks: merge(exported) },
    options,
    hashes,
  );
}

export function exportGlobalsProof(
  documents: readonly Tooltip[],
  now: number,
  facts: LegacyCatalog | undefined,
  aliases: Aliases,
  moves: InactiveMoves,
  globalsInPlace: GlobalsInPlaceOptions,
) {
  return exportWithInactiveMoves(documents, now, facts, aliases, moves, {
    globalsInPlace,
    preserveGlobalReferencesForProof: true,
  });
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
  const affected = affectedRows(before, after, hashes);
  const english = new Set<Lang>();
  const fallbacks = new Map<string, Set<Lang>>();
  const fallbackBefore = { ...after, perks: { ...after.perks } };
  // The English baseline needs the raw English cells of numeric import targets,
  // including targets that do not otherwise fall back.
  for (const hash of affected) {
    const localized = before.perks[hash];
    const filled = after.perks[hash];
    if (!localized || !filled || !('editor' in localized) || !('editor' in filled)) continue;
    const localizedEditor = { ...localized.editor };
    const fallbackEditor = { ...filled.editor, en: localized.editor.en };
    const flagged = new Set<Lang>();
    for (const lang of languages) {
      if (!filled.editor[lang]?.englishFallback) continue;
      english.add(lang);
      flagged.add(lang);
      localizedEditor[lang] = filled.editor[lang];
      fallbackEditor[lang] = localized.editor[lang];
    }
    if (flagged.size) {
      fallbacks.set(hash, flagged);
      before.perks[hash] = { ...localized, editor: localizedEditor };
    }
    fallbackBefore.perks[hash] = { ...filled, editor: fallbackEditor };
  }
  const prove = (baseline: LegacyInput, includes?: (hash: string, lang: Lang) => boolean) => {
    const [failure] = provesInPlace(baseline, after, affected, includes);
    if (failure) throw new Error(failure.message);
  };
  if (!english.size) return prove(before);
  const aliasSource = (hash: string) => {
    const visited = new Set<string>();
    let row = after.perks[hash];
    while (row && 'aliasOf' in row && !visited.has(hash)) {
      visited.add(hash);
      hash = String(row.aliasOf);
      row = after.perks[hash];
    }
    return hash;
  };
  const fallsBack = (hash: string, lang: Lang) =>
    fallbacks.get(aliasSource(hash))?.has(lang) ?? false;
  prove(before, (hash, lang) => !fallsBack(hash, lang));
  Object.assign(fallbackBefore.perks, proofLibraries(live, options, english));
  prove(fallbackBefore, fallsBack);
}

export function sharedVariableLabelIssue(source: string, names: ReadonlySet<string>) {
  const name = inPlaceLabelVariable(source, names);
  if (name)
    return `Shared variables can't be used inside a title or link label: #${name}. Move it outside the tag.`;
}

function variableNames({ definitions, unavailable }: GlobalsInPlaceOptions) {
  return new Set([...Object.keys(definitions.variables ?? {}), ...(unavailable?.variables ?? [])]);
}

export function assertLinkVariableValues(
  source: string,
  context: string,
  variables: GlobalsInPlaceOptions['definitions']['variables'],
  names: ReadonlySet<string>,
) {
  for (const name of inPlaceLinkVariables(source))
    if (variables && Object.hasOwn(variables, name))
      for (const [lang, { body }] of Object.entries(variables[name]))
        if (!plainInPlaceDestination(body, names))
          throw new Error(
            `${context} uses #${name} as a link destination. Give ${name} a plain, single-line destination in ${lang} without brackets, tags, or shared variables.`,
          );
}

export function assertInPlaceDocuments(
  documents: readonly Tooltip[],
  options: GlobalsInPlaceOptions,
) {
  assertInPlaceRoots(documents.map(({ hash }) => hash));
  const titleNames = new Set([
    ...Object.keys(options.definitions.titles ?? {}),
    ...(options.unavailable?.titles ?? []),
  ]);
  const names = variableNames(options);
  const publishedNames = new Set(Object.keys(options.definitions.variables ?? {}));
  for (const tooltip of documents)
    for (const [lang, cell] of Object.entries(tooltip.text)) {
      const context = `Tooltip ${tooltip.custom?.name || tooltip.hash} (${lang})`;
      const issue =
        sharedVariableLabelIssue(cell.text, names) ??
        inPlaceReferenceIssue(cell.text, names, titleNames) ??
        globalsInPlaceSaveIssue(cell.text, titleNames);
      if (issue) throw new Error(`${context}: ${issue}`);
      assertLinkVariableValues(cell.text, context, options.definitions.variables, publishedNames);
    }
}

type Selection = NonNullable<PublishPayload['globals']>;
const refusalMessage = (error: unknown) =>
  error instanceof ZodError
    ? (error.issues[0]?.message ?? 'Invalid shared definition.')
    : error instanceof Error
      ? error.message
      : String(error);
const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');
const definitionDigest = (entry: GlobalRecord) => sha256(stableStringify(entry));

export function inPlaceStores(pub: Publisher, tree: Tree) {
  const published = globalPublishedSchema.parse(
    pub.read(tree, globalsReleasePaths.published(pub.options.liveBranch)),
  );
  if (published.destination !== pub.options.liveBranch)
    throw new Error('Published global destination mismatch.');
  return { published, saved: new GlobalsPublisher(pub).store(tree) };
}

export function publishedGlobals(pub: Publisher, tree: Tree) {
  const { published, saved } = inPlaceStores(pub, tree);
  return releaseOptions(published.store, saved);
}

export function releaseOptions(published: GlobalStore, saved: GlobalStore): GlobalsInPlaceOptions {
  const definitions = globalsInPlaceDefinitions(published.entries);
  const unavailable = {
    exports: new Set<string>(),
    variables: new Set<string>(),
    titles: new Set<string>(),
  };
  for (const entry of saved.entries)
    if (!entry.tombstone && !Object.hasOwn(definitions[entry.kind] ?? {}, entry.name))
      unavailable[entry.kind].add(entry.name);
  return { definitions, unavailable };
}

export function authoredInPlaceOptions(
  pub: Publisher,
  tree: Tree,
  live: LegacyInput,
  plan: Pick<ReturnType<typeof planInPlaceRelease>, 'options' | 'rewritten'>,
  documents: readonly Tooltip[],
  aliases: Aliases,
) {
  const drafts = new Map(documents.map((doc) => [doc.hash, doc]));
  return withImportedGlobalsFallback(plan.options, (hash) => {
    const canonical = resolveAlias(hash, aliases);
    const draft = drafts.get(canonical);
    if (draft) return { document: draft, draft: true };
    const row = live.perks[hash];
    if (!row) return;
    const published = 'aliasOf' in row ? row.aliasOf : hash;
    const document =
      plan.rewritten.get(published) ?? pub.read<Tooltip>(tree, `live/tooltips/${published}.json`);
    if (document) return { document };
  });
}

export function assertScheduledGlobalNames(
  documents: readonly Tooltip[],
  plan: ReturnType<typeof planInPlaceRelease>,
) {
  for (const entry of plan.published.store.entries) {
    const retired = new Set(
      entry.nameHistory
        .map(({ name }) => name)
        .filter((name) => !Object.hasOwn(plan.options.definitions[entry.kind] ?? {}, name)),
    );
    if (!retired.size) continue;
    for (const tooltip of documents)
      for (const cell of Object.values(tooltip.text)) {
        const reference = globalReferenceSpans(cell.text, entry.kind).find(({ name }) =>
          retired.has(name),
        );
        if (reference)
          throw new Error(
            `Tooltip ${tooltip.hash} uses the former shared name ${reference.name}. Return the batch to draft and schedule it again with ${entry.name}.`,
          );
      }
  }
}

function renamesOf(published: GlobalStore, selected: readonly GlobalRecord[]): Rename[] {
  return selected.flatMap((entry) => {
    const previous = published.entries.find(({ id }) => id === entry.id);
    return previous && !previous.tombstone && previous.name !== entry.name && !entry.tombstone
      ? [{ kind: entry.kind, from: previous.name, to: entry.name }]
      : [];
  });
}

function rewriteEntries(entries: readonly GlobalRecord[], renames: readonly Rename[]) {
  return entries.map((entry) => {
    if (entry.tombstone) return entry;
    const copy = structuredClone(entry);
    const renamed = renames.find(({ kind, from }) => kind === copy.kind && from === copy.name);
    if (renamed) copy.name = renamed.to;
    for (const definition of Object.values(copy.definitions))
      definition.body = rewrite(definition.body, renames);
    return copy;
  });
}

function sourceIdentity(entry: GlobalRecord | undefined) {
  if (!entry || entry.tombstone) return null;
  return {
    name: entry.name,
    definitions: Object.fromEntries(
      Object.entries(entry.definitions).map(([lang, definition]) => [
        lang,
        [definition.body, globalsInPlaceDefinition(entry.definitions, lang as Lang) !== undefined],
      ]),
    ),
  };
}

function pendingEntries(published: GlobalStore, saved: GlobalStore) {
  const renames = renamesOf(published, saved.entries);
  const normalized = rewriteEntries(published.entries, renames);
  return saved.entries.filter((entry) => {
    const old = published.entries.find(({ id }) => id === entry.id);
    if (old && old.name !== entry.name && !old.tombstone && !entry.tombstone) return true;
    return (
      stableStringify(sourceIdentity(normalized.find(({ id }) => id === entry.id))) !==
      stableStringify(sourceIdentity(entry))
    );
  });
}

function publishedDocuments(
  pub: Publisher,
  tree: Tree,
  live: LegacyInput,
  requireSnapshots = true,
): Tooltip[] {
  const docs = new GlobalsPublisher(pub).documents(tree, 'live/tooltips');
  return Object.entries(live.perks).flatMap(([hash, perk]) => {
    if (globalsInPlaceLibraryText(Number(hash)) !== undefined || !('editor' in perk)) return [];
    const doc = docs[hash];
    if (!doc) {
      if (requireSnapshots) throw new Error(`Missing the published source for tooltip ${hash}.`);
      return [];
    }
    return isTextlessDescription(doc) ? [] : [doc];
  });
}

function withdrawsEnglish(entry: GlobalRecord, previous: GlobalRecord | undefined) {
  return !!entry.tombstone || (!!previous?.definitions.en && !entry.definitions.en);
}

export function assertHistoricalSecondaries(
  pub: Publisher,
  tree: Tree,
  live: LegacyInput,
  selected: readonly GlobalRecord[],
  language?: Lang,
) {
  if (
    !Object.values(live.perks).some(
      (row) =>
        'editor' in row &&
        Object.values(row.editor).some((cell) => cell.secondary && independentSecondary(cell)),
    )
  )
    return;
  const fence = globalsFence(pub, tree);
  if (!fence) return;
  const legacy = liveGlobalsInput(pub, fence.legacyLive);
  const definitions = legacyGlobalsInPlaceDefinitions(
    legacy.perks as Parameters<typeof legacyGlobalsInPlaceDefinitions>[0],
  );
  for (const { hash, lang, kind, name } of historicalSecondaryUses(legacy, definitions)) {
    if (language && lang !== language) continue;
    const row = live.perks[hash];
    const active = row && 'editor' in row ? row.editor[lang] : undefined;
    if (!active?.secondary || !independentSecondary(active)) continue;
    const entry = selected.find(
      (item) =>
        item.kind === kind &&
        (item.name === name || item.nameHistory.some((former) => former.name === name)),
    );
    if (entry)
      throw new Error(
        `Publish ${row.name || hash} first: its older text still uses ${entry.name}.`,
      );
  }
}

export function refillLanguage(
  current: LegacyEntry['editor'][Lang],
  approved: LegacyEntry['editor'][Lang],
) {
  if (!current || !approved || current.secondary === current.main) return approved;
  return { ...approved, secondary: current.secondary };
}

export function withdrawalIssue(
  selected: GlobalRecord,
  previous: GlobalRecord | undefined,
  saved: GlobalStore,
  published: GlobalStore,
  documents: readonly Tooltip[],
) {
  if (!previous || previous.tombstone) return;
  const names = new Set([selected.name, previous.name]);
  const empty = new Set<string>();
  const reads = (text: string) =>
    globalReferenceSpans(text, selected.kind).some(({ name }) => names.has(name)) ||
    !!inPlaceReferenceIssue(
      text,
      selected.kind === 'variables' ? names : empty,
      selected.kind === 'titles' ? names : empty,
    ) ||
    (selected.kind === 'titles' &&
      text.includes('<title') &&
      text.includes('#') &&
      effectiveSharedNotes(lowerConsumerMarkup(text), { variables: '', titles: '' }, names).length >
        0);
  const reader = documents.find((doc) => Object.values(doc.text).some((cell) => reads(cell.text)));
  if (reader) return `Tooltip ${reader.custom?.name || reader.hash} still uses ${selected.name}.`;
  const dependency = [...saved.entries, ...published.entries].find(
    (entry) =>
      entry.id !== selected.id &&
      !entry.tombstone &&
      Object.values(entry.definitions).some((cell) => reads(cell.body)),
  );
  if (dependency) return `${dependency.name} still uses ${selected.name}.`;
}

function selectedRelease(
  pub: Publisher,
  tree: Tree,
  live: LegacyInput,
  selection: Selection,
  maintainer: boolean,
) {
  const { published, saved } = inPlaceStores(pub, tree);
  if (!selection.length)
    return {
      options: releaseOptions(published.store, saved),
      published,
      refills: {},
      rewritten: new Map<number, Tooltip>(),
    };
  const previous = new Map(published.store.entries.map((entry) => [entry.id, entry]));
  const selected = selection.map(({ id, expected }) => {
    const entry = saved.entries.find((candidate) => candidate.id === id);
    if (!entry || definitionDigest(entry) !== expected)
      throw new Error(`Shared definition ${entry?.name || id} changed. Review it again.`);
    if (withdrawsEnglish(entry, previous.get(id)) && !maintainer)
      throw new Error(`Only a maintainer can publish the removal of ${entry.name}.`);
    return entry;
  });
  assertHistoricalSecondaries(pub, tree, live, selected);
  const liveDocs = publishedDocuments(pub, tree, live);
  const globals = new GlobalsPublisher(pub);
  const withdrawals = selected.filter((entry) => withdrawsEnglish(entry, previous.get(entry.id)));
  const removalDocs = withdrawals.length
    ? [
        ...liveDocs,
        ...Object.values(globals.documents(tree, 'tooltips')),
        ...globals.upcoming(tree).flatMap(Object.values),
      ]
    : [];
  for (const entry of withdrawals) {
    const issue = withdrawalIssue(
      entry,
      previous.get(entry.id),
      saved,
      published.store,
      removalDocs,
    );
    if (issue) throw new Error(issue);
  }

  const renames = renamesOf(published.store, selected);
  const changedVariables = new Set<string>();
  const changedTitles = new Set<string>();
  for (const entry of selected) {
    const old = previous.get(entry.id);
    if (old && !old.tombstone && !entry.tombstone && old.name === entry.name) continue;
    const names =
      entry.kind === 'variables'
        ? changedVariables
        : entry.kind === 'titles'
          ? changedTitles
          : undefined;
    names?.add(entry.name);
    if (old && !old.tombstone) names?.add(old.name);
  }
  if (changedVariables.size || changedTitles.size) {
    const check = (source: string, context: string) => {
      const issue = inPlaceReferenceIssue(source, changedVariables, changedTitles);
      if (issue) throw new Error(`${context}: ${issue}`);
    };
    for (const doc of liveDocs)
      for (const [lang, { text }] of Object.entries(doc.text))
        check(text, `Tooltip ${doc.custom?.name || doc.hash} (${lang})`);
    for (const entry of published.store.entries)
      if (!entry.tombstone)
        for (const [lang, { body }] of Object.entries(entry.definitions))
          check(body, `${entry.name} (${lang})`);
  }
  for (const entry of selected) {
    const to = entry.name;
    const old = previous.get(entry.id);
    if (entry.tombstone || (old && !old.tombstone && old.name === to)) continue;
    const variable = entry.kind === 'variables';
    const rename = old && !old.tombstone;
    if (!variable && (entry.kind !== 'titles' || !rename)) continue;
    const name = new Set([to]);
    const conflicts = (source: string) => {
      if (variable && inPlaceLabelVariable(source, name, to) !== undefined) return true;
      if (!rename) return false;
      const text = removeMarkupComments(source);
      if (!text.includes(to)) return false;
      if (!variable)
        return (
          Object.hasOwn(extractBlocks(text, 'title'), to) ||
          globalReferenceSpans(source, 'titles').some(({ name }) => name === to)
        );
      return (
        Object.hasOwn(extractVariables(text), to) ||
        variableReferences(text).some(({ name }) => name === to)
      );
    };
    const reason = rename
      ? `already uses or declares ${to}. Choose a different name.`
      : `already uses #${to} inside a title or link. Choose a different name.`;
    for (const tooltip of liveDocs)
      for (const cell of Object.values(tooltip.text))
        if (conflicts(cell.text))
          throw new Error(`Tooltip ${tooltip.custom?.name || tooltip.hash} ${reason}`);
    // A neutral note rename does not rewrite LIVE. A former name can therefore still be a
    // generated local title in LIVE, even after every authored reference has been rewritten.
    const formerTitle =
      old?.kind === 'titles' &&
      old.nameHistory.some(({ name }) => name === to) &&
      !published.store.entries.some(
        (other) => other.kind === 'titles' && other.name === to && !other.tombstone,
      );
    const priorRename: Rename[] = [{ kind: 'titles', from: old?.name ?? '', to }];
    let priorOptions: GlobalsInPlaceOptions | undefined;
    const priorDocument = (hash: number) => {
      const row = live.perks[hash];
      const doc = liveDocs.find(
        (doc) => doc.hash === (row && 'aliasOf' in row ? row.aliasOf : hash),
      );
      if (doc) return rewriteTooltip(doc, priorRename);
    };
    for (const row of Object.values(live.perks)) {
      if (!('editor' in row)) continue;
      for (const lang of languages) {
        const cell = row.editor[lang];
        if (!cell || (!conflicts(cell.main) && !conflicts(cell.secondary))) continue;
        const doc = formerTitle && priorDocument(row.hash);
        if (doc && (!independentSecondary(cell) || !conflicts(cell.secondary))) {
          priorOptions ??= withImportedGlobalsFallback(
            {
              definitions: globalsInPlaceDefinitions(
                rewriteEntries(published.store.entries, priorRename),
              ),
            },
            (hash) => {
              const document = priorDocument(hash);
              if (document) return { document };
            },
          );
          try {
            const filled = exportLegacy([doc], 0, undefined, {}, { globalsInPlace: priorOptions })[
              doc.hash
            ];
            if (!isLegacyAliasStub(filled) && filled.editor[lang]?.main === cell.main) continue;
          } catch {
            // A source that cannot be reproduced cannot establish where the LIVE title came from.
          }
        }
        if (formerTitle)
          throw new Error(
            `Tooltip ${row.name || row.hash} (${lang}) uses or declares ${to} in LIVE text that could not be reproduced from the published note. Republish the tooltip before renaming.`,
          );
        throw new Error(`Tooltip ${row.name || row.hash} ${reason}`);
      }
    }
    for (const publishedEntry of published.store.entries)
      if (
        !publishedEntry.tombstone &&
        Object.values(publishedEntry.definitions).some(({ body }) => conflicts(body))
      )
        throw new Error(`Shared definition ${publishedEntry.name} ${reason}`);
  }
  const beforeEntries = rewriteEntries(published.store.entries, renames);
  const before = reconcileGlobalStore(
    [
      ...published.store.aggregates,
      ...saved.aggregates.filter(
        (item) =>
          !published.store.aggregates.some((old) => old.document.hash === item.document.hash) &&
          selected.some((entry) => globalAggregateHash(entry.kind) === item.document.hash),
      ),
    ],
    beforeEntries,
  );
  const next = composeGlobalRelease(
    before,
    saved,
    selected.map(({ id }) => id),
  );
  const options = releaseOptions(next, saved);
  const names = variableNames(options);
  const titleNames = new Set([
    ...Object.keys(options.definitions.titles ?? {}),
    ...(options.unavailable?.titles ?? []),
  ]);
  const publishedNames = new Set(Object.keys(options.definitions.variables ?? {}));
  for (const { kind, from } of renames) {
    if (kind === 'variables') names.add(from);
    if (kind === 'titles') titleNames.add(from);
  }
  const rewritten = new Map<number, Tooltip>();
  const updatedDocs = liveDocs.map((prior) => {
    const doc = renames.length ? rewriteTooltip(prior, renames) : prior;
    if (doc !== prior) rewritten.set(doc.hash, doc);
    return doc;
  });
  if (selected.some(({ kind }) => kind === 'variables')) {
    for (const tooltip of updatedDocs)
      for (const [lang, cell] of Object.entries(tooltip.text))
        assertLinkVariableValues(
          cell.text,
          `Tooltip ${tooltip.custom?.name || tooltip.hash} (${lang})`,
          options.definitions.variables,
          publishedNames,
        );
  }
  // A named export or note can also supply a link to published tooltips.
  for (const entry of next.entries)
    if (!entry.tombstone)
      for (const [lang, { body }] of Object.entries(entry.definitions))
        assertLinkVariableValues(
          body,
          `Shared definition ${entry.name} (${lang})`,
          options.definitions.variables,
          publishedNames,
        );
  for (const entry of selected) {
    if (entry.tombstone) continue;
    for (const [lang, { body }] of Object.entries(entry.definitions)) {
      const issue =
        sharedVariableLabelIssue(body, names) ?? inPlaceReferenceIssue(body, names, titleNames);
      if (issue) throw new Error(`${entry.name} (${lang}): ${issue}`);
      for (const kind of ['exports', 'variables', 'titles'] as const) {
        const unavailable = options.unavailable?.[kind];
        if (!unavailable?.size) continue;
        const reference = globalReferenceSpans(body, kind).find(({ name }) =>
          unavailable.has(name),
        );
        if (reference) throw new Error(`Publish the shared change for ${reference.name} first.`);
      }
    }
  }
  const publishedDocs = new Map(updatedDocs.map((doc) => [doc.hash, doc]));
  const source = (hash: number) => {
    const row = live.perks[hash];
    const document = publishedDocs.get(row && 'aliasOf' in row ? row.aliasOf : hash);
    if (document) return { document };
  };
  const oldOptions = withImportedGlobalsFallback(
    { definitions: globalsInPlaceDefinitions(before.entries) },
    source,
  );
  const publishedOptions = withImportedGlobalsFallback(
    { definitions: options.definitions },
    source,
  );
  const refills = refillPublishedDocuments(live, live, updatedDocs, oldOptions, publishedOptions);
  return { options, published: { ...published, store: next }, refills, rewritten };
}

export function refillPublishedDocuments(
  live: LegacyInput,
  withAuthoredRows: LegacyInput,
  documents: readonly Tooltip[],
  oldOptions: GlobalsInPlaceOptions,
  publishedOptions: GlobalsInPlaceOptions,
  language?: Lang,
) {
  const affected: Tooltip[] = [];
  const changedLanguages = new Map<number, Lang[]>();
  const refills: Receipt['exported'] = {};
  const expectedBefore = { ...live, perks: { ...live.perks } };
  for (const doc of documents) {
    const old = exportLegacy([doc], 0, undefined, {}, { globalsInPlace: oldOptions })[doc.hash];
    const filled = exportLegacy([doc], 0, undefined, {}, { globalsInPlace: publishedOptions })[
      doc.hash
    ];
    if (
      isLegacyAliasStub(old) ||
      isLegacyAliasStub(filled) ||
      stableStringify(old.editor) === stableStringify(filled.editor)
    )
      continue;
    const perk = live.perks[doc.hash] as unknown as LegacyEntry;
    const changed = (language ? [language] : languages).filter(
      (lang) =>
        stableStringify(old.editor[lang] ?? null) !== stableStringify(filled.editor[lang] ?? null),
    );
    if (!changed.length) continue;
    affected.push(doc);
    changedLanguages.set(doc.hash, changed);
    const editor = { ...perk.editor };
    const beforeEditor = { ...perk.editor };
    for (const lang of changed) {
      editor[lang] = refillLanguage(perk.editor[lang], filled.editor[lang]);
      beforeEditor[lang] = refillLanguage(perk.editor[lang], old.editor[lang]);
    }
    expectedBefore.perks[doc.hash] = {
      ...live.perks[doc.hash],
      editor: beforeEditor,
    } as LegacyInput['perks'][string];
    refills[doc.hash] = { ...perk, editor };
  }
  if (affected.length) {
    const unlowered = unloweredEntry(refills);
    if (unlowered !== undefined)
      throw new Error(`The export of tooltip ${unlowered} still holds unlowered markup.`);
    const hashes = affected.map(({ hash }) => hash);
    const [drift] = provesInPlace(live, expectedBefore, affectedRows(live, expectedBefore, hashes));
    if (drift) throw new Error(drift.message);
    assertInPlaceDocuments(affected, publishedOptions);
    const raw = exportGlobalsProof(affected, 0, undefined, {}, {}, publishedOptions);
    const rawPerks = { ...withAuthoredRows.perks };
    for (const { hash } of affected) {
      const existing = rawPerks[hash],
        source = raw[hash];
      if (!('editor' in existing) || isLegacyAliasStub(source))
        throw new Error(`Missing shared text proof input for ${hash}.`);
      const changed = changedLanguages.get(hash)!;
      const editor = { ...existing.editor };
      for (const lang of changed)
        editor[lang] = refillLanguage(existing.editor[lang], source.editor[lang]);
      rawPerks[hash] = { ...existing, editor };
    }
    proveInPlaceInputs(
      withAuthoredRows,
      { ...withAuthoredRows, perks: rawPerks },
      {
        ...withAuthoredRows,
        perks: { ...withAuthoredRows.perks, ...refills } as LegacyInput['perks'],
      },
      publishedOptions,
      hashes,
    );
  }
  return refills;
}

/** A selected author's fallback can change the language read by its published importers. */
export function refillImportedTooltips(
  pub: Publisher,
  tree: Tree,
  plan: ReturnType<typeof planInPlaceRelease> & { live: LegacyInput },
  documents: readonly Tooltip[],
  aliases: Aliases,
  exported: Receipt['exported'],
) {
  const roots = documents.flatMap(({ hash }) => {
    const previous = plan.live.perks[hash];
    const next = exported[hash];
    return previous &&
      'editor' in previous &&
      next &&
      !isLegacyAliasStub(next) &&
      languages.some(
        (lang) => previous.editor[lang]?.englishFallback !== next.editor[lang]?.englishFallback,
      )
      ? [hash]
      : [];
  });
  if (!roots.length) return;
  const withAuthoredRows = {
    ...plan.live,
    perks: { ...plan.live.perks, ...exported } as LegacyInput['perks'],
  };
  const importers = affectedRows(plan.live, withAuthoredRows, roots);
  // English output can hide a different import in the published translation.
  for (const document of publishedDocuments(pub, tree, plan.live, false)) {
    const row = plan.live.perks[document.hash];
    if (
      'editor' in row &&
      languages.some(
        (lang) =>
          row.editor[lang]?.englishFallback && document.text[lang]?.text.includes('import '),
      )
    )
      importers.add(String(document.hash));
  }
  const selected = new Set(documents.map(({ hash }) => hash));
  const snapshots = [...importers].flatMap((key) => {
    const hash = Number(key);
    const row = plan.live.perks[hash];
    if (selected.has(hash) || !row || !('editor' in row)) return [];
    const snapshot =
      plan.rewritten.get(hash) ?? pub.read<Tooltip>(tree, `live/tooltips/${hash}.json`);
    if (!snapshot) throw new Error(`Missing the published source for tooltip ${hash}.`);
    return isTextlessDescription(snapshot) ? [] : [snapshot];
  });
  if (!snapshots.length) return;
  const options = { definitions: plan.options.definitions };
  const before = authoredInPlaceOptions(pub, tree, plan.live, { ...plan, options }, [], {});
  const after = authoredInPlaceOptions(
    pub,
    tree,
    plan.live,
    { ...plan, options },
    documents,
    aliases,
  );
  const refills = refillPublishedDocuments(plan.live, withAuthoredRows, snapshots, before, after);
  Object.assign(plan.refills, refills);
  plan.live = { ...plan.live, perks: { ...plan.live.perks, ...refills } as LegacyInput['perks'] };
}

export function planInPlaceRelease(
  pub: Publisher,
  tree: Tree,
  live: LegacyInput,
  selection: Selection,
  maintainer: boolean,
  hasTooltipSelection = false,
) {
  const plan = (items: Selection) => selectedRelease(pub, tree, live, items, maintainer);
  const refusals: { id: string; error: string }[] = [];
  try {
    return { ...plan(selection), globals: selection.map(({ id }) => id), refusals };
  } catch (error) {
    if (selection.length < 2 && !hasTooltipSelection) throw error;
    // A failed choice cannot stop independent definitions in the same signed part.
    const accepted: Selection = [];
    let result = plan(accepted);
    let pending = [...selection].sort((a, b) => a.id.localeCompare(b.id));
    while (pending.length) {
      const retry: Selection = [];
      refusals.length = 0;
      for (const item of pending) {
        try {
          result = plan([...accepted, item]);
          accepted.push(item);
        } catch (refusal) {
          retry.push(item);
          refusals.push({ id: item.id, error: refusalMessage(refusal) });
        }
      }
      if (retry.length === pending.length) break;
      pending = retry;
    }
    if (!accepted.length && !hasTooltipSelection) throw error;
    return { ...result, globals: accepted.map(({ id }) => id), refusals };
  }
}

/** Replace the generic dependency advice when the named rename itself would be refused. */
export function inPlacePublishError(
  error: unknown,
  pub: Publisher,
  tree: Tree,
  live: LegacyInput,
  plan: ReturnType<typeof planInPlaceRelease>,
) {
  const dependency = error instanceof Error ? error.cause : undefined;
  if (!(dependency instanceof UnpublishedGlobal)) return String(error);
  const { kind, globalName } = dependency;
  const { published, saved } = inPlaceStores(pub, tree);
  const entry = saved.entries.find(
    (entry) => !entry.tombstone && entry.kind === kind && entry.name === globalName,
  );
  const previous = entry && published.store.entries.find(({ id }) => id === entry.id);
  if (!entry || !previous || previous.tombstone || previous.name === entry.name)
    return String(error);
  const refused = plan.refusals.find(({ id }) => id === entry.id);
  if (refused) return `The rename to ${globalName} cannot be published. ${refused.error}`;
  try {
    selectedRelease(pub, tree, live, [{ id: entry.id, expected: definitionDigest(entry) }], true);
  } catch (reason) {
    return `The rename to ${globalName} cannot be published. ${refusalMessage(reason)}`;
  }
  return String(error);
}

/** Rewrite an existing marker using the same alias inputs as its last authored publish. */
export function rewritePushed(
  pub: Publisher,
  tree: Tree,
  pushed: Record<string, string>,
  rewritten: ReadonlyMap<number, Tooltip>,
) {
  if (!rewritten.size) return;
  const aliases = activeAliases(pub.aliasesAt(tree), pub.movesAt(tree));
  for (const [hash, doc] of rewritten) {
    const old = pub.read<Tooltip>(tree, `live/tooltips/${hash}.json`)!;
    for (const context of [aliases, {}]) {
      if (pushed[hash] !== sha256(publishableHashInput(old, context))) continue;
      pushed[hash] = sha256(publishableHashInput(doc, context));
      break;
    }
  }
}

export function neutralRenameHashes(
  pub: Publisher,
  tree: Tree,
  entries: readonly { hash: number; digest: string }[],
  rewritten: ReadonlyMap<number, Tooltip>,
) {
  if (!rewritten.size) return new Set<number>();
  const pushed = pushedSchema.parse(pub.read(tree, 'live/pushed.json'));
  rewritePushed(pub, tree, pushed, rewritten);
  const text = ({ text }: Tooltip) =>
    Object.fromEntries(Object.entries(text).map(([lang, cell]) => [lang, cell.text]));
  return new Set(
    entries
      .filter(({ hash, digest }) => {
        const published = rewritten.get(hash);
        if (!published || pushed[hash] !== digest) return false;
        const saved = pub.read<Tooltip>(tree, `tooltips/${hash}.json`);
        return saved && stableStringify(text(saved)) === stableStringify(text(published));
      })
      .map(({ hash }) => hash),
  );
}

export function bundleInPlaceReview(
  pub: Publisher,
  tree: Tree,
  fence: GlobalsInPlaceFence,
  current = new GlobalsPublisher(pub).documents(tree, 'tooltips'),
) {
  const live = pub.head(pub.options.liveBranch);
  if (!pub.git.ancestor(fence.migratedLive, live))
    throw new Error('LIVE has no in-place migration');
  const input = liveGlobalsInput(pub, live);
  assertInPlaceLibraries(input);
  const { published, saved } = inPlaceStores(pub, tree);
  const targets = new Set<number>();
  const collect = (text: string) => {
    if (!text.includes('import ')) return;
    for (const line of markupImports(text.replace(/\r/g, ''))) {
      const hash = / from (\d+) *$/.exec(line)?.[1];
      if (hash) targets.add(Number(hash));
    }
  };
  for (const tooltip of Object.values(current))
    for (const { text } of Object.values(tooltip.text)) collect(text);
  for (const row of Object.values(input.perks))
    if ('editor' in row)
      for (const cell of Object.values(row.editor)) {
        collect(cell.main);
        if (cell.secondary !== cell.main) collect(cell.secondary);
      }
  for (const entry of [...published.store.entries, ...saved.entries])
    for (const { body } of Object.values(entry.definitions)) collect(body);
  const reviewImports: Record<string, Tooltip> = {};
  for (const hash of targets) {
    if (globalsInPlaceLibraryText(hash) !== undefined) continue;
    const row = input.perks[hash];
    if (!row) continue;
    const canonical = 'aliasOf' in row ? row.aliasOf : hash;
    const document = pub.read<Tooltip>(tree, `live/tooltips/${canonical}.json`);
    if (document) reviewImports[hash] = document;
  }
  const pending = pendingEntries(published.store, saved);
  const globalsPending: GlobalsPending = pending.map((entry) => {
    const previous = published.store.entries.find(({ id }) => id === entry.id);
    const renamed =
      previous && !previous.tombstone && !entry.tombstone && previous.name !== entry.name;
    const digest = definitionDigest(entry);
    let affected: number[] = [];
    let refusal: string | undefined;
    let renameOnly = false;
    try {
      const plan = planInPlaceRelease(pub, tree, input, [{ id: entry.id, expected: digest }], true);
      affected = [...new Set([...Object.keys(plan.refills).map(Number), ...plan.rewritten.keys()])];
      renameOnly =
        !!renamed &&
        Object.keys(plan.refills).length === 0 &&
        stableStringify(sourceIdentity({ ...previous, name: entry.name })) ===
          stableStringify(sourceIdentity(entry));
    } catch (error) {
      refusal = refusalMessage(error);
    }
    const cell = (value: GlobalRecord | undefined, lang: Lang) =>
      value?.tombstone ? null : (value?.definitions[lang]?.body ?? null);
    return {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      ...(renamed ? { previousName: previous.name } : {}),
      ...(renameOnly ? { renameOnly: true as const } : {}),
      change: entry.tombstone
        ? 'removed'
        : !previous || previous.tombstone
          ? 'new'
          : previous.name !== entry.name
            ? 'renamed'
            : 'changed',
      digest,
      affected,
      languages: Object.fromEntries(
        languages.flatMap((lang) => {
          const before = cell(previous, lang),
            after = cell(entry, lang);
          const beforeAvailable =
            !!previous &&
            !previous.tombstone &&
            !!globalsInPlaceDefinition(previous.definitions, lang);
          const afterAvailable =
            !entry.tombstone && !!globalsInPlaceDefinition(entry.definitions, lang);
          return before !== after ||
            beforeAvailable !== afterAvailable ||
            (previous?.name !== entry.name && (before !== null || after !== null))
            ? [
                [
                  lang,
                  {
                    before,
                    after,
                    ...((before !== null && !beforeAvailable) || (after !== null && !afterAvailable)
                      ? { beforeAvailable, afterAvailable }
                      : {}),
                  },
                ],
              ]
            : [];
        }),
      ),
      ...(refusal ? { refusal } : {}),
    };
  });
  const pushed = pushedSchema.parse(pub.read(tree, 'live/pushed.json'));
  const renames = renamesOf(published.store, pending);
  const rewritten = new Map<number, Tooltip>();
  const reviewDefinitions: Record<string, Partial<Record<Lang, string>>> = {};
  if (renames.length) {
    for (const document of publishedDocuments(pub, tree, input, false)) {
      const updated = rewriteTooltip(document, renames);
      if (updated !== document) rewritten.set(document.hash, updated);
    }
    rewritePushed(pub, tree, pushed, rewritten);
    const pendingIds = new Set(pending.map(({ id }) => id));
    for (const entry of published.store.entries) {
      if (entry.tombstone || pendingIds.has(entry.id)) continue;
      const before = Object.fromEntries(
        languages.flatMap((lang) => {
          const definition = globalsInPlaceDefinition(entry.definitions, lang);
          return definition ? [[lang, definition.body]] : [];
        }),
      );
      // A saved dependent entry can already refer to the new name without being pending itself.
      if (Object.values(before).some((body) => rewrite(body, renames) !== body))
        reviewDefinitions[entry.id] = before;
    }
  }
  return { globalsPending, pushed, reviewImports, reviewDefinitions };
}
