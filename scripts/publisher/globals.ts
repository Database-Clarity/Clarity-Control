import { createHash } from 'node:crypto';
import { z } from 'zod';
import { buildLegacy, legacyPresets, type LegacyInput } from '../../packages/export/src/legacy.js';
import { publicationSourcesPath } from '../../packages/core/src/globalsRelease/admission.js';
import {
  emptyGitTree,
  globalConfigIdentity,
  globalIdentityDigest,
  globalLayoutSchema,
  globalPublishedSchema,
  globalsReleasePaths,
  globalsConfigWithoutMarks,
  observeGlobalSources,
  planGlobalRelease,
  reconcileGlobalStore,
  composeGlobalRelease,
  changedGlobalIds,
  type GlobalSources,
  type GlobalReleaseComponent,
} from '../../packages/core/src/globalsRelease/index.js';
import {
  globalAggregateHash,
  type GlobalCause,
  type GlobalRecord,
  type GlobalStore,
} from '../../packages/core/src/globals/model.js';
import {
  calculateGlobalImpact,
  GlobalSnapshotScans,
} from '../../packages/core/src/globals/impact.js';
import { projectGlobals } from '../../packages/core/src/globals/projection.js';
import { assertGlobalTransition } from '../../packages/core/src/globals/transition.js';
import { globalSourceText } from '../../packages/core/src/globals/source.js';
import { globalsFence } from './globalsInPlace.js';
import { rewriteGlobalReferences } from '../../packages/core/src/globals/references.js';
import { markupDefinitions } from '../../packages/core/src/markup/clashes.js';
import { extractBlocks } from '../../packages/core/src/markup/syntax.js';
import { languages, type Lang } from '../../packages/core/src/languages.js';
import {
  permissionsSchema,
  pushedSchema,
  tooltipSchema,
  type Tooltip,
} from '../../packages/core/src/schemas.js';
import {
  exportWithInactiveMoves,
  hasUnpublishedInactiveMove,
  inactivePublishableHash,
  isMovedInactive,
  selectedInactiveMoves,
} from '../../packages/core/src/inactiveMoves.js';
import { stableStringify } from '../../packages/core/src/contentHash.js';
import { exportLegacy } from '../../packages/core/src/exportLegacy.js';
import { aliasesSchema, resolveAlias, type Aliases } from '../../packages/core/src/aliases.js';
import type { GlobalImpactSnapshot } from '../../packages/core/src/globals/impactModel.js';
import {
  batchMemberSchema,
  batchSchema,
  isOpenStatus,
  schedulePaths,
} from '../../packages/core/src/schedule/schemas.js';
import {
  clashSchema,
  entrySchema,
  globalFileBytes,
  limits,
  nameProofRequestSchema,
  pendingCauseSchema,
  publicationSchema,
  removalSchema,
  rowSchema,
  sameSources,
  sourcesSchema,
  syncSchema,
  catalogSchema,
  pageSchema,
  paths as entryPaths,
} from '../../apps/worker/src/globals/model.js';
import { namePaths, publicGlobalSync } from '../../apps/worker/src/globals/handlers.js';
import { appCredits, RefRace, type Tree } from './git.js';
import { Publisher, type Options } from './publisher.js';

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const livePerksSchema = z.record(z.string(), z.record(z.string(), z.unknown()));
const currentSync = {
  version: 1,
  status: 'current',
  causeIds: [],
  causeEntries: {},
  lastFailure: null,
};
export const hasGlobals = (tree: Tree) =>
  Object.keys(tree).some((path) => path.startsWith('globals/'));

/**
 * The editor's catalogue (bundle.json `globals`): every entry in catalogue page order and the
 * public sync header, both at this tree. The Worker serves only the opened entry, its reviews,
 * and writes. Throws on any malformed or inconsistent catalogue file.
 */
export function bundleGlobals(tree: Tree, read: (tree: Tree, path: string) => unknown) {
  const catalog = catalogSchema.parse(read(tree, 'globals/catalog.json'));
  const entries: GlobalRecord[] = [];
  const cursors = new Set<string>();
  const ids = new Set<string>();
  for (let cursor: string | null = 'p0'; cursor !== null;) {
    if (!/^p\d{1,5}$/.test(cursor) || cursors.has(cursor) || cursors.size > catalog.lastPage)
      throw new Error('Invalid global catalog pages');
    cursors.add(cursor);
    const page = pageSchema.parse(read(tree, entryPaths.page(cursor)));
    for (const id of page.ids) {
      const entry = entrySchema.parse(read(tree, entryPaths.entry(id)));
      if (entry.id !== id || ids.has(id)) throw new Error('Invalid global catalog identity');
      ids.add(id);
      entries.push(entry);
    }
    cursor = page.nextCursor;
  }
  if (cursors.size !== catalog.lastPage + 1) throw new Error('Invalid global catalog tail');
  return { entries, sync: publicGlobalSync(syncSchema.parse(read(tree, entryPaths.sync))) };
}
export interface GlobalReleaseReceipt {
  version: 1;
  roots: number[];
  sources: GlobalSources;
  digest: string;
  published: z.infer<typeof globalPublishedSchema>;
  /** Immutable signed scheduling source; never an Action-selected replacement pin. */
  batchSource?: string;
}
export interface GlobalRelease {
  documents: Tooltip[];
  receipt: GlobalReleaseReceipt;
  entryOnlyAggregates: number[];
}

export class GlobalReleaseRejected extends Error {}

function globalTreeEntries(tree: Tree, prefix: string, modes: Record<string, string> = {}) {
  const entries = Object.entries(tree).filter(([path]) => path.startsWith(`${prefix}/`));
  const files = new Map<string, string>(),
    directories = new Set<string>();
  for (const [path, oid] of entries) {
    const rest = path.slice(prefix.length + 1),
      slash = rest.indexOf('/');
    if (slash < 0) files.set(rest, oid);
    else directories.add(rest.slice(0, slash));
  }
  return [
    ...[...files].map(([name, oid]) => ({
      name,
      oid,
      mode: modes[`${prefix}/${name}`] ?? '100644',
    })),
    ...[...directories].map((name) => ({
      name,
      oid: globalTreeOid(tree, `${prefix}/${name}`, modes),
      mode: '40000',
    })),
  ];
}

/** Exact Git tree OID from the repository's flat blob tree, without shelling out or reading blobs. */
export function globalTreeOid(
  tree: Tree,
  prefix: string,
  modes: Record<string, string> = {},
): string {
  const parts = globalTreeEntries(tree, prefix, modes).sort((a, b) =>
    Buffer.compare(
      Buffer.from(a.name + (a.mode === '40000' ? '/' : '')),
      Buffer.from(b.name + (b.mode === '40000' ? '/' : '')),
    ),
  );
  if (!parts.length) return emptyGitTree;
  const bytes = Buffer.concat(
    parts.map(({ name, oid, mode }) =>
      Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]),
    ),
  );
  return createHash('sha1').update(`tree ${bytes.length}\0`).update(bytes).digest('hex');
}

const intentSchema = z
  .object({
    version: z.literal(1),
    id: z.string(),
    operation: z.literal('rename'),
    globalId: entrySchema.shape.id,
    revision: entrySchema.shape.revision,
    expectedHead: z.string().regex(/^[a-f0-9]{40}$/),
    sources: sourcesSchema,
    name: z.string(),
    by: z.string(),
    at: z.iso.datetime(),
  })
  .strict();

