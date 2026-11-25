import { createHash } from 'node:crypto';
import {
  composeGlobalTranslation,
  composeTooltipTranslation,
  exportLegacy,
  globalAggregateKind,
  globalPublishedSchema,
  globalsReleasePaths,
  inactivePublishableHash,
  inactiveRemovalHash,
  incomingAliases,
  isHeldSetBonus,
  isLegacyAliasStub,
  languages,
  MissingGlobalTranslation,
  publishableHashInput,
  pushedSchema,
  reconcileGlobalStore,
  refreshNumberFallbacks,
  resolveGlobalsInPlace,
  setBonusHoldMessage,
  stableStringify,
  tooltipSchema,
  translationAffectedDigest,
  translationBeforeDigest,
  translationEnglishDigest,
  translationEnglishGate,
  translationExpectedDigest,
  translationFallbackIds,
  translationPublishCapability,
  translationPublishContract,
  translationPublishReasons,
  translationReviewDigest,
  validateTextWithReads,
  verifyTranslationPublishTree,
  type Aliases,
  type GlobalStore,
  type LegacyEntry,
  type Lang,
  type Tooltip,
  type TranslationLanguage,
  type TranslationPublishPayload,
  type TranslationPublishReason,
  type TranslationPublishRow,
} from '../../packages/core/src/index.js';
import { schedulePaths } from '@clarity/core/schedule';
import { expandAliases } from '../../packages/export/src/converter/index.js';
import { convertDescription } from '../../packages/export/src/converter/descriptionConverter.js';
import { loadExports } from '../../packages/export/src/converter/converterFunctions/loadExports.js';
import type { LegacyInput } from '../../packages/export/src/legacy.js';
import { readFormatV2Lines } from '../../packages/export/src/v2/compile.js';
import { unloweredEntry } from './consumerOutput.js';
import type { Tree } from './git.js';
import {
  assertInPlaceDocuments,
  affectedRows,
  authoredInPlaceOptions,
  inPlaceStores,
  liveGlobalsInput,
  refillLanguage,
  refillPublishedDocuments,
  releaseOptions,
  requireGlobalsMode,
} from './globalsInPlace.js';
import type { Publisher } from './publisher.js';

export const translationRootsPath = 'live/translation-roots.json';
export const translationLivePath = 'liveDescriptions.json';
const snapshotPath = (hash: number) => `live/tooltips/${hash}.json`;
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const same = (a: unknown, b: unknown) => stableStringify(a ?? null) === stableStringify(b ?? null);
type Identity = { lang: TranslationLanguage } & (
  { kind: 'tooltip'; hash: number } | { kind: 'global'; id: string }
);
type Cell = LegacyEntry['editor'][TranslationLanguage];
type Stamp = NonNullable<LegacyEntry['updateTracker']>['descriptions'][TranslationLanguage];
type LiveEntry = Extract<LegacyInput['perks'][string], { editor: unknown }>;
type ResultRow = Identity & {
  status: 'published' | 'unchanged' | 'rejected';
  reason?: TranslationPublishReason;
  message?: string;
};
type Ready = TranslationPublishRow & {
  status: 'ready';
  removed: boolean;
  englishFallback: boolean;
  affectedHashes: number[];
  snapshot?: string;
};
type Blocked = Identity & { status: 'waiting' | 'refused'; reason: string; snapshot?: string };

class RowRefusal extends Error {
  constructor(
    readonly reason: TranslationPublishReason,
    message: string = translationPublishReasons[reason],
  ) {
    super(message);
  }
}
export class TranslationPartRefusal extends Error {
  constructor(readonly rows: ResultRow[]) {
    super(rows[0].message ?? translationPublishReasons[rows[0].reason ?? 'review-changed']);
  }
}

export function translationRuntimeInstalled(pub: Publisher, tree: Tree) {
  return (
    pub
      .read<{ capabilities?: string[] }>(tree, '.publisher/PIN')
      ?.capabilities?.includes(translationPublishCapability) === true
  );
}

