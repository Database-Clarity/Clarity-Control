import {
  exportWithInactiveMoves,
  exportLegacy,
  globalPublishedSchema,
  activeAliases,
  composeGlobalRelease,
  globalAggregateHash,
  globalReferenceSpans,
  globalsInPlaceDefinition,
  globalsInPlaceDefinitions,
  globalsInPlaceFenceSchema,
  globalsInPlaceLibraryText,
  globalsInPlacePath,
  globalsInPlaceSaveIssue,
  globalsReleasePaths,
  isLegacyAliasStub,
  isTextlessDescription,
  languages,
  legacyGlobalsInPlaceDefinitions,
  lowerConsumerMarkup,
  MissingGlobalTranslation,
  publishableHashInput,
  protectCommentedGlobalImports,
  pushedSchema,
  reconcileGlobalStore,
  rewriteGlobalReferences,
  resolveAlias,
  resolveGlobalsInPlace,
  stableStringify,
  type Aliases,
  type GlobalRecord,
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
import { markupImports } from '../../packages/core/src/markup/prepare.js';
import { provesInPlace, type LegacyInput } from '../../packages/export/src/index.js';
import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import { type Tree } from './git.js';
import { GlobalsPublisher } from './globals.js';
import { unloweredEntry } from './consumerOutput.js';
import type { Publisher, Receipt } from './publisher.js';

export function globalsFence(pub: Publisher, tree: Tree): GlobalsInPlaceFence | undefined {
  if (!tree[globalsInPlacePath]) return undefined;
  const fence = globalsInPlaceFenceSchema.parse(pub.read(tree, globalsInPlacePath));
  if (fence.destination !== pub.options.liveBranch)
    throw new Error('The shared text migration belongs to another LIVE branch.');
  return fence;
}

export function requireGlobalsMode(pub: Publisher, tree: Tree, globals = false) {
  const fence = globalsFence(pub, tree);
  if (fence?.state === 'hold')
    throw new Error('Publication is paused for the shared text migration.');
  if (!fence && globals) throw new Error('Review shared definitions with the current publisher.');
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

function affectedRows(
  before: LegacyInput,
  after: LegacyInput,
  roots: readonly number[],
  lang?: Lang,
) {
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
        for (const { main, secondary } of lang
          ? [row.editor[lang]].filter((cell) => cell !== undefined)
          : Object.values(row.editor))
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
        if (
          resolveGlobalsInPlace(value, cell.englishFallback ? 'en' : (lang as Lang), options) !==
          value
        )
          throw new Error(
            `Tooltip ${entry.name || entry.hash} (${lang}) still reads shared text after export.`,
          );
  }
  const { raw, fallbacks } = exportGlobalsProof(
    documents,
    now,
    pub.options.facts,
    aliases,
    moves,
    options,
  );
  const merge = (entries: Receipt['exported']) =>
    pub.mergePublicationPerks(tree, live.perks, entries, hashes) as LegacyInput['perks'];
  proveInPlaceInputs(
    live,
    { ...live, perks: merge(raw) },
    { ...live, perks: merge(exported) },
    options,
    hashes,
    fallbacks,
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
  const fallbacks = new Map<number, Set<Lang>>();
  const raw = exportWithInactiveMoves(documents, now, facts, aliases, moves, {
    globalsInPlace,
    preserveGlobalReferencesForProof: true,
    onGlobalsFallback(hash, { language }) {
      let langs = fallbacks.get(hash);
      if (!langs) fallbacks.set(hash, (langs = new Set()));
      langs.add(language);
    },
  });
  return { raw, fallbacks };
}

export function proveInPlaceInputs(
  live: LegacyInput,
  raw: LegacyInput,
  after: LegacyInput,
  options: GlobalsInPlaceOptions,
  hashes: readonly number[],
  fallbacks: ReadonlyMap<number, ReadonlySet<Lang>>,
) {
  const before = { ...raw, perks: { ...raw.perks, ...proofLibraries(live, options) } };
  assertInPlaceLibraries(after);
  const affected = affectedRows(before, after, hashes);
  const english = new Set<Lang>();
  const fallbackBefore = { ...after, perks: { ...after.perks } };
  // The two baselines isolate raw localized cells and raw English fallback cells.
  // Other rows stay inlined, including import targets whose own language did not fall back.
  for (const [hash, langs] of fallbacks) {
    const localized = before.perks[hash];
    const filled = after.perks[hash];
    if (!localized || !filled || !('editor' in localized) || !('editor' in filled))
      throw new Error(`Missing English fallback proof input for tooltip ${hash}.`);
    const localizedEditor = { ...localized.editor };
    const fallbackEditor = { ...filled.editor };
    for (const lang of langs) {
      english.add(lang);
      localizedEditor[lang] = filled.editor[lang];
      fallbackEditor[lang] = localized.editor[lang];
    }
    before.perks[hash] = { ...localized, editor: localizedEditor };
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
    return Number(hash);
  };
  prove(before, (hash, lang) => !fallbacks.get(aliasSource(hash))?.has(lang));
  const fallbackScope = new Map(
    [...english].map((lang) => [
      lang,
      affectedRows(
        raw,
        after,
        [...fallbacks].flatMap(([hash, langs]) => (langs.has(lang) ? [hash] : [])),
        lang,
      ),
    ]),
  );
  Object.assign(fallbackBefore.perks, proofLibraries(live, options, english));
  prove(fallbackBefore, (hash, lang) => fallbackScope.get(lang)?.has(hash) ?? false);
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
  for (const tooltip of documents)
    for (const [lang, cell] of Object.entries(tooltip.text)) {
      const issue = globalsInPlaceSaveIssue(cell.text, titleNames);
      if (issue)
        throw new Error(`Tooltip ${tooltip.custom?.name || tooltip.hash} (${lang}): ${issue}`);
    }
}

type Selection = NonNullable<PublishPayload['globals']>;
type Rename = { kind: GlobalRecord['kind']; from: string; to: string };
const refusalMessage = (error: unknown) =>
  error instanceof ZodError
    ? (error.issues[0]?.message ?? 'Invalid shared definition.')
    : error instanceof Error
      ? error.message
      : String(error);
const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');
const definitionDigest = (entry: GlobalRecord) => sha256(stableStringify(entry));

function stores(pub: Publisher, tree: Tree) {
  const published = globalPublishedSchema.parse(
    pub.read(tree, globalsReleasePaths.published(pub.options.liveBranch)),
  );
  if (published.destination !== pub.options.liveBranch)
    throw new Error('Published global destination mismatch.');
  return { published, saved: new GlobalsPublisher(pub).store(tree) };
}

export function publishedGlobals(pub: Publisher, tree: Tree) {
  const { published, saved } = stores(pub, tree);
  return releaseOptions(published.store, saved);
}

function releaseOptions(published: GlobalStore, saved: GlobalStore): GlobalsInPlaceOptions {
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

function withImportedFallback(
  options: GlobalsInPlaceOptions,
  source: (hash: number) => { document: Tooltip; draft?: boolean } | undefined,
): GlobalsInPlaceOptions {
  const cache = new Map<
    number,
    { editor?: LegacyEntry['editor']; causes: Map<Lang, MissingGlobalTranslation> }
  >();
  const inspect = (hash: number) => {
    const cached = cache.get(hash);
    if (cached) return cached;
    const input = source(hash);
    const causes = new Map<Lang, MissingGlobalTranslation>();
    const row =
      input &&
      exportLegacy(
        [input.document],
        0,
        undefined,
        {},
        {
          globalsInPlace: input.draft ? options : { definitions: options.definitions },
          onGlobalsFallback: (_hash, cause) => causes.set(cause.language, cause),
        },
      )[input.document.hash];
    const inspected = { editor: row && !isLegacyAliasStub(row) ? row.editor : undefined, causes };
    cache.set(hash, inspected);
    return inspected;
  };
  const inherited = (
    text: string,
    lang: Lang,
    visited: Set<number>,
  ): MissingGlobalTranslation | undefined => {
    for (const line of markupImports(text)) {
      const target = / from (\d+) *$/.exec(line)?.[1];
      if (!target || visited.has(Number(target))) continue;
      const hash = Number(target);
      visited.add(hash);
      const { editor, causes } = inspect(hash);
      const local = editor?.[lang];
      const cause =
        causes.get(lang) ??
        (local && !local.englishFallback
          ? inherited(`${local.main}\n${local.secondary}`, lang, visited)
          : undefined);
      if (cause) return cause;
    }
  };
  return {
    ...options,
    importFallback: (text, lang) =>
      text.includes('import ') ? inherited(text, lang, new Set()) : undefined,
  };
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
  return withImportedFallback(plan.options, (hash) => {
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

function rewrite(source: string, renames: readonly Rename[]) {
  // Published names are resolved against the original snapshot. Apply edits from right to
  // left so choosing multiple renames cannot rewrite a name introduced by another selection.
  const edits = renames.flatMap(({ kind, from, to }) =>
    rewriteGlobalReferences(source, kind, from, to).edits.map((edit) => ({
      ...edit,
      kind,
      toName: to,
    })),
  );
  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    const value =
      edit.kind === 'variables'
        ? edit.braced
          ? `#{${edit.toName}}`
          : `#${edit.toName}`
        : edit.toName;
    source = source.slice(0, edit.from) + value + source.slice(edit.to);
  }
  return source;
}

function rewriteTooltip(document: Tooltip, renames: readonly Rename[]) {
  const copy = structuredClone(document);
  for (const cell of Object.values(copy.text)) cell.text = rewrite(cell.text, renames);
  return stableStringify(copy.text) === stableStringify(document.text) ? document : copy;
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

function assertHistoricalSecondaries(
  pub: Publisher,
  tree: Tree,
  live: LegacyInput,
  selected: readonly GlobalRecord[],
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

function refillLanguage(
  current: LegacyEntry['editor'][Lang],
  approved: LegacyEntry['editor'][Lang],
) {
  if (!current || !approved || current.secondary === current.main) return approved;
  return { ...approved, secondary: current.secondary };
}

function assertWithdrawal(
  selected: GlobalRecord,
  previous: GlobalRecord | undefined,
  saved: GlobalStore,
  published: GlobalStore,
  documents: readonly Tooltip[],
) {
  if (!previous || previous.tombstone) return;
  const names = new Set([selected.name, previous.name]);
  const reads = (text: string) =>
    globalReferenceSpans(text, selected.kind).some(({ name }) => names.has(name));
  const reader = documents.find((doc) => Object.values(doc.text).some((cell) => reads(cell.text)));
  if (reader)
    throw new Error(`Tooltip ${reader.custom?.name || reader.hash} still uses ${selected.name}.`);
  const dependency = [...saved.entries, ...published.entries].find(
    (entry) =>
      entry.id !== selected.id &&
      !entry.tombstone &&
      Object.values(entry.definitions).some((cell) => reads(cell.body)),
  );
  if (dependency) throw new Error(`${dependency.name} still uses ${selected.name}.`);
}

function selectedRelease(
  pub: Publisher,
  tree: Tree,
  live: LegacyInput,
  selection: Selection,
  maintainer: boolean,
) {
  const { published, saved } = stores(pub, tree);
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
  for (const entry of withdrawals)
    assertWithdrawal(entry, previous.get(entry.id), saved, published.store, removalDocs);

  const renames = renamesOf(published.store, selected);
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
  const rewritten = new Map<number, Tooltip>();
  const updatedDocs = liveDocs.map((prior) => {
    const doc = renames.length ? rewriteTooltip(prior, renames) : prior;
    if (doc !== prior) rewritten.set(doc.hash, doc);
    return doc;
  });
  const publishedDocs = new Map(updatedDocs.map((doc) => [doc.hash, doc]));
  const source = (hash: number) => {
    const row = live.perks[hash];
    const document = publishedDocs.get(row && 'aliasOf' in row ? row.aliasOf : hash);
    if (document) return { document };
  };
  const oldOptions = withImportedFallback(
    { definitions: globalsInPlaceDefinitions(before.entries) },
    source,
  );
  const publishedOptions = withImportedFallback({ definitions: options.definitions }, source);
  const refills = refillPublishedDocuments(live, live, updatedDocs, oldOptions, publishedOptions);
  return { options, published: { ...published, store: next }, refills, rewritten };
}

function refillPublishedDocuments(
  live: LegacyInput,
  withAuthoredRows: LegacyInput,
  documents: readonly Tooltip[],
  oldOptions: GlobalsInPlaceOptions,
  publishedOptions: GlobalsInPlaceOptions,
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
    affected.push(doc);
    const perk = live.perks[doc.hash] as unknown as LegacyEntry;
    const changed = languages.filter(
      (lang) =>
        stableStringify(old.editor[lang] ?? null) !== stableStringify(filled.editor[lang] ?? null),
    );
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
    const { raw, fallbacks } = exportGlobalsProof(affected, 0, undefined, {}, {}, publishedOptions);
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
      const fallback = fallbacks.get(hash);
      if (fallback) {
        for (const lang of fallback) if (!changed.includes(lang)) fallback.delete(lang);
        if (!fallback.size) fallbacks.delete(hash);
      }
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
      fallbacks,
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
    for (const item of [...selection].sort((a, b) => a.id.localeCompare(b.id))) {
      try {
        result = plan([...accepted, item]);
        accepted.push(item);
      } catch (refusal) {
        refusals.push({
          id: item.id,
          error: refusalMessage(refusal),
        });
      }
    }
    if (!accepted.length && !hasTooltipSelection) throw error;
    return { ...result, globals: accepted.map(({ id }) => id), refusals };
  }
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

export function bundleInPlaceReview(pub: Publisher, tree: Tree, fence: GlobalsInPlaceFence) {
  const live = pub.head(pub.options.liveBranch);
  if (!pub.git.ancestor(fence.migratedLive, live))
    throw new Error('LIVE has no in-place migration');
  const input = liveGlobalsInput(pub, live);
  assertInPlaceLibraries(input);
  const { published, saved } = stores(pub, tree);
  const pending = pendingEntries(published.store, saved);
  const globalsPending: GlobalsPending = pending.map((entry) => {
    const previous = published.store.entries.find(({ id }) => id === entry.id);
    const digest = definitionDigest(entry);
    let affected: number[] = [];
    let refusal: string | undefined;
    try {
      const plan = planInPlaceRelease(pub, tree, input, [{ id: entry.id, expected: digest }], true);
      affected = [...new Set([...Object.keys(plan.refills).map(Number), ...plan.rewritten.keys()])];
    } catch (error) {
      refusal = refusalMessage(error);
    }
    const cell = (value: GlobalRecord | undefined, lang: Lang) =>
      value?.tombstone ? null : (value?.definitions[lang]?.body ?? null);
    return {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
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
  if (renames.length) {
    for (const document of publishedDocuments(pub, tree, input, false)) {
      const updated = rewriteTooltip(document, renames);
      if (updated !== document) rewritten.set(document.hash, updated);
    }
    rewritePushed(pub, tree, pushed, rewritten);
  }
  return { globalsPending, pushed };
}