export class GlobalsPublisher {
  constructor(readonly publisher: Publisher) {}
  get git() {
    return this.publisher.git;
  }
  get options() {
    return this.publisher.options;
  }
  read(tree: Tree, path: string): unknown {
    return this.publisher.read(tree, path);
  }
  write(tree: Tree, path: string, value: unknown, maximum = limits.fileBytes): void {
    if (globalFileBytes(value) > maximum) throw new Error('Global metadata exceeds its byte limit');
    tree[path] = this.git.writeBlob(json(value));
  }
  async sources(
    tree: Tree,
    live: string,
    head?: string,
    historical = false,
  ): Promise<GlobalSources> {
    const pin = z
      .object({ sourceSha: z.string(), sha256: z.string(), capabilities: z.array(z.string()) })
      .parse(this.read(tree, '.publisher/PIN'));
    if (
      (!historical &&
        (pin.sourceSha !== this.options.publisherSha ||
          pin.sha256 !== this.options.publisherDigest)) ||
      !pin.capabilities.includes('globalsRelease')
    )
      throw new Error('Installed publisher lacks globalsRelease');
    if (
      !historical &&
      this.store(tree).aggregates.some((aggregate) => aggregate.document.hash === 1) &&
      !pin.capabilities.includes('globalsExportsV1')
    )
      throw new Error('Installed publisher lacks globalsExportsV1');
    const modes = this.git.treeModes?.(head ?? this.publisher.head(this.options.dataBranch)) ?? {};
    // Historical causes retain the config identity used by the publisher installed at that head.
    const config = pin.capabilities.includes(globalsConfigWithoutMarks)
      ? await globalConfigIdentity(
          globalTreeEntries(tree, 'config', modes).map(({ name, oid, mode }) => ({
            nameRaw: Buffer.from(name).toString('base64'),
            oid,
            mode: parseInt(mode, 8),
          })),
        )
      : globalTreeOid(tree, 'config', modes);
    return observeGlobalSources({
      authored: globalTreeOid(tree, 'tooltips', modes),
      definitions: globalTreeOid(tree, 'globals/entries', modes),
      projections: globalTreeOid(tree, 'globals/projections', modes),
      layout: tree[globalsReleasePaths.layout],
      published: tree[globalsReleasePaths.published(this.options.liveBranch)],
      config,
      live,
      upcoming: globalTreeOid(tree, 'schedule', modes),
      aliasGroups: tree['config/alias-groups.json'] ?? null,
      sandboxPointers: tree['config/sandbox-pointers.json'] ?? null,
      generator: this.options.generatorSha,
      resolverRevision: pin.sourceSha,
    });
  }
  /** Historical identities use their installed public generator inputs, never the
   * running epoch. The current snapshot still requires the verified running PIN.
   */
  private historical(tree: Tree, sources: GlobalSources) {
    const raw = this.publisher.read<Options>(tree, '.publisher/config.json');
    if (!raw) {
      if (sources.generator !== this.options.generatorSha)
        throw new Error('Missing historical generator inputs');
      return this;
    }
    const generatorSha = z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .parse(raw.generatorSha);
    if (generatorSha !== sources.generator) throw new Error('Historical generator mismatch');
    const facts = z
      .record(z.string(), z.object({ name: z.string(), type: z.string() }))
      .parse(raw.facts);
    return new GlobalsPublisher(
      new Publisher(this.git, {
        ...this.options,
        generatorSha,
        facts,
        aliases: aliasesSchema.parse(raw.aliases),
        aliasFacts: raw.aliasFacts,
        sandboxConflicts: raw.sandboxConflicts,
      }),
    );
  }
  store(tree: Tree): GlobalStore {
    const layout = globalLayoutSchema.parse(this.read(tree, globalsReleasePaths.layout));
    const entries = Object.keys(tree)
      .filter((path) => /^globals\/entries\/g_[\w-]+\.json$/.test(path))
      .sort()
      .map((path) => {
        const entry = entrySchema.parse(this.read(tree, path));
        if (path !== globalsReleasePaths.entry(entry.id))
          throw new Error('Global identity mismatch');
        return entry;
      });
    return reconcileGlobalStore(layout.aggregates, entries, {
      preserveNewLanguageSourceStamp: true,
    });
  }
  documents(tree: Tree, prefix: string): Record<string, Tooltip> {
    return Object.fromEntries(
      Object.keys(tree)
        .filter((path) => path.startsWith(`${prefix}/`))
        .map((path) => {
          const document = tooltipSchema.parse(this.read(tree, path));
          if (path !== `${prefix}/${document.hash}.json`)
            throw new Error('Global consumer identity mismatch');
          return [document.hash, document];
        }),
    );
  }
  canonicalDocuments(tree: Tree, prefix: string, aliases: Aliases) {
    return Object.fromEntries(
      Object.entries(this.documents(tree, prefix)).filter(
        ([, document]) => resolveAlias(document.hash, aliases) === document.hash,
      ),
    );
  }
  /**
   * The bases, and the proposals, of each batch that can still reach Current or live. A cancelled
   * or published batch is final: no Worker route or publisher step reopens it, and what it
   * published is in Current and live. The exception is a member with an open activation conflict,
   * whose stored proposal the resolve route can still write to Current. A batch that does not
   * prove its final status counts.
   */
  upcoming(tree: Tree): Record<string, Tooltip>[] {
    const batches = new Map<string, { final: boolean; sides: Record<string, Tooltip>[] }>();
    for (const path of Object.keys(tree)) {
      const id = /^schedule\/batches\/([^/]+)\/tooltips\/\d+\.json$/.exec(path)?.[1];
      if (!id) continue;
      const member = batchMemberSchema.parse(this.read(tree, path));
      let batch = batches.get(id);
      if (!batch) {
        const stored = batchSchema.safeParse(this.read(tree, schedulePaths.batch(id)));
        batch = {
          final: stored.success && stored.data.id === id && !isOpenStatus(stored.data.status),
          sides: [{}, {}],
        };
        batches.set(id, batch);
      }
      if (batch.final && !tree[schedulePaths.conflict(member.hash)]) continue;
      if (member.base) batch.sides[0][member.hash] = member.base;
      batch.sides[1][member.hash] = member.proposed;
    }
    return [...batches.values()].flatMap(({ sides }) =>
      sides.filter((documents) => Object.keys(documents).length),
    );
  }
  private liveSnapshot(
    revision: string,
    perks: z.infer<typeof livePerksSchema>,
    documents: Record<string, Tooltip>,
    types: GlobalImpactSnapshot['types'],
  ): GlobalImpactSnapshot {
    const tooltips: Record<string, Tooltip> = {};
    const aliases: Aliases = {};
    const liveTypes = { ...types };
    for (const [hash, value] of Object.entries(perks)) {
      if (typeof value.type === 'string') liveTypes[hash] = value.type;
      if (value.aliasOf === undefined) {
        if (!documents[hash]) throw new Error('Missing last-published consumer snapshot');
        tooltips[hash] = documents[hash];
      } else {
        const { aliasOf, aliasKind } = value;
        if (
          typeof aliasOf !== 'number' ||
          (aliasKind !== 'name' && aliasKind !== 'sandbox' && aliasKind !== 'frame')
        )
          throw new Error('Unknown live alias provenance');
        aliases[hash] = { to: aliasOf, kind: aliasKind };
      }
    }
    if (!tooltips[2] || !tooltips[3]) throw new Error('Missing last-published global library');
    return {
      repository: this.options.repo,
      revision,
      aliases,
      types: liveTypes,
      tooltips,
      mode: 'live',
    };
  }
  private publicationSnapshot(
    tree: Tree,
    revision: string,
    captured: ReturnType<GlobalsPublisher['capture']>,
    documents: Tooltip[],
  ) {
    // Partial publication may preserve legacy canonicals and reconcile alias groups.
    const { aliases, types } = captured.authored;
    const hashes = documents.map(({ hash }) => hash);
    const exported = exportWithInactiveMoves(
      documents,
      0,
      this.options.facts,
      aliases,
      selectedInactiveMoves(this.publisher.movesAt(tree), hashes, aliases),
    );
    const perks = livePerksSchema.parse(
      this.publisher.mergePublicationPerks(tree, captured.livePerks, exported, hashes),
    );
    const snapshot = this.liveSnapshot(
      revision,
      perks,
      {
        ...captured.live.tooltips,
        ...Object.fromEntries(
          documents
            .filter(({ hash }) => exported[hash])
            .map((document) => [document.hash, document]),
        ),
      },
      types,
    );
    return { snapshot, perks };
  }
  private async checkSavedLayout(
    tree: Tree,
    revision: string,
    captured: ReturnType<GlobalsPublisher['capture']>,
    selected: number[],
    beforeDocuments: Tooltip[],
    afterDocuments: Tooltip[],
  ) {
    const { aliases } = captured.authored;
    const moves = this.publisher.movesAt(tree);
    for (const hash of selected) {
      const requested = tooltipSchema.parse(this.read(tree, `tooltips/${hash}.json`));
      const projected = afterDocuments.find((document) => document.hash === hash)!;
      if (
        (await inactivePublishableHash(requested, aliases, moves)) !==
        (await inactivePublishableHash(projected, aliases, moves))
      )
        throw new GlobalReleaseRejected(
          `Tooltip ${hash} would publish a different revision than requested. Review the changes again.`,
        );
    }
    if (stableStringify(beforeDocuments) === stableStringify(afterDocuments)) return;
    if ('error' in this.publisher.checkAndExport(tree, afterDocuments, aliases))
      throw new GlobalReleaseRejected('The saved global layout cannot be exported');
    const before = this.publicationSnapshot(tree, revision, captured, beforeDocuments);
    const after = this.publicationSnapshot(tree, revision, captured, afterDocuments);
    const comparison = calculateGlobalImpact(
      before.snapshot,
      after.snapshot,
      [
        {
          // Title preparation covers every consumer in the existing resolver.
          kind: 'titles',
          beforeName: 'Release',
          cause: { globalId: 'g_release000', beforeRevision: null, afterRevision: 'layout' },
        },
      ],
      this.options.liveBranch,
    );
    if (
      !comparison.complete ||
      comparison.rows.some((row) => stableStringify(row.before) !== stableStringify(row.after))
    )
      throw new GlobalReleaseRejected(
        'The saved global layout changes or cannot prove consumer output',
      );

    // Layout-only changes also have to preserve the actual legacy secondary input.
    const baseline = projectGlobals(captured.published);
    const perks = { ...before.perks };
    for (const hash of selected) {
      const previous = before.snapshot.tooltips[hash];
      if (
        captured.livePerks[hash] &&
        stableStringify(previous) !== stableStringify(after.snapshot.tooltips[hash]) &&
        stableStringify(previous) === stableStringify(baseline[hash])
      )
        perks[hash] = captured.livePerks[hash];
    }
    if (
      legacyPresets.some(
        (preset) =>
          !Buffer.from(buildLegacy({ perks } as LegacyInput, preset)).equals(
            buildLegacy({ perks: after.perks } as LegacyInput, preset),
          ),
      )
    )
      throw new GlobalReleaseRejected('The saved global layout changes legacy consumer output');
  }
  private async hasReleaseChanges(
    tree: Tree,
    captured: ReturnType<GlobalsPublisher['capture']>,
    documents: Tooltip[],
    aggregateHashes: number[],
  ) {
    const markers = pushedSchema.parse(this.read(tree, 'live/pushed.json'));
    const moves = this.publisher.movesAt(tree);
    for (const document of documents) {
      // Even without a changed entry, a selected aggregate can gain or lose an alias.
      const previous = aggregateHashes.includes(document.hash)
        ? await inactivePublishableHash(document, captured.live.aliases)
        : markers[document.hash];
      const next = await inactivePublishableHash(document, captured.authored.aliases, moves);
      if (previous !== next) return true;
    }
    return false;
  }
  capture(tree: Tree, revision: string, liveCommit: string, roots: Tooltip[] = []) {
    const published = globalPublishedSchema.parse(
      this.read(tree, globalsReleasePaths.published(this.options.liveBranch)),
    );
    if (published.destination !== this.options.liveBranch)
      throw new Error('Published global destination mismatch');
    const saved = this.store(tree);
    const aliases = this.publisher.aliasesAt(tree);
    const types = Object.fromEntries(
      Object.entries(this.options.facts).map(([hash, fact]) => [hash, fact.type]),
    );
    const livePerks = z
      .object({ perks: livePerksSchema })
      .parse(this.publisher.read(this.git.tree(liveCommit), 'liveDescriptions.json')).perks;
    const inPlace = globalsFence(this.publisher, tree)?.state === 'active';
    const live = this.liveSnapshot(
      revision,
      livePerks,
      {
        ...(inPlace ? { 1: { hash: 1, associated: [], text: {} } } : {}),
        ...this.documents(tree, 'live/tooltips'),
        ...projectGlobals(published.store),
      },
      types,
    );
    const exported = inPlace
      ? {}
      : exportLegacy(Object.values(live.tooltips), 0, this.options.facts, live.aliases);
    for (const [hash, value] of Object.entries(exported)) {
      if ('aliasOf' in value) continue;
      // V2 authors main only; secondary is derived by exportLegacy. Historical secondary
      // values are not a source identity input. Compare every other field strictly, and
      // never rewrite the actual live bytes as part of this read-compatibility rule.
      const expectedEditor = structuredClone(value.editor);
      const actualEditor = structuredClone(livePerks[hash]?.editor ?? null) as Record<
        string,
        Record<string, unknown>
      > | null;
      for (const editor of [expectedEditor, actualEditor])
        if (editor && typeof editor === 'object' && !Array.isArray(editor))
          for (const cell of Object.values(editor))
            if (cell && typeof cell === 'object' && !Array.isArray(cell))
              delete (cell as Record<string, unknown>).secondary;
      if (stableStringify(expectedEditor) !== stableStringify(actualEditor))
        throw new Error('Published snapshots differ from actual live inputs');
    }
    return {
      saved,
      published: published.store,
      authored: {
        repository: this.options.repo,
        revision,
        aliases,
        types,
        tooltips: {
          ...this.canonicalDocuments(tree, 'tooltips', aliases),
          ...Object.fromEntries(roots.map((document) => [document.hash, document])),
          ...projectGlobals(saved),
        },
        mode: 'authored',
      } satisfies GlobalImpactSnapshot,
      live,
      livePerks,
    };
  }
  causes(tree: Tree): GlobalCause[] {
    const causes: GlobalCause[] = [];
    const sync = syncSchema.parse(this.read(tree, globalsReleasePaths.sync));
    for (const id of sync.causeIds) {
      const cause = pendingCauseSchema.parse(this.read(tree, `globals/causes/${id}.json`));
      if (cause.id !== id || cause.globalId !== sync.causeEntries[id])
        throw new Error('Global cause identity mismatch');
      const beforeTree = this.git.tree(cause.expectedHead);
      if (cause.before) {
        const before = entrySchema.parse(JSON.parse(this.git.blob(cause.before.blob)));
        if (
          beforeTree[cause.before.path] !== cause.before.blob ||
          before.id !== cause.globalId ||
          before.revision !== cause.before.revision
        )
          throw new Error('Unproven before global identity');
      } else if (beforeTree[globalsReleasePaths.entry(cause.globalId)])
        throw new Error('Unproven global creation');
      const after = entrySchema.parse(JSON.parse(this.git.blob(cause.after.blob)));
      if (
        after.id !== cause.globalId ||
        after.revision !== cause.after.revision ||
        cause.after.path !== globalsReleasePaths.entry(cause.globalId)
      )
        throw new Error('Unproven after global identity');
      const current = entrySchema.parse(this.read(tree, globalsReleasePaths.entry(cause.globalId)));
      causes.push({
        globalId: cause.globalId,
        beforeRevision: cause.before?.revision ?? null,
        afterRevision:
          cause.intentId &&
          current.nameHistory.some((old) => old.revision === cause.before?.revision)
            ? cause.intentId
            : cause.after.revision,
      });
    }
    for (const path of Object.keys(tree).filter((path) => path.startsWith('globals/reviews/')))
      causes.push(...rowSchema.parse(this.read(tree, path)).review.causes);
    return [...new Map(causes.map((cause) => [stableStringify(cause), cause])).values()];
  }
  async plan(tree: Tree, revision: string, live: string, roots: Tooltip[] = []) {
    await this.validateCauses(tree, revision);
    const captured = this.capture(tree, revision, live, roots);
    const causes = this.causes(tree);
    const prior = new Map<
      string,
      {
        snapshot: GlobalImpactSnapshot;
        names: Record<string, string>;
        published: GlobalImpactSnapshot;
      }
    >();
    for (const path of Object.keys(tree)
      .filter((path) => path.startsWith('globals/causes/'))
      .sort()) {
      const cause = pendingCauseSchema.parse(this.read(tree, path));
      if (
        !causes.some(
          (tuple) =>
            tuple.globalId === cause.globalId &&
            tuple.beforeRevision === (cause.before?.revision ?? null) &&
            (tuple.afterRevision === cause.after.revision ||
              tuple.afterRevision === cause.intentId),
        )
      )
        continue;
      const beforeTree = this.git.tree(cause.expectedHead),
        historical = this.historical(beforeTree, cause.beforeSources),
        before = historical.capture(beforeTree, cause.expectedHead, cause.beforeSources.live),
        beforeStore = before.saved;
      prior.set(cause.expectedHead, {
        snapshot: before.authored,
        published: before.live,
        names: Object.fromEntries(beforeStore.entries.map((entry) => [entry.id, entry.name])),
      });
    }
    // Upcoming versions are checked against their signed pin by SchedulePreparer and
    // again at claim. They must not prevent the sync that computes current review rows.
    return planGlobalRelease({
      ...captured,
      causes,
      priorAuthored: [...prior.values()],
      destination: this.options.liveBranch,
    });
  }
  private async validateCauses(tree: Tree, head: string) {
    const sync = syncSchema.parse(this.read(tree, globalsReleasePaths.sync));
    for (const id of sync.causeIds) {
      const cause = pendingCauseSchema.parse(this.read(tree, `globals/causes/${id}.json`));
      if (
        !this.git.ancestor(cause.expectedHead, head) ||
        !sameSources(
          await this.historical(this.git.tree(cause.expectedHead), cause.beforeSources).sources(
            this.git.tree(cause.expectedHead),
            cause.beforeSources.live,
            cause.expectedHead,
            true,
          ),
          cause.beforeSources,
        )
      )
        throw new Error('Unproven global cause sources');
    }
  }
  async release(
    tree: Tree,
    revision: string,
    roots: number[],
    live: string,
    batch?: { source: string; documents: Tooltip[] },
  ): Promise<GlobalRelease | undefined> {
    if (!hasGlobals(tree)) return undefined;
    const sync = syncSchema.parse(this.read(tree, globalsReleasePaths.sync));
    const sources = await this.sources(tree, live, revision);
    const captured = this.capture(tree, revision, live, batch?.documents),
      components = await this.plan(tree, revision, live, batch?.documents);
    const selected = roots.map((hash) => resolveAlias(hash, captured.authored.aliases));
    const moves = this.publisher.movesAt(tree);
    const activeSelection = selected.filter((hash) => !isMovedInactive(hash, moves));
    const aggregateHashes = captured.saved.aggregates.map(({ document }) => document.hash);
    const selectedAggregates = activeSelection.filter((hash) => aggregateHashes.includes(hash));
    const aggregate = selectedAggregates.length > 0;
    const selectedEntries = new Set(
      captured.saved.entries
        .filter((entry) => activeSelection.includes(globalAggregateHash(entry.kind)))
        .map((entry) => entry.id),
    );
    const relevant = components.filter(
      (component) =>
        component.ids.some((id) => selectedEntries.has(id)) ||
        component.rows.some((row) => activeSelection.includes(row.view.consumer.hash)) ||
        component.hashes.some(
          (hash) => !aggregateHashes.includes(hash) && activeSelection.includes(hash),
        ),
    );
    const ready = relevant.filter(
      (component) =>
        sync.status === 'current' &&
        component.rows.every((row) => {
          const stored = rowSchema.safeParse(this.read(tree, `globals/reviews/${row.id}.json`));
          return (
            stored.success &&
            sameSources(
              batch ? { ...stored.data.sources, upcoming: sources.upcoming } : stored.data.sources,
              sources,
            ) &&
            this.approved(tree, row)
          );
        }),
    );
    // Aggregate selection can release independent approved components only. A selected
    // dependent cannot silently fall back to a different global revision.
    if (
      (!aggregate && ready.length !== relevant.length) ||
      (aggregate && relevant.length && !ready.length) ||
      relevant.some(
        (component) =>
          !ready.includes(component) &&
          (component.rows.some((row) => activeSelection.includes(row.view.consumer.hash)) ||
            component.hashes.some(
              (hash) => !aggregateHashes.includes(hash) && activeSelection.includes(hash),
            )),
      )
    )
      throw new GlobalReleaseRejected('Sync pending: global dependency review required');
    const ids = ready.flatMap((component) => component.ids);
    let store = composeGlobalRelease(captured.published, captured.saved, ids);
    let entryOnlyAggregates = ready.length !== relevant.length ? selectedAggregates : [];
    const hashes = [
      ...new Set([...selected, ...ready.flatMap((component) => component.hashes)]),
    ].sort((a, b) => a - b);
    if (ids.length) {
      const markers = pushedSchema.parse(this.read(tree, 'live/pushed.json'));
      for (const hash of hashes) {
        const stored = this.read(tree, `live/tooltips/${hash}.json`);
        if (
          await hasUnpublishedInactiveMove(
            hash,
            stored === undefined ? null : tooltipSchema.parse(stored),
            markers[hash],
            captured.authored.aliases,
            moves,
          )
        )
          throw new GlobalReleaseRejected(
            'Publish inactive move decisions before releasing global dependencies',
          );
      }
    }
    const globals = projectGlobals(store);
    if (batch) for (const hash of aggregateHashes) if (!hashes.includes(hash)) hashes.push(hash);
    hashes.sort((a, b) => a - b);
    let documents = hashes.map((hash) => {
      if (aggregateHashes.includes(hash) && !globals[hash])
        throw new Error(`Missing published layout for aggregate ${hash}`);
      const document =
        globals[hash] ??
        captured.authored.tooltips[hash] ??
        captured.live.tooltips[hash] ??
        (!batch && selected.includes(hash) && isMovedInactive(hash, moves)
          ? { hash, text: {}, associated: [] }
          : undefined);
      if (!document) throw new Error('Deleted release dependency');
      return document;
    });
    if (aggregate && !entryOnlyAggregates.length) {
      // Entry approvals cover the v2 composition. Use the saved layout only
      // if it matches the request and preserves that composition's output.
      try {
        if (sync.status !== 'current')
          throw new GlobalReleaseRejected('Sync pending: global dependency review required');
        const exact = {
          ...store,
          aggregates: store.aggregates.map((layout) =>
            selectedAggregates.includes(layout.document.hash)
              ? captured.saved.aggregates.find(
                  ({ document }) => document.hash === layout.document.hash,
                )!
              : layout,
          ),
        };
        const projected = projectGlobals(exact);
        const exactDocuments = documents.map((document) => projected[document.hash] ?? document);
        await this.checkSavedLayout(
          tree,
          revision,
          captured,
          selectedAggregates,
          documents,
          exactDocuments,
        );
        store = exact;
        documents = exactDocuments;
      } catch (error) {
        if (
          !ids.length &&
          !(await this.hasReleaseChanges(tree, captured, documents, aggregateHashes))
        )
          throw error instanceof GlobalReleaseRejected
            ? error
            : new GlobalReleaseRejected(
                'The saved global layout changes or cannot prove consumer output',
              );
        entryOnlyAggregates = selectedAggregates;
      }
    }
    const published = globalPublishedSchema.parse({
      version: 1,
      destination: this.options.liveBranch,
      store,
    });
    if (batch) {
      if (!this.git.ancestor(batch.source, revision))
        throw new Error('Scheduled global source is not in data branch history');
      const sourceTree = this.git.tree(batch.source);
      if (!hasGlobals(sourceTree))
        throw new Error('Globals were added after scheduling; return to draft and schedule again');
      const sourcePin = this.read(sourceTree, '.publisher/PIN') as
        { sourceSha?: string; sha256?: string } | undefined;
      if (
        sourcePin?.sourceSha !== this.options.publisherSha ||
        sourcePin.sha256 !== this.options.publisherDigest
      )
        throw new Error(
          'The global resolver changed after scheduling; return to draft and schedule again',
        );
      const sourceConfig = z
        .object({ generatorSha: z.string().regex(/^[a-f0-9]{40}$/) })
        .safeParse(this.read(sourceTree, '.publisher/config.json'));
      if (!sourceConfig.success)
        throw new Error(
          'Pinned global generator provenance is missing; return to draft and schedule again',
        );
      if (sourceConfig.data.generatorSha !== this.options.generatorSha)
        throw new Error(
          'The global generator changed after scheduling; return to draft and schedule again',
        );
      const sourceAliases = this.publisher.aliasesAt(sourceTree);
      const { snapshot } = this.publicationSnapshot(tree, revision, captured, documents);
      const pinned = this.store(sourceTree);
      const pinnedDocuments = this.canonicalDocuments(sourceTree, 'live/tooltips', sourceAliases);
      for (const document of documents)
        if (selected.includes(document.hash)) pinnedDocuments[document.hash] = document;
        else if (!aggregateHashes.includes(document.hash)) {
          const original = this.read(sourceTree, `tooltips/${document.hash}.json`);
          if (!original) throw new Error('Scheduled imported dependency was deleted');
          pinnedDocuments[document.hash] = tooltipSchema.parse(original);
        }
      const originalSnapshot = {
        ...snapshot,
        revision: batch.source,
        aliases: sourceAliases,
        types: captured.authored.types,
        tooltips: { ...pinnedDocuments, ...projectGlobals(pinned) },
      };
      const comparison = calculateGlobalImpact(
        originalSnapshot,
        snapshot,
        [
          {
            kind: 'titles',
            beforeName: 'Release',
            cause: { globalId: 'g_release000', beforeRevision: null, afterRevision: 'pin' },
          },
        ],
        this.options.liveBranch,
      );
      if (!comparison.complete)
        throw new Error('Scheduled global dependency closure is incomplete');
      const selectedRows = comparison.rows.filter(
        ({ consumer }) =>
          selected.includes(resolveAlias(consumer.hash, originalSnapshot.aliases)) ||
          selected.includes(resolveAlias(consumer.hash, snapshot.aliases)),
      );
      if (selectedRows.some((row) => stableStringify(row.before) !== stableStringify(row.after)))
        throw new Error(
          'Global dependencies changed after scheduling; return to draft and schedule again',
        );
      const reads = selectedRows.map((row) => row.after!.reads);
      const used = store.entries.filter(
        (entry) =>
          entry.kind === 'titles' ||
          reads.some(
            (read) =>
              (entry.kind === 'variables' && read.variables.includes(entry.name)) ||
              read.imports.some(
                (dependency) => dependency.hash === globalAggregateHash(entry.kind),
              ),
          ),
      );
      for (const entry of used) {
        const original = pinned.entries.find((candidate) => candidate.id === entry.id);
        const current = captured.saved.entries.find((candidate) => candidate.id === entry.id);
        if (
          stableStringify(original) !== stableStringify(entry) ||
          stableStringify(current) !== stableStringify(entry)
        )
          throw new Error(
            `Global ${entry.name} changed after scheduling; return to draft and schedule again`,
          );
      }
      // Removing or renaming a used definition must not turn it into an unobserved absence.
      for (const entry of pinned.entries)
        if (
          (entry.kind === 'titles' ||
            reads.some(
              (read) =>
                (entry.kind === 'variables' && read.variables.includes(entry.name)) ||
                read.imports.some(
                  (dependency) => dependency.hash === globalAggregateHash(entry.kind),
                ),
            )) &&
          !used.some((candidate) => candidate.id === entry.id)
        )
          throw new Error(
            `Global ${entry.name} changed after scheduling; return to draft and schedule again`,
          );
    }
    const digest = await globalIdentityDigest({
      sourceCommit: revision,
      sources,
      ids,
      documents,
      published,
      rows: ready.flatMap((component) => component.rows),
    });
    const receipt: GlobalReleaseReceipt = {
      version: 1,
      roots,
      sources,
      digest,
      published,
      ...(batch ? { batchSource: batch.source } : {}),
    };
    return { documents, receipt, entryOnlyAggregates };
  }
  async validate(
    receipt: GlobalReleaseReceipt | undefined,
    tree: Tree,
    head: string,
    live: string,
    cached?: GlobalRelease,
  ) {
    if (!hasGlobals(tree) && !receipt) return undefined;
    if (!receipt || receipt.version !== 1) throw new Error('Global release receipt required');
    const checked = cached ?? (await this.release(tree, head, receipt.roots, live));
    if (
      !checked ||
      checked.receipt.digest !== receipt.digest ||
      stableStringify(checked.receipt.published) !== stableStringify(receipt.published)
    )
      throw new Error('Global release changed since review');
    return checked;
  }
  /** Current permission check also applies to old acknowledgements at drain/recovery. */
  approved(tree: Tree, row: GlobalReleaseComponent['rows'][number]): boolean {
    const stored = rowSchema.safeParse(this.read(tree, `globals/reviews/${row.id}.json`));
    if (!stored.success) return false;
    const audit = stored.data.review.acknowledgement;
    if (
      !audit ||
      audit.contentDigest !== row.contentDigest ||
      audit.dependencyDigest !== row.dependencyDigest ||
      audit.impactDigest !== row.impactDigest
    )
      return false;
    const access = Object.values(
      permissionsSchema.parse(this.read(tree, 'config/permissions.json')).users,
    ).find((user) => user.login === audit.by);
    return (
      !!access &&
      (['maintainer', 'editor'].includes(access.role) ||
        (access.role === 'translator' &&
          row.view.consumer.lang !== 'en' &&
          !!access.languages?.includes(row.view.consumer.lang)))
    );
  }
  private async materialize(tree: Tree, head: string, live: string) {
    const store = this.store(tree);
    const sources = await this.sources(tree, live, head);
    const components = globalsFence(this.publisher, tree) ? [] : await this.plan(tree, head, live);
    const oldRows = new Map(
      Object.keys(tree)
        .filter((path) => path.startsWith('globals/reviews/'))
        .map((path) => [path, this.read(tree, path)]),
    );
    for (const path of Object.keys(tree).filter(
      (path) => path.startsWith('globals/reviews/') || path.startsWith('globals/review-pages/'),
    ))
      delete tree[path];
    const rowsByEntry = new Map<string, string[]>();
    const captured = this.capture(tree, head, live);
    for (const component of components)
      for (const row of component.rows) {
        const path = `globals/reviews/${row.id}.json`;
        const old = rowSchema.safeParse(oldRows.get(path));
        const audit = old.success ? old.data.review.acknowledgement : undefined;
        const keep =
          audit &&
          old.success &&
          old.data.sources.config === sources.config &&
          old.data.sources.generator === sources.generator &&
          old.data.sources.fallback === sources.fallback &&
          old.data.sources.resolver === sources.resolver &&
          audit.contentDigest === row.contentDigest &&
          audit.dependencyDigest === row.dependencyDigest &&
          audit.impactDigest === row.impactDigest;
        const name =
          this.options.facts[row.view.consumer.hash]?.name ?? String(row.view.consumer.hash);
        const value = rowSchema.parse({
          version: 1,
          complete: true,
          sources,
          id: row.id,
          projected: false,
          impactDigest: row.impactDigest,
          review: {
            version: 1,
            consumer: row.view.consumer,
            causes: row.view.causes,
            contentDigest: row.contentDigest,
            dependencyDigest: row.dependencyDigest,
            ...(keep ? { acknowledgement: audit } : {}),
          },
          view: {
            ...row.view,
            variant: 0,
            name,
            category: this.options.facts[row.view.consumer.hash]?.type ?? '',
            line: null,
            path: null,
            direct: null,
            archived: !!captured.authored.tooltips[row.view.consumer.hash]?.archive,
            beforeSource: row.beforeSource,
            afterSource: row.afterSource,
          },
        });
        this.write(tree, path, value, limits.entryBytes);
        for (const id of new Set(row.view.causes.map(({ globalId }) => globalId)))
          rowsByEntry.set(id, [...(rowsByEntry.get(id) ?? []), row.id]);
      }
    for (const entry of store.entries) {
      const ids = [...new Set(rowsByEntry.get(entry.id) ?? [])].sort();
      for (let page = 0; page === 0 || page * limits.page < ids.length; page++)
        this.write(
          tree,
          `globals/review-pages/${entry.id}/p${page}.json`,
          {
            version: 1,
            complete: true,
            sources,
            ids: ids.slice(page * limits.page, (page + 1) * limits.page),
            nextCursor: (page + 1) * limits.page < ids.length ? `p${page + 1}` : null,
          },
          limits.metadataBytes,
        );
    }
    await this.proofs(tree, head, sources, live, components);
  }
  async record(tree: Tree, receipt: GlobalReleaseReceipt, head: string, live: string) {
    const path = globalsReleasePaths.published(this.options.liveBranch);
    const previous = globalPublishedSchema.parse(this.read(tree, path));
    const released = changedGlobalIds(previous.store, receipt.published.store);
    for (const rowPath of Object.keys(tree).filter((path) => path.startsWith('globals/reviews/'))) {
      const row = rowSchema.parse(this.read(tree, rowPath));
      if (row.review.causes.some((cause) => released.includes(cause.globalId)))
        delete tree[rowPath];
    }
    // Full offline baselines are not the bounded per-entry Worker metadata format.
    tree[path] = this.git.writeBlob(json(globalPublishedSchema.parse(receipt.published)));
    if (syncSchema.parse(this.read(tree, globalsReleasePaths.sync)).status === 'current') {
      // Refresh remaining independent proofs in THIS transaction. GITHUB_TOKEN
      // commits do not need to start a second workflow to make the queue progress.
      await this.materialize(tree, head, live);
      for (const retry of Object.keys(tree).filter((path) => path.startsWith('globals/retries/')))
        delete tree[retry];
    }
  }
  async drain(expectedHead?: string) {
    // One coalesced pass over all requests, not one drain per trigger or retry file.
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = this.publisher.head(this.options.dataBranch),
        original = this.git.tree(head);
      if (expectedHead !== undefined && head !== expectedHead)
        throw new RefRace('Global sync source moved');
      if (!hasGlobals(original)) return head;
      const fence = globalsFence(this.publisher, original);
      if (fence?.state === 'hold') return head;
      const tree = { ...original };
      try {
        const sync = syncSchema.parse(this.read(tree, globalsReleasePaths.sync));
        this.causes(tree); // Require the complete durable backlog before modifying anything.
        await this.intents(tree, head);
        await this.releaseObsoleteClaims(tree);
        const store = this.store(tree);
        tree[globalsReleasePaths.layout] = this.git.writeBlob(
          json(globalLayoutSchema.parse({ version: 1, aggregates: store.aggregates })),
        );
        for (const [hash, document] of Object.entries(projectGlobals(store)))
          tree[`tooltips/${hash}.json`] = this.git.writeBlob(json(document));
        for (const path of Object.keys(tree).filter((path) =>
          path.startsWith('globals/projections/'),
        ))
          delete tree[path];
        const live = this.publisher.head(this.options.liveBranch);
        await this.materialize(tree, head, live);
        if (fence)
          for (const path of Object.keys(tree).filter((path) => path.startsWith('globals/causes/')))
            delete tree[path];
        // All request removals and pending completion land with ALL authoritative outputs.
        for (const path of Object.keys(tree).filter((path) => path.startsWith('globals/retries/')))
          delete tree[path];
        this.write(
          tree,
          globalsReleasePaths.sync,
          syncSchema.parse(currentSync),
          limits.entryBytes,
        );
        if (this.publisher.head(this.options.liveBranch) !== live)
          throw new RefRace('Global live inputs raced');
        if (stableStringify(tree) === stableStringify(original)) return head;
        const commit = this.git.commit(
          head,
          tree,
          `Sync ${sync.causeIds.length} global causes`,
          appCredits,
        );
        this.git.cas(`refs/heads/${this.options.dataBranch}`, head, commit);
        return commit;
      } catch (error) {
        if (error instanceof RefRace) continue;
        // Failure preserves every cause/row. Independent occupied-name proofs keep
        // same-name body repair possible without approving any release/removal.
        const sync = syncSchema.safeParse(this.read(original, globalsReleasePaths.sync));
        if (sync.success && sync.data.causeIds.length) {
          let failed = { ...original };
          this.write(
            failed,
            globalsReleasePaths.sync,
            syncSchema.parse({
              ...sync.data,
              status: 'sync-failed',
              lastFailure: 'Sync failed. Retry sync.',
            }),
            limits.entryBytes,
          );
          try {
            const live = this.publisher.head(this.options.liveBranch);
            const proofs = { ...failed };
            await this.occupiedProofs(proofs, head, live);
            if (this.publisher.head(this.options.liveBranch) !== live)
              throw new RefRace('Global proof inputs raced');
            failed = proofs;
          } catch (proofError) {
            if (proofError instanceof RefRace) continue;
            // An incomplete declaration/fallback census produces NO new proof.
          }
          try {
            if (stableStringify(failed) === stableStringify(original)) throw error;
            this.git.cas(
              `refs/heads/${this.options.dataBranch}`,
              head,
              this.git.commit(head, failed, 'Record global sync failure', appCredits),
            );
          } catch (race) {
            if (race instanceof RefRace) continue;
            throw race;
          }
        }
        throw error;
      }
    }
    throw new Error('Sync pending: global inputs kept moving');
  }

  private async intents(tree: Tree, head: string) {
    const seen = new Set<string>();
    const current = await this.sources(tree, this.publisher.head(this.options.liveBranch), head);
    for (const path of Object.keys(tree)
      .filter((path) => path.startsWith('globals/intents/'))
      .sort()) {
      const intent = intentSchema.parse(this.read(tree, path));
      const entryPath = globalsReleasePaths.entry(intent.globalId),
        entry = entrySchema.parse(this.read(tree, entryPath));
      const claimPath = (await namePaths(entry.kind, intent.name)).claim;
      const claim = this.read(tree, claimPath) as { intentId?: string } | undefined;
      const access = Object.values(
        permissionsSchema.parse(this.read(tree, 'config/permissions.json')).users,
      ).find((user) => user.login === intent.by);
      const key = `${intent.globalId}:${intent.revision}`;
      const accepted =
        !seen.has(key) &&
        entry.revision === intent.revision &&
        !entry.tombstone &&
        claim?.intentId === intent.id &&
        !!access &&
        ['editor', 'maintainer'].includes(access.role) &&
        this.git.ancestor(intent.expectedHead, head) &&
        (
          ['config', 'live', 'upcoming', 'aliases', 'generator', 'fallback', 'resolver'] as const
        ).every((key) => current[key] === intent.sources[key]) &&
        sameSources(
          await this.historical(this.git.tree(intent.expectedHead), intent.sources).sources(
            this.git.tree(intent.expectedHead),
            intent.sources.live,
            intent.expectedHead,
            true,
          ),
          intent.sources,
        );
      seen.add(key);
      if (claim?.intentId === intent.id) delete tree[claimPath];
      delete tree[path];
      // Refusal/supersession releases the reservation in the same commit. History is audit.
      if (!accepted) continue;
      const before = this.store(tree),
        next = structuredClone(entry);
      next.nameHistory.push({
        name: entry.name,
        revision: entry.revision,
        at: intent.at,
        by: intent.by,
      });
      next.name = intent.name;
      next.revision = intent.id;
      const all = before.entries.map((candidate) =>
        candidate.id === next.id ? next : structuredClone(candidate),
      );
      for (const candidate of all)
        for (const definition of Object.values(candidate.definitions)) {
          const rewritten = rewriteGlobalReferences(
            definition.body,
            entry.kind,
            entry.name,
            intent.name,
          );
          if (rewritten.edits.length) {
            definition.body = rewritten.text;
            definition.revision = intent.id;
            candidate.revision = intent.id;
          }
        }
      const documents = this.documents(tree, 'tooltips');
      for (const document of Object.values(documents)) {
        if (before.aggregates.some((aggregate) => aggregate.document.hash === document.hash))
          continue;
        for (const cell of Object.values(document.text))
          cell.text = rewriteGlobalReferences(cell.text, entry.kind, entry.name, intent.name).text;
      }
      const after = reconcileGlobalStore(before.aggregates, all, {
        preserveNewLanguageSourceStamp: true,
      });
      assertGlobalTransition(before, after, documents);
      for (const candidate of after.entries)
        this.write(
          tree,
          globalsReleasePaths.entry(candidate.id),
          entrySchema.parse(candidate),
          limits.entryBytes,
        );
      for (const document of Object.values(documents))
        tree[`tooltips/${document.hash}.json`] = this.git.writeBlob(json(document));
      this.write(
        tree,
        claimPath,
        { id: entry.id, kind: entry.kind, name: intent.name },
        limits.metadataBytes,
      );
      delete tree[(await namePaths(entry.kind, entry.name)).claim];
    }
  }
  private async releaseObsoleteClaims(tree: Tree) {
    const claimSchema = z
      .object({
        id: entrySchema.shape.id,
        kind: entrySchema.shape.kind,
        name: z.string(),
        intentId: z.string().optional(),
      })
      .strict();
    for (const path of Object.keys(tree).filter((path) => path.startsWith('globals/names/'))) {
      const claim = claimSchema.parse(this.read(tree, path));
      if (path !== (await namePaths(claim.kind, claim.name)).claim)
        throw new Error('Global name claim identity mismatch');
      const entry = entrySchema.parse(this.read(tree, globalsReleasePaths.entry(claim.id)));
      if (entry.id !== claim.id || entry.kind !== claim.kind)
        throw new Error('Global name claim owner mismatch');
      if (entry.tombstone || entry.name !== claim.name || claim.intentId) delete tree[path];
    }
  }
  /** A name census is independent of render-impact completeness. In particular,
   * import cycles cannot prevent the same-name body edit needed to repair them.
   * Only occupied names are certified here; no release/removal proof is produced.
   */
  private localNames(tree: Tree, captured: ReturnType<GlobalsPublisher['capture']>) {
    const documents = [
      ...Object.values(this.documents(tree, 'tooltips')),
      ...Object.values(captured.live.tooltips),
      ...Object.values(projectGlobals(captured.saved)),
      ...this.upcoming(tree).flatMap((documents) => Object.values(documents)),
    ];
    const localNames = new Set<string>();
    // Finish the ENTIRE authored/live/upcoming fallback census before writing any
    // proof. All import sources are included, including stored alias archives.
    for (const document of documents)
      for (const mode of ['authored', 'live'] as const)
        for (const lang of languages) {
          const source = globalSourceText(document, lang, mode) ?? '';
          const localSources =
            document.hash === 2
              ? []
              : document.hash === 3 || document.hash === 1
                ? Object.values(extractBlocks(source, document.hash === 1 ? 'export' : 'title'))
                : [source];
          for (const text of localSources) {
            for (const name of Object.keys(extractBlocks(text, 'export')))
              localNames.add(`export:${name}`);
            for (const definition of markupDefinitions(text))
              localNames.add(`${definition.kind}:${definition.name}`);
          }
        }
    return localNames;
  }
  private async occupiedProofs(tree: Tree, head: string, live: string) {
    const captured = this.capture(tree, head, live);
    const sources = await this.sources(tree, live, head);
    const localNames = this.localNames(tree, captured);
    for (const entry of captured.saved.entries) {
      if (entry.tombstone) continue;
      const path = (await namePaths(entry.kind, entry.name)).proof;
      const other = captured.published.entries.some(
        (published) =>
          !published.tombstone &&
          published.id !== entry.id &&
          published.kind === entry.kind &&
          published.name === entry.name,
      );
      if (
        other ||
        localNames.has(
          `${entry.kind === 'variables' ? 'variable' : entry.kind === 'exports' ? 'export' : 'title'}:${entry.name}`,
        )
      ) {
        delete tree[path];
        continue;
      }
      this.write(
        tree,
        path,
        clashSchema.parse({
          version: 1,
          complete: true,
          sources,
          kind: entry.kind,
          name: entry.name,
          occupiedBy: entry.id,
          localClash: false,
          coverage: 'authored-live-upcoming-fallback',
        }),
        limits.metadataBytes,
      );
    }
  }

  private async proofs(
    tree: Tree,
    head: string,
    sources: GlobalSources,
    live: string,
    components: GlobalReleaseComponent[],
  ) {
    const captured = this.capture(tree, head, live),
      requested = new Map<string, { kind: GlobalRecord['kind']; name: string }>();
    const inPlace = Boolean(globalsFence(this.publisher, tree));
    for (const entry of captured.saved.entries)
      if (!entry.tombstone) requested.set(`${entry.kind}:${entry.name}`, entry);
    for (const path of Object.keys(tree).filter((path) => path.startsWith('globals/retries/'))) {
      const raw = this.read(tree, path) as { type?: unknown };
      if (raw?.type !== 'name-proof') continue;
      const request = nameProofRequestSchema.parse(raw);
      requested.set(`${request.kind}:${request.name}`, request);
    }
    const snapshots = [
      captured.authored,
      captured.live,
      ...this.upcoming(tree).flatMap((documents) =>
        (['authored', 'live'] as const).map((mode) => ({
          ...captured.authored,
          mode,
          tooltips: { ...captured.authored.tooltips, ...documents },
        })),
      ),
    ];
    // Alias-member archives are not effective canonical renders. Their authored
    // declarations/references still prevent name clashes and physical removal.
    const authoredSources = { ...captured.authored, tooltips: this.documents(tree, 'tooltips') };
    const localNames = this.localNames(tree, captured);
    const scans = new GlobalSnapshotScans();
    // Establish resolver coverage even when there are no changed globals.
    for (const snapshot of inPlace ? [] : snapshots) {
      const validation = calculateGlobalImpact(
        snapshot,
        snapshot,
        [],
        this.options.liveBranch,
        scans,
      );
      if (!validation.complete) throw new Error('Sync pending: proof coverage is incomplete');
    }
    for (const path of Object.keys(tree).filter((path) =>
      path.startsWith('globals/proofs/publication/'),
    ))
      delete tree[path];
    const moves = this.publisher.movesAt(tree);
    const entryAggregates = new Map(
      captured.saved.entries.map(({ id, kind }) => [id, globalAggregateHash(kind)]),
    );
    const hashes = new Set(Object.keys(captured.authored.tooltips).map(Number));
    for (const key of Object.keys(moves)) {
      const hash = Number(key);
      if (isMovedInactive(hash, moves) && resolveAlias(hash, captured.authored.aliases) === hash)
        hashes.add(hash);
    }
    for (const hash of inPlace ? [] : hashes)
      for (const lang of [
        ...new Set([
          ...Object.keys(captured.authored.tooltips[hash]?.text ?? {}),
          ...(isMovedInactive(hash, moves) ? ['en'] : []),
        ]),
      ]) {
        // A canonical removal exports no language body. This English-keyed
        // operation proof is pinned to the current inactive decision.
        const aggregate = captured.saved.aggregates.some(({ document }) => document.hash === hash);
        const relevant = isMovedInactive(hash, moves)
          ? []
          : components.filter(
              (component) =>
                (aggregate && component.ids.some((id) => entryAggregates.get(id) === hash)) ||
                component.rows.some(
                  (row) => row.view.consumer.hash === hash && row.view.consumer.lang === lang,
                ),
            );
        const ready = relevant.filter((component) =>
          component.rows.every((row) => this.approved(tree, row)),
        );
        if (
          aggregate ? relevant.length > 0 && ready.length === 0 : ready.length !== relevant.length
        )
          continue;
        const consumer = { hash, lang, destination: this.options.liveBranch };
        this.write(
          tree,
          `globals/proofs/publication/${this.options.liveBranch}/${hash}-${lang}.json`,
          publicationSchema.parse({
            version: 1,
            complete: true,
            sources,
            consumer,
            causeIds: [],
            independent: relevant.length === 0,
            approved: true,
          }),
          limits.metadataBytes,
        );
      }
    // A missing per-consumer proof is only a wait when this materialization is stale.
    if (!inPlace)
      this.write(
        tree,
        publicationSourcesPath(this.options.liveBranch),
        sources,
        limits.metadataBytes,
      );
    else delete tree[publicationSourcesPath(this.options.liveBranch)];
    for (const request of requested.values()) {
      const owners = [...captured.saved.entries, ...captured.published.entries].filter(
        (entry) => !entry.tombstone && entry.kind === request.kind && entry.name === request.name,
      );
      const occupied = owners[0];
      const localClash = localNames.has(
        `${request.kind === 'variables' ? 'variable' : request.kind === 'exports' ? 'export' : 'title'}:${request.name}`,
      );
      const path = (await namePaths(request.kind, request.name)).proof;
      if (localClash || new Set(owners.map((entry) => entry.id)).size > 1) {
        delete tree[path];
        continue;
      }
      this.write(
        tree,
        path,
        clashSchema.parse({
          version: 1,
          complete: true,
          sources,
          kind: request.kind,
          name: request.name,
          occupiedBy: occupied?.id ?? null,
          localClash: false,
          coverage: 'authored-live-upcoming-fallback',
        }),
        limits.metadataBytes,
      );
    }
    for (const entry of captured.saved.entries)
      for (const lang of [undefined, ...(Object.keys(entry.definitions) as Lang[])]) {
        const names = [
          ...new Set(
            [
              entry.name,
              captured.published.entries.find((published) => published.id === entry.id)?.name,
            ].filter((name): name is string => name !== undefined),
          ),
        ];
        const path = `globals/proofs/removal/${entry.id}-${lang ?? 'all'}.json`;
        delete tree[path];
        const referenced = snapshots.some((snapshot) => {
          const change = {
            cause: {
              globalId: entry.id,
              beforeRevision: entry.revision,
              afterRevision: entry.revision,
            },
            kind: entry.kind,
            beforeName: names[0],
            afterName: entry.name,
            ...(lang ? { languages: [lang] } : {}),
          };
          const impact = calculateGlobalImpact(
            snapshot,
            snapshot,
            names.map((name) => ({ ...change, beforeName: name })),
            this.options.liveBranch,
            scans,
          );
          return (
            !impact.complete ||
            impact.rows.length ||
            languages.some(
              (language) =>
                (!lang || language === lang || lang === 'en') &&
                names.some((name) => scans.references(snapshot, entry.kind, language).has(name)),
            )
          );
        });
        const authoredReference = languages.some((language) =>
          names.some((name) => scans.references(authoredSources, entry.kind, language).has(name)),
        );
        if (!referenced && !authoredReference)
          this.write(
            tree,
            path,
            removalSchema.parse({
              version: 1,
              complete: true,
              sources,
              id: entry.id,
              revision: entry.revision,
              lang: lang ?? null,
              references: {
                authored: 0,
                effective: 0,
                live: 0,
                upcoming: 0,
                unresolved: 0,
                conservativeTitles: 0,
              },
            }),
            limits.metadataBytes,
          );
      }
  }
}