export function liveTranslationAliases(input: LegacyInput): Aliases {
  return Object.fromEntries(
    Object.entries(input.perks).flatMap(([hash, row]) =>
      'aliasOf' in row ? [[hash, { to: row.aliasOf, kind: row.aliasKind }]] : [],
    ),
  );
}

function activeSource(
  pub: Publisher,
  tree: Tree,
  input: LegacyInput,
  aliases = liveTranslationAliases(input),
  pushed = pushedSchema.parse(pub.read(tree, 'live/pushed.json')),
) {
  return (hash: number) => {
    const path = snapshotPath(hash);
    if (!input.perks[hash] || !('editor' in input.perks[hash]) || (hash >= 1 && hash <= 3)) return;
    if (!tree[path] || !pushed[hash]) return;
    const raw = pub.read<Tooltip>(tree, path);
    const { data } = tooltipSchema.safeParse(raw);
    if (!data || data.hash !== hash || !data.text.en?.text.trim()) return;
    const digest = createHash('sha256').update(publishableHashInput(data, aliases)).digest('hex');
    if (digest === pushed[hash]) return raw;
  };
}

export function translationRoots(
  pub: Publisher,
  tree: Tree,
  liveCommit: string,
  input: LegacyInput,
  previous?: { data: Tree; liveCommit: string },
) {
  const aliases = liveTranslationAliases(input);
  const pushed = pushedSchema.parse(pub.read(tree, 'live/pushed.json'));
  const active = activeSource(pub, tree, input, aliases, pushed);
  let canReuse: (hash: number, oid: string) => boolean = () => false;
  if (previous) {
    const index = pub.read<{ destination: string; liveCommit: string; roots: Record<string, string> }>(
      previous.data, translationRootsPath,
    );
    if (index?.liveCommit === previous.liveCommit && index.destination === pub.options.liveBranch && index.roots) {
      const before = liveTranslationAliases(liveGlobalsInput(pub, previous.liveCommit));
      const markers = pushedSchema.parse(pub.read(previous.data, 'live/pushed.json'));
      canReuse = (hash, oid) =>
        index.roots[hash] === oid && !!pushed[hash] && markers[hash] === pushed[hash] &&
        same(incomingAliases(hash, before), incomingAliases(hash, aliases));
    }
  }
  const roots: Record<string, string> = {};
  for (const [key, perk] of Object.entries(input.perks)) {
    const hash = Number(key);
    if ((hash >= 1 && hash <= 3) || !('editor' in perk)) continue;
    const oid = tree[snapshotPath(hash)];
    if (oid && (canReuse(hash, oid) || active(hash))) roots[key] = oid;
  }
  return { destination: pub.options.liveBranch, liveCommit, roots };
}

function lane(doc: Tooltip, lang: TranslationLanguage): Tooltip {
  const { en, [lang]: entry } = doc.text;
  return { ...doc, text: { ...(en ? { en } : {}), ...(entry ? { [lang]: entry } : {}) } };
}

function setCell(row: LiveEntry, lang: TranslationLanguage, cell?: Cell, stamp?: { value: Stamp }) {
  const editor = { ...row.editor };
  if (cell) editor[lang] = cell;
  else delete editor[lang];
  if (!stamp) return { ...row, editor };
  const descriptions = { ...row.updateTracker?.descriptions };
  if (stamp.value)
    descriptions[lang] = stamp.value as NonNullable<
      LiveEntry['updateTracker']['descriptions'][TranslationLanguage]
    >;
  else delete descriptions[lang];
  return {
    ...row,
    editor,
    ...(row.updateTracker || stamp.value
      ? { updateTracker: { ...row.updateTracker, descriptions } }
      : {}),
  };
}

function liveEntry(input: LegacyInput, hash: number): LiveEntry {
  const row = input.perks[hash];
  if (!row || !('editor' in row)) throw new Error(`Missing LIVE tooltip ${hash}.`);
  return row;
}

