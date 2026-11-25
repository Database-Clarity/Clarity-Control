import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  emptyGitTree,
  globalConfigIdentity,
  globalLayoutSchema,
  globalPublishedSchema,
  globalsReleasePaths,
  globalsConfigWithoutMarks,
  observeGlobalSources,
  reconcileGlobalStore,
  type GlobalSources,
} from '../../packages/core/src/globalsRelease/index.js';
import { type GlobalRecord, type GlobalStore } from '../../packages/core/src/globals/model.js';
import { projectGlobals } from '../../packages/core/src/globals/projection.js';
import { assertGlobalTransition } from '../../packages/core/src/globals/transition.js';
import { globalSourceText } from '../../packages/core/src/globals/source.js';
import {
  assertHistoricalSecondaries,
  globalsFence,
  requireGlobalsMode,
  liveGlobalsInput,
  withdrawalIssue,
} from './globalsInPlace.js';
import { rewriteGlobalReferences } from '../../packages/core/src/globals/references.js';
import { markupDefinitions } from '../../packages/core/src/markup/clashes.js';
import { extractBlocks } from '../../packages/core/src/markup/syntax.js';
import { languages, type Lang } from '../../packages/core/src/languages.js';
import { permissionsSchema, tooltipSchema, type Tooltip } from '../../packages/core/src/schemas.js';
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
  removalSchema,
  sameSources,
  sourcesSchema,
  syncSchema,
  type SyncState,
  catalogSchema,
  pageSchema,
  paths as entryPaths,
} from '../../apps/worker/src/globals/model.js';
import { namePaths, publicGlobalSync } from '../../apps/worker/src/globals/handlers.js';
import { appCredits, RefRace, type Tree } from './git.js';
import { ConsumerOutputRejected, Publisher, type Options } from './publisher.js';

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
 * public sync header, both at this tree. The Worker serves the opened entry and writes.
 * Throws on any malformed or inconsistent catalogue file.
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
class MissingPublishedSnapshot extends Error {}

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
        if (!documents[hash])
          throw new MissingPublishedSnapshot('Missing last-published consumer snapshot');
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
  capture(tree: Tree, revision: string, liveCommit: string) {
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
          ...projectGlobals(saved),
        },
        mode: 'authored',
      } satisfies GlobalImpactSnapshot,
      live,
      livePerks,
    };
  }
  private assertPendingChanges(tree: Tree, sync: SyncState) {
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
      entrySchema.parse(this.read(tree, globalsReleasePaths.entry(cause.globalId)));
    }
  }
  async recordProofs(tree: Tree, head: string, live: string) {
    if (syncSchema.parse(this.read(tree, globalsReleasePaths.sync)).status !== 'current') return;
    const sources = await this.sources(tree, live, head);
    try {
      await this.proofs(tree, head, sources, live);
    } catch (error) {
      if (!(error instanceof MissingPublishedSnapshot)) throw error;
    }
  }
  /** Apply authored rename intents and refresh projections and guards in one DATA commit. */
  async maintainAuthored(expectedHead?: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = this.publisher.head(this.options.dataBranch);
      if (expectedHead !== undefined && head !== expectedHead)
        throw new RefRace('Authored global source moved');
      const original = this.git.tree(head);
      requireGlobalsMode(this.publisher, original);
      const tree = { ...original };
      const live = this.publisher.head(this.options.liveBranch);
      const sync = syncSchema.parse(this.read(tree, globalsReleasePaths.sync));
      try {
        this.assertPendingChanges(tree, sync);
        await this.intents(tree, head, live);
        await this.releaseObsoleteClaims(tree);
        const store = this.store(tree);
        tree[globalsReleasePaths.layout] = this.git.writeBlob(
          json(globalLayoutSchema.parse({ version: 1, aggregates: store.aggregates })),
        );
        for (const [hash, document] of Object.entries(projectGlobals(store)))
          tree[`tooltips/${hash}.json`] = this.git.writeBlob(json(document));
        for (const path of Object.keys(tree))
          if (path.startsWith('globals/projections/')) delete tree[path];
        const sources = await this.sources(tree, live, head);
        await this.proofs(tree, head, sources, live);
        for (const path of Object.keys(tree))
          if (path.startsWith('globals/causes/') || path.startsWith('globals/retries/'))
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
        const commit = this.git.commit(head, tree, 'Update authored globals', appCredits);
        this.git.cas(`refs/heads/${this.options.dataBranch}`, head, commit);
        return commit;
      } catch (error) {
        if (error instanceof RefRace) continue;
        if (error instanceof MissingPublishedSnapshot) return head;
        // Invalid alias settings cannot prove names or removals. Leave the existing proofs
        // fenced to their source and let ordinary requests record their own refusal.
        if (sync.status === 'current' && error instanceof ConsumerOutputRejected) return head;
        throw error;
      }
    }
    throw new RefRace('Authored global inputs kept moving');
  }

  private async intents(tree: Tree, head: string, live: string) {
    const seen = new Set<string>();
    const current = await this.sources(tree, live, head);
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
            true,
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
          cell.text = rewriteGlobalReferences(
            cell.text,
            entry.kind,
            entry.name,
            intent.name,
            true,
          ).text;
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
  private async proofs(tree: Tree, head: string, sources: GlobalSources, live: string) {
    const captured = this.capture(tree, head, live),
      requested = new Map<string, { kind: GlobalRecord['kind']; name: string }>();
    for (const entry of captured.saved.entries)
      if (!entry.tombstone) requested.set(`${entry.kind}:${entry.name}`, entry);
    for (const path of Object.keys(tree).filter((path) => path.startsWith('globals/retries/'))) {
      const raw = this.read(tree, path) as { type?: unknown };
      if (raw?.type !== 'name-proof') continue;
      const request = nameProofRequestSchema.parse(raw);
      requested.set(`${request.kind}:${request.name}`, request);
    }
    const localNames = this.localNames(tree, captured);
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
    const removalDocs = [
      ...Object.values(this.documents(tree, 'tooltips')),
      ...Object.values(captured.live.tooltips),
      ...this.upcoming(tree).flatMap(Object.values),
    ].filter(({ hash }) => hash > 3);
    const liveInput = liveGlobalsInput(this.publisher, live);
    const publishedById = new Map(captured.published.entries.map((entry) => [entry.id, entry]));
    for (const entry of captured.saved.entries) {
      const previous = publishedById.get(entry.id) ?? entry;
      const issue = withdrawalIssue(
        entry,
        previous,
        captured.saved,
        captured.published,
        removalDocs,
      );
      let clear = !issue;
      if (clear) {
        try {
          assertHistoricalSecondaries(this.publisher, tree, liveInput, [entry]);
        } catch {
          clear = false;
        }
      }
      for (const lang of [undefined, ...(Object.keys(entry.definitions) as Lang[])]) {
        const path = `globals/proofs/removal/${entry.id}-${lang ?? 'all'}.json`;
        delete tree[path];
        if (!clear || (lang && lang !== 'en')) continue;
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
}