function effectFacts(
  input: LegacyInput,
  hash: number,
  lang: TranslationLanguage,
  aliases: Aliases,
  facts: Publisher['options']['facts'],
  lookup: ReturnType<typeof expandAliases>,
) {
  const perk = liveEntry(input, hash);
  const cell = perk.editor[lang];
  if (!cell) return null;
  if (isHeldSetBonus({}, facts[hash] ?? perk)) throw new Error(setBonusHoldMessage);
  if (unloweredEntry({ [hash]: cell }) || cell.main.includes('{{') || cell.secondary.includes('{{'))
    throw new Error(`Tooltip ${hash} (${lang}) contains markup held from publication.`);
  const language: Lang = cell.englishFallback ? 'en' : lang;
  const reads = new Set<number>();
  const database = new Proxy(lookup, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof key === 'string' && /^\d+$/.test(key) && Number(key) !== hash)
        reads.add(aliases[key]?.to ?? Number(key));
      return value;
    },
  });
  const parts = (['main', 'secondary'] as const).map((editorType) => {
    const args = {
      database,
      editorType,
      hash,
      language: lang,
      descriptionString: cell[editorType],
    };
    const expanded = loadExports(args);
    const globals = {
      variables: lookup[2]?.editor[lang]?.main ?? '',
      titles: lookup[3]?.editor[lang]?.main ?? '',
      lang: language,
    };
    const checked = validateTextWithReads(expanded, language, globals, false, hash, aliases);
    const issue = checked.issues.find(
      (value) => value.severity === 'error' || value.code === 'retired',
    );
    if (issue) throw new Error(`Tooltip ${hash} (${lang}): ${issue.message}`);
    const converted = convertDescription(args);
    if (converted.native)
      throw new Error(`Tooltip ${hash} (${lang}) contains markup held from publication.`);
    return converted.lines ?? null;
  });
  const imports = new Proxy({} as Record<string, string>, {
    get(_target, key) {
      if (typeof key !== 'string') return undefined;
      if (key === 'global') return database[1]?.editor[language]?.main;
      return database[key]?.editor[language]?.main ?? (database[key] ? '' : undefined);
    },
  });
  const v2 = readFormatV2Lines(
    cell.main,
    {
      imports,
      variables: lookup[2]?.editor[lang]?.main ?? '',
      titles: lookup[3]?.editor[lang]?.main ?? '',
      lang: language,
      type: perk.type,
    },
    String(hash),
    lang,
  );
  for (const target of reads) {
    const dependency = input.perks[target];
    if (!dependency || !('editor' in dependency))
      throw new Error(`Publish tooltip ${target} first.`);
    if (isHeldSetBonus({}, facts[target] ?? dependency)) throw new Error(setBonusHoldMessage);
  }
  return { cell, parts, v2, imports: [...reads].sort((a, b) => a - b) };
}

function context(pub: Publisher, tree: Tree, live: string) {
  const fence = requireGlobalsMode(pub, tree);
  if (!pub.git.ancestor(fence.migratedLive, live))
    throw new Error('LIVE has no in-place migration.');
  const input = liveGlobalsInput(pub, live);
  const aliases = liveTranslationAliases(input);
  const active = activeSource(pub, tree, input, aliases);
  const pushed = pushedSchema.parse(pub.read(tree, 'live/pushed.json'));
  const { published, saved } = inPlaceStores(pub, tree);
  const savedGlobals = new Map(saved.entries.map((entry) => [entry.id, entry]));
  const liveGlobals = new Map(published.store.entries.map((entry) => [entry.id, entry]));
  const beforeOptions = releaseOptions(published.store, saved);
  const document = (hash: number) => pub.read<Tooltip>(tree, snapshotPath(hash));
  const optionsFor = (options = beforeOptions, drafts: readonly Tooltip[] = []) =>
    authoredInPlaceOptions(pub, tree, input, { options, rewritten: new Map() }, drafts, aliases);
  const snapshots = (lang: TranslationLanguage, excluded: ReadonlySet<number> = new Set()) => {
    const documents: Tooltip[] = [];
    for (const [key, value] of Object.entries(input.perks)) {
      const hash = Number(key);
      if (excluded.has(hash) || (hash >= 1 && hash <= 3) || !('editor' in value)) continue;
      const doc = document(hash);
      if (!doc && value.editor[lang])
        throw new Error(`Repair the published source for tooltip ${hash} first.`);
      if (doc?.text[lang] || (doc && value.editor[lang])) documents.push(lane(doc, lang));
    }
    return documents;
  };

  function checkCombined(
    store: GlobalStore,
    lang: TranslationLanguage,
    composed: Tooltip[],
    merged: LegacyInput,
  ) {
    const drafts = composed.map((doc) => lane(doc, lang));
    const options = optionsFor(releaseOptions(store, saved), drafts);
    const refills = refillPublishedDocuments(
      input,
      merged,
      snapshots(lang, new Set(drafts.map(({ hash }) => hash))),
      optionsFor(),
      options,
      lang,
    );
    for (const [key, old] of Object.entries(input.perks)) {
      if (!('editor' in old) || drafts.some(({ hash }) => hash === Number(key))) continue;
      const expected = refills[key];
      if (
        !same(
          liveEntry(merged, Number(key)).editor[lang],
          expected && !isLegacyAliasStub(expected) ? expected.editor[lang] : old.editor[lang],
        )
      )
        throw new Error(`Combined translation changes affect tooltip ${key}.`);
    }
    for (const draft of drafts) {
      const { hash } = draft;
      const row = exportLegacy([draft], 0, undefined, {}, { globalsInPlace: options })[hash];
      if (
        !row ||
        isLegacyAliasStub(row) ||
        !same(
          liveEntry(merged, hash).editor[lang],
          refillLanguage(liveEntry(input, hash).editor[lang], row.editor[lang]),
        )
      )
        throw new Error(`Combined translation changes affect tooltip ${hash}.`);
    }
  }

  async function assess(row: Identity) {
    const { lang } = row;
    const id: Identity =
      row.kind === 'tooltip'
        ? { kind: row.kind, hash: row.hash, lang }
        : { kind: row.kind, id: row.id, lang };
    const next: LegacyInput = { ...input, perks: { ...input.perks } };
    let tooltip: Awaited<ReturnType<typeof composeTooltipTranslation>> | undefined;
    let global: ReturnType<typeof composeGlobalTranslation> | undefined;
    let expected: string;
    let english: string;
    let before: string;
    let unchanged: boolean;
    let removed: boolean;
    let globalFallback = false;
    const gate = (result: ReturnType<typeof translationEnglishGate>) => {
      if (result.status !== 'ready') throw new RowRefusal(result.reason);
    };
    if (row.kind === 'tooltip') {
      const { hash } = row;
      const authored = pub.read<Tooltip>(tree, `tooltips/${hash}.json`);
      const liveDoc = active(hash);
      gate(
        translationEnglishGate({
          kind: row.kind,
          hash,
          saved: authored,
          liveAliases: aliases,
          live: liveDoc
            ? { status: 'active', entry: liveDoc }
            : {
                status: input.perks[hash]
                  ? 'unverified'
                  : pushed[hash] === (await inactiveRemovalHash(hash))
                    ? 'inactive'
                    : 'missing',
              },
        }),
      );
      if (tree[schedulePaths.conflict(hash)])
        throw new Error('Resolve the scheduled activation conflict first.');
      if (isHeldSetBonus(liveDoc!, pub.options.facts[hash])) throw new Error(setBonusHoldMessage);
      const entry = authored!.text[lang];
      const oldEntry = liveDoc!.text[lang];
      const oldFallback = translationFallbackIds(liveDoc!.text.en, lang);
      const checked = structuredClone(liveDoc!);
      if (entry) checked.text[lang] = entry;
      else delete checked.text[lang];
      if (entry?.text !== oldEntry?.text) refreshNumberFallbacks(checked, lang);
      const fallback = entry ? translationFallbackIds(checked.text.en, lang) : [];
      expected = await translationExpectedDigest(entry);
      english = await translationEnglishDigest(liveDoc!.text.en!);
      before = await translationBeforeDigest(oldEntry, oldFallback);
      unchanged = same(oldEntry, entry) && same(oldFallback, fallback);
      removed = !entry;
      if (!unchanged) {
        tooltip = await composeTooltipTranslation(liveDoc!, lang, entry, fallback, aliases);
        const projected = lane(tooltip.tooltip, lang);
        const options = optionsFor(beforeOptions, [projected]);
        assertInPlaceDocuments([projected], options);
        const filled = exportLegacy([projected], 0, undefined, {}, { globalsInPlace: options })[
          hash
        ];
        if (!filled || isLegacyAliasStub(filled))
          throw new Error(`Tooltip ${hash} has no text to publish.`);
        const current = liveEntry(input, hash);
        next.perks[hash] = setCell(
          current,
          lang,
          refillLanguage(current.editor[lang], filled.editor[lang]),
          {
            value: entry ? filled.updateTracker?.descriptions[lang] : undefined,
          },
        );
        if (
          Boolean(current.editor[lang]?.englishFallback) !==
          Boolean(filled.editor[lang]?.englishFallback)
        ) {
          Object.assign(
            next.perks,
            refillPublishedDocuments(
              input,
              next,
              snapshots(lang, new Set([hash])),
              optionsFor(),
              options,
              lang,
            ),
          );
        }
      }
    } else {
      const authored = savedGlobals.get(row.id);
      const previous = liveGlobals.get(row.id);
      gate(
        translationEnglishGate({
          kind: row.kind,
          id: row.id,
          saved: authored,
          live: previous ? { status: 'active', entry: previous } : { status: 'missing' },
        }),
      );
      const entry = authored!.definitions[lang];
      expected = await translationExpectedDigest(entry);
      english = await translationEnglishDigest(previous!.definitions.en!);
      before = await translationBeforeDigest(previous!.definitions[lang]);
      unchanged = same(entry, previous!.definitions[lang]);
      removed = !entry;
      if (!unchanged) {
        global = composeGlobalTranslation(previous!, lang, entry);
        const store = {
          ...published.store,
          entries: published.store.entries.map((old) => (old.id === global!.id ? global! : old)),
        };
        const options = releaseOptions(store, saved);
        if (entry) {
          const check = (body: string, language: Lang) => {
            if (
              body.includes('{{') ||
              resolveGlobalsInPlace(body, language, options).includes('{{')
            )
              throw new Error('This shared text contains or imports markup held from publication.');
          };
          try {
            check(entry.body, lang);
          } catch (error) {
            if (!(error instanceof MissingGlobalTranslation)) throw error;
            check(previous!.definitions.en!.body, 'en');
            globalFallback = true;
          }
        }
        Object.assign(
          next.perks,
          refillPublishedDocuments(
            input,
            next,
            snapshots(lang),
            optionsFor(),
            optionsFor(options),
            lang,
          ),
        );
      }
    }
    const refilled = Object.keys(next.perks).flatMap((key) => {
      const hash = Number(key);
      return next.perks[key] !== input.perks[key] && (row.kind !== 'tooltip' || hash !== row.hash)
        ? [hash]
        : [];
    });
    const changed = row.kind === 'tooltip' && tooltip ? [row.hash, ...refilled] : refilled;
    const lookup = expandAliases(next.perks);
    const fact = (data: LegacyInput, hash: number, expanded: ReturnType<typeof expandAliases>) =>
      effectFacts(data, hash, lang, aliases, pub.options.facts, expanded);
    const facts = changed.map((hash) => [hash, fact(next, hash, lookup)] as const);
    if (changed.length) {
      const beforeLookup = expandAliases(input.perks);
      for (const key of affectedRows(input, next, changed)) {
        const hash = Number(key);
        if (changed.includes(hash) || !('editor' in next.perks[key])) continue;
        const before = fact(input, hash, beforeLookup);
        const after = fact(next, hash, lookup);
        if (!same(before, after)) facts.push([hash, after]);
      }
    }
    facts.sort(([a], [b]) => a - b);
    const affected = facts.flatMap(([hash]) =>
      row.kind === 'tooltip' && hash === row.hash ? [] : [hash],
    );
    const englishFallback =
      globalFallback ||
      facts.some(([hash]) => !!liveEntry(next, hash).editor[lang]?.englishFallback);
    const effects = await translationReviewDigest({ removed, englishFallback, affected, facts });
    const ready: Ready = {
      ...id,
      expected,
      english,
      before,
      effects,
      ...(id.kind === 'global'
        ? { ...id, affected: await translationAffectedDigest(affected) }
        : id),
      status: 'ready',
      removed,
      englishFallback,
      affectedHashes: affected,
      ...(id.kind === 'tooltip' ? { snapshot: tree[snapshotPath(id.hash)] } : {}),
    };
    return { unchanged, ready, tooltip, global, changed, next, facts };
  }
  return { input, aliases, published, savedGlobals, liveGlobals, assess, active, checkCombined };
}

export async function planTranslations(
  pub: Publisher,
  tree: Tree,
  live: string,
  payload: TranslationPublishPayload,
) {
  const ctx = context(pub, tree, live);
  const catalog = structuredClone(ctx.published);
  const input = { ...ctx.input, perks: { ...ctx.input.perks } };
  const entries = new Map<number, Awaited<ReturnType<typeof composeTooltipTranslation>>>();
  const rows: ResultRow[] = [];
  const refused: ResultRow[] = [];
  const selected = new Set<string>();
  const effects: { id: Identity; facts: Awaited<ReturnType<typeof ctx.assess>>['facts'] }[] = [];
  const changedGlobalLanes = new Set<string>();
  for (const signed of payload.rows) {
    const { lang } = signed;
    const id: Identity =
      signed.kind === 'tooltip'
        ? { kind: signed.kind, hash: signed.hash, lang }
        : { kind: signed.kind, id: signed.id, lang };
    try {
      const plan = await ctx.assess(id);
      const { ready, tooltip, global } = plan;
      if (
        ready.english !== signed.english ||
        ready.expected !== signed.expected ||
        (!plan.unchanged &&
          (ready.before !== signed.before ||
            ready.effects !== signed.effects ||
            (ready.kind === 'global' &&
              signed.kind === 'global' &&
              ready.affected !== signed.affected)))
      )
        throw new RowRefusal('review-changed');
      if (!plan.unchanged) {
        effects.push({ id, facts: plan.facts });
        for (const hash of plan.changed) {
          const key = `${hash}/${lang}`;
          if (selected.has(key))
            throw new RowRefusal(
              'review-changed',
              `Publish the other change affecting tooltip ${hash} first.`,
            );
          selected.add(key);
          const next = liveEntry(plan.next, hash);
          input.perks[hash] = setCell(
            liveEntry(input, hash),
            lang,
            next.editor[lang],
            id.kind === 'tooltip' && id.hash === hash
              ? { value: next.updateTracker?.descriptions[lang] }
              : undefined,
          );
        }
        if (tooltip) {
          const { hash } = tooltip.tooltip;
          const earlier = entries.get(hash);
          entries.set(
            hash,
            earlier
              ? await composeTooltipTranslation(
                  earlier.tooltip,
                  lang,
                  tooltip.tooltip.text[lang],
                  translationFallbackIds(tooltip.tooltip.text.en, lang),
                  ctx.aliases,
                )
              : tooltip,
          );
        }
        if (global) {
          changedGlobalLanes.add(`${global.kind}/${lang}`);
          const index = catalog.store.entries.findIndex(({ id }) => id === global.id);
          catalog.store.entries[index] = composeGlobalTranslation(
            catalog.store.entries[index],
            lang,
            global.definitions[lang],
          );
        }
      }
      rows.push({ ...id, status: plan.unchanged ? 'unchanged' : 'published' });
    } catch (error) {
      const reason = error instanceof RowRefusal ? error.reason : 'missing-live-input';
      refused.push({
        ...id,
        status: 'rejected',
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (refused.length) throw new TranslationPartRefusal(refused);
  if (effects.length > 1) {
    const lookup = expandAliases(input.perks);
    for (const { id, facts } of effects) {
      try {
        if (
          facts.every(([hash, expected]) =>
            same(
              expected,
              effectFacts(input, hash, id.lang, ctx.aliases, pub.options.facts, lookup),
            ),
          )
        )
          continue;
      } catch {
        // A selected dependency changed the previewed effect.
      }
      const other = effects.find((effect) => effect.id !== id && effect.id.lang === id.lang)?.id;
      refused.push({
        ...id,
        status: 'rejected',
        reason: 'review-changed',
        message: other
          ? `Publish ${other.kind === 'tooltip' ? `tooltip ${other.hash}` : 'the other shared text'} first.`
          : translationPublishReasons['review-changed'],
      });
    }
    if (refused.length) throw new TranslationPartRefusal(refused);
    for (const lang of new Set(effects.map(({ id }) => id.lang))) {
      const selected = effects.filter(({ id }) => id.lang === lang).map(({ id }) => id);
      if (selected.length < 2 || !selected.some(({ kind }) => kind === 'global')) continue;
      try {
        ctx.checkCombined(
          catalog.store,
          lang,
          selected.flatMap((id) => (id.kind === 'tooltip' ? [entries.get(id.hash)!.tooltip] : [])),
          input,
        );
      } catch {
        throw new TranslationPartRefusal(
          selected.map((id) => ({
            ...id,
            status: 'rejected',
            reason: 'review-changed',
            message: 'Publish the related shared text first, then review this change again.',
          })),
        );
      }
    }
  }
  const data = new Map<string, string>();
  if (entries.size) {
    const pushed = pushedSchema.parse(pub.read(tree, 'live/pushed.json'));
    for (const [hash, { tooltip, marker }] of entries) {
      pushed[hash] = marker;
      data.set(snapshotPath(hash), json(tooltip));
    }
    data.set('live/pushed.json', json(pushed));
  }
  if (changedGlobalLanes.size) {
    const reconciled = reconcileGlobalStore(catalog.store.aggregates, catalog.store.entries);
    for (const [index, aggregate] of catalog.store.aggregates.entries())
      for (const lang of languages)
        if (changedGlobalLanes.has(`${globalAggregateKind(aggregate.document.hash)}/${lang}`)) {
          const updated = reconciled.aggregates[index].languages[lang];
          if (updated) aggregate.languages[lang] = updated;
          else delete aggregate.languages[lang];
        }
    globalPublishedSchema.parse(catalog);
    data.set(globalsReleasePaths.published(pub.options.liveBranch), json(catalog));
  }
  return { data, input, rows, changed: data.size > 0 };
}

export async function bundleTranslations(
  pub: Publisher,
  tree: Tree,
  liveCommit: string,
  tooltips: Record<string, Tooltip>,
) {
  const ctx = context(pub, tree, liveCommit);
  const lanes: Partial<Record<TranslationLanguage, (Ready | Blocked)[]>> = {};
  const only: { tooltips: number[]; globals: string[] } = { tooltips: [], globals: [] };
  const add = async (id: Identity, sameEntry: boolean, snapshot?: string) => {
    if (sameEntry) return;
    let result: Ready | Blocked;
    try {
      const plan = await ctx.assess(id);
      if (plan.unchanged) return;
      result = plan.ready;
    } catch (error) {
      const waiting =
        error instanceof RowRefusal &&
        ['missing-live', 'unverified-live', 'english-pending', 'missing-live-english'].includes(
          error.reason,
        );
      result = {
        ...id,
        status: waiting ? 'waiting' : 'refused',
        reason: error instanceof Error ? error.message : String(error),
        ...(snapshot ? { snapshot } : {}),
      };
    }
    (lanes[id.lang] ??= []).push(result);
    return true;
  };
  let currentAliases: Aliases | undefined;
  let moves: ReturnType<Publisher['movesAt']> | undefined;
  try {
    currentAliases = pub.aliasesAt(tree);
    moves = pub.movesAt(tree);
  } catch {
    // A malformed pending config can't prove that a row belongs in the translation-only fold.
  }
  const pushed = pushedSchema.parse(pub.read(tree, 'live/pushed.json'));
  for (const [key, tooltip] of Object.entries(tooltips)) {
    const hash = Number(key);
    if ((hash >= 1 && hash <= 3) || Object.hasOwn(ctx.aliases, hash)) continue;
    const path = snapshotPath(hash);
    const old = pub.read<Tooltip>(tree, path);
    let pending = false;
    for (const lang of languages) {
      if (lang === 'en') continue;
      if (
        await add(
          { kind: 'tooltip', hash, lang },
          same(old?.text[lang], tooltip.text[lang]),
          tree[path],
        )
      )
        pending = true;
    }
    const verified = pending && ctx.active(hash);
    if (
      !verified ||
      !tooltip.text.en ||
      !currentAliases ||
      !moves ||
      Object.hasOwn(currentAliases, hash)
    )
      continue;
    let neutral = tooltip;
    const { text: _savedText, ...savedFields } = tooltip;
    const { text: _liveText, ...liveFields } = verified;
    void _savedText;
    void _liveText;
    if (!same(savedFields, liveFields)) continue;
    for (const lang of languages) {
      if (lang === 'en') continue;
      const fallback = translationFallbackIds(verified.text.en, lang).filter(
        (id) =>
          typeof tooltip.text.en?.numbers?.retired[id] === 'object' &&
          tooltip.text.en.numbers.retired[id] !== null,
      );
      neutral = (
        await composeTooltipTranslation(
          neutral,
          lang,
          verified.text[lang],
          fallback,
          currentAliases,
        )
      ).tooltip;
    }
    if (
      (await inactivePublishableHash(neutral, currentAliases, moves)) === pushed[hash] &&
      (await translationEnglishDigest(tooltip.text.en!)) ===
        (await translationEnglishDigest(verified.text.en!))
    )
      only.tooltips.push(hash);
  }
  for (const [id, entry] of ctx.savedGlobals) {
    const previous = ctx.liveGlobals.get(id);
    let pending = false;
    for (const lang of languages) {
      if (lang === 'en') continue;
      if (
        await add(
          { kind: 'global', id, lang },
          same(previous?.definitions[lang], entry.definitions[lang]),
        )
      )
        pending = true;
    }
    if (!pending || !previous) continue;
    const { definitions, revision: _savedRevision, ...saved } = entry;
    const { definitions: oldDefinitions, revision: _publishedRevision, ...published } = previous;
    void _savedRevision;
    void _publishedRevision;
    if (same(saved, published) && same(definitions.en, oldDefinitions.en)) only.globals.push(id);
  }
  return { version: translationPublishContract, liveCommit, lanes, only };
}

export function assertTranslationTree(
  before: Tree,
  after: Tree,
  allowed: ReadonlyMap<string, string | null>,
) {
  const proof = verifyTranslationPublishTree(before, after, allowed);
  if (!proof.ok)
    throw new Error(`Translation publication changed unexpected bytes at ${proof.path}.`);
}
