import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  emptyGitTree,
  globalIdentityDigest,
  globalLayoutSchema,
  globalPublishedSchema,
  globalsReleasePaths,
  observeGlobalSources,
  planGlobalRelease,
  reconcileGlobalStore,
  composeGlobalRelease,
  changedGlobalIds,
  type GlobalSources,
  type GlobalReleaseComponent,
} from '../../packages/core/src/globalsRelease/index.js';
import { type GlobalCause, type GlobalStore } from '../../packages/core/src/globals/model.js';
import { calculateGlobalImpact } from '../../packages/core/src/globals/impact.js';
import { projectGlobals } from '../../packages/core/src/globals/projection.js';
import { assertGlobalTransition } from '../../packages/core/src/globals/transition.js';
import { globalSourceText } from '../../packages/core/src/globals/source.js';
import {
  globalReferenceSpans,
  rewriteGlobalReferences,
} from '../../packages/core/src/globals/references.js';
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
  hasUnpublishedInactiveMove,
  isMovedInactive,
} from '../../packages/core/src/inactiveMoves.js';
import { stableStringify } from '../../packages/core/src/contentHash.js';
import { exportLegacy } from '../../packages/core/src/exportLegacy.js';
import { resolveAlias, type Aliases } from '../../packages/core/src/aliases.js';
import type { GlobalImpactSnapshot } from '../../packages/core/src/globals/impactModel.js';
import { batchMemberSchema } from '../../packages/core/src/schedule/schemas.js';
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
} from '../../apps/worker/src/globals/model.js';
import { namePaths } from '../../apps/worker/src/globals/handlers.js';
import { appCredits, RefRace, type Tree } from './git.js';
import type { Publisher } from './publisher.js';

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const currentSync = {
  version: 1,
  status: 'current',
  causeIds: [],
  causeEntries: {},
  lastFailure: null,
};
export const hasGlobals = (tree: Tree) =>
  Object.keys(tree).some((path) => path.startsWith('globals/'));
export interface GlobalReleaseReceipt {
  version: 1;
  roots: number[];
  sources: GlobalSources;
  digest: string;
  published: z.infer<typeof globalPublishedSchema>;
}

/** Exact Git tree OID from the repository's flat blob tree, without shelling out or reading blobs. */
export function globalTreeOid(
  tree: Tree,
  prefix: string,
  modes: Record<string, string> = {},
): string {
  const entries = Object.entries(tree).filter(([path]) => path.startsWith(`${prefix}/`));
  if (!entries.length) return emptyGitTree;
  const files = new Map<string, string>(),
    directories = new Set<string>();
  for (const [path, oid] of entries) {
    const rest = path.slice(prefix.length + 1),
      slash = rest.indexOf('/');
    if (slash < 0) files.set(rest, oid);
    else directories.add(rest.slice(0, slash));
  }
  const parts = [
    ...[...files].map(([name, oid]) => ({ name, oid, directory: false })),
    ...[...directories].map((name) => ({
      name,
      oid: globalTreeOid(tree, `${prefix}/${name}`, modes),
      directory: true,
    })),
  ].sort((a, b) =>
    Buffer.compare(
      Buffer.from(a.name + (a.directory ? '/' : '')),
      Buffer.from(b.name + (b.directory ? '/' : '')),
    ),
  );
  const bytes = Buffer.concat(
    parts.map(({ name, oid, directory }) =>
      Buffer.concat([
        Buffer.from(`${directory ? '40000' : (modes[`${prefix}/${name}`] ?? '100644')} ${name}\0`),
        Buffer.from(oid, 'hex'),
      ]),
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
  async sources(tree: Tree, live: string, head?: string): Promise<GlobalSources> {
    const pin = z
      .object({ sourceSha: z.string(), sha256: z.string(), capabilities: z.array(z.string()) })
      .parse(this.read(tree, '.publisher/PIN'));
    if (
      pin.sourceSha !== this.options.publisherSha ||
      pin.sha256 !== this.options.publisherDigest ||
      !pin.capabilities.includes('globalsRelease')
    )
      throw new Error('Installed publisher lacks globalsRelease');
    const modes = this.git.treeModes?.(head ?? this.publisher.head(this.options.dataBranch)) ?? {};
    return observeGlobalSources({
      authored: globalTreeOid(tree, 'tooltips', modes),
      definitions: globalTreeOid(tree, 'globals/entries', modes),
      projections: globalTreeOid(tree, 'globals/projections', modes),
      layout: tree[globalsReleasePaths.layout],
      published: tree[globalsReleasePaths.published(this.options.liveBranch)],
      config: globalTreeOid(tree, 'config', modes),
      live,
      upcoming: globalTreeOid(tree, 'schedule', modes),
      aliasGroups: tree['config/alias-groups.json'] ?? null,
      sandboxPointers: tree['config/sandbox-pointers.json'] ?? null,
      generator: this.options.generatorSha,
      resolverRevision: pin.sourceSha,
    });
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
    return reconcileGlobalStore(layout.aggregates, entries);
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
  upcoming(tree: Tree): Record<string, Tooltip>[] {
    return Object.keys(tree)
      .filter((path) => /^schedule\/batches\/[^/]+\/tooltips\/\d+\.json$/.test(path))
      .flatMap((path) => {
        const member = batchMemberSchema.parse(this.read(tree, path));
        return [member.base, member.proposed].flatMap((document) =>
          document ? [{ [document.hash]: document }] : [],
        );
      });
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
    const snapshot = (
      tooltips: Record<string, Tooltip>,
      mode: 'authored' | 'live',
    ): GlobalImpactSnapshot => ({
      repository: this.options.repo,
      revision,
      aliases,
      types,
      tooltips,
      mode,
    });
    const storedLiveDocuments = {
      ...this.documents(tree, 'live/tooltips'),
      ...projectGlobals(published.store),
    };
    const actual = z
      .object({ perks: z.record(z.string(), z.record(z.string(), z.unknown())) })
      .parse(this.publisher.read(this.git.tree(liveCommit), 'liveDescriptions.json'));
    const liveDocuments = Object.fromEntries(
      Object.entries(storedLiveDocuments).filter(
        ([hash]) => actual.perks[hash] && actual.perks[hash].aliasOf === undefined,
      ),
    );
    if (!liveDocuments[2] || !liveDocuments[3])
      throw new Error('Missing last-published global library');
    const liveAliases: typeof aliases = {};
    const liveTypes: Record<string, string> = {};
    for (const [hash, value] of Object.entries(actual.perks)) {
      if (typeof value.type === 'string') liveTypes[hash] = value.type;
      if (value.aliasOf !== undefined) {
        if (
          typeof value.aliasOf !== 'number' ||
          !['name', 'sandbox', 'frame'].includes(String(value.aliasKind))
        )
          throw new Error('Unknown live alias provenance');
        liveAliases[hash] = {
          to: value.aliasOf,
          kind: value.aliasKind as 'name' | 'sandbox' | 'frame',
        };
      } else if (!liveDocuments[hash]) throw new Error('Missing last-published consumer snapshot');
    }
    const exported = exportLegacy(Object.values(liveDocuments), 0, this.options.facts, liveAliases);
    for (const [hash, value] of Object.entries(exported)) {
      if ('aliasOf' in value) continue;
      if (stableStringify(value.editor) !== stableStringify(actual.perks[hash]?.editor ?? null))
        throw new Error('Published snapshots differ from actual live inputs');
    }
    return {
      saved,
      published: published.store,
      authored: snapshot(
        { ...this.canonicalDocuments(tree, 'tooltips', aliases), ...projectGlobals(saved) },
        'authored',
      ),
      live: {
        ...snapshot(liveDocuments, 'live'),
        aliases: liveAliases,
        types: { ...types, ...liveTypes },
      },
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
  async plan(tree: Tree, revision: string, live: string) {
    await this.validateCauses(tree, revision);
    const captured = this.capture(tree, revision, live);
    const causes = this.causes(tree);
    const prior = new Map<
      string,
      { snapshot: GlobalImpactSnapshot; names: Record<string, string> }
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
        beforeStore = this.store(beforeTree);
      prior.set(cause.expectedHead, {
        snapshot: {
          ...captured.authored,
          revision: cause.expectedHead,
          aliases: this.publisher.aliasesAt(beforeTree),
          tooltips: {
            ...this.canonicalDocuments(
              beforeTree,
              'tooltips',
              this.publisher.aliasesAt(beforeTree),
            ),
            ...projectGlobals(beforeStore),
          },
        },
        names: Object.fromEntries(beforeStore.entries.map((entry) => [entry.id, entry.name])),
      });
    }
    const result = await planGlobalRelease({
      ...captured,
      causes,
      priorAuthored: [...prior.values()],
      destination: this.options.liveBranch,
    });
    for (const component of result)
      for (const id of component.ids) {
        const entry = captured.saved.entries.find((entry) => entry.id === id)!;
        const previous = captured.published.entries.find((entry) => entry.id === id);
        const removed = Object.keys(previous?.definitions ?? {}).filter(
          (lang) => !entry.definitions[lang as Lang],
        );
        if (
          component.rows.some(
            (row) =>
              row.view.causes.some((cause) => cause.globalId === id) &&
              (entry.tombstone ||
                removed.includes(row.view.consumer.lang) ||
                removed.includes('en')),
          )
        )
          throw new Error('Sync pending: a removed global dependency is still referenced');
      }
    // Scheduling stays disabled for globals. Frozen upcoming inputs cannot inherit a
    // changed global silently, even when that batch has never been activated.
    for (const upcoming of this.upcoming(tree))
      for (const component of result) {
        const changes = component.ids.map((id) => {
          const entry = captured.saved.entries.find((entry) => entry.id === id)!;
          return {
            cause: {
              globalId: id,
              beforeRevision:
                captured.published.entries.find((entry) => entry.id === id)?.revision ?? null,
              afterRevision: entry.revision,
            },
            kind: entry.kind,
            beforeName: captured.published.entries.find((entry) => entry.id === id)?.name,
            afterName: entry.name,
          };
        });
        const before = {
          ...captured.live,
          tooltips: {
            ...captured.authored.tooltips,
            ...upcoming,
            ...projectGlobals(captured.published),
          },
        };
        const after = {
          ...before,
          tooltips: { ...before.tooltips, ...projectGlobals(component.store) },
        };
        const impact = calculateGlobalImpact(before, after, changes, this.options.liveBranch);
        if (
          !impact.complete ||
          impact.rows.some((row) => Object.hasOwn(upcoming, row.consumer.hash))
        )
          throw new Error('Sync pending: upcoming global dependencies require rebase');
      }
    return result;
  }
  private async validateCauses(tree: Tree, head: string) {
    const sync = syncSchema.parse(this.read(tree, globalsReleasePaths.sync));
    for (const id of sync.causeIds) {
      const cause = pendingCauseSchema.parse(this.read(tree, `globals/causes/${id}.json`));
      if (
        !this.git.ancestor(cause.expectedHead, head) ||
        !sameSources(
          await this.sources(
            this.git.tree(cause.expectedHead),
            cause.beforeSources.live,
            cause.expectedHead,
          ),
          cause.beforeSources,
        )
      )
        throw new Error('Unproven global cause sources');
    }
  }
  async release(tree: Tree, revision: string, roots: number[], live: string) {
    if (!hasGlobals(tree)) return undefined;
    const sync = syncSchema.parse(this.read(tree, globalsReleasePaths.sync));
    const sources = await this.sources(tree, live, revision);
    const captured = this.capture(tree, revision, live),
      components = await this.plan(tree, revision, live);
    const selected = roots.map((hash) => resolveAlias(hash, captured.authored.aliases));
    const activeSelection = selected.filter(
      (hash) => !isMovedInactive(hash, this.publisher.movesAt(tree)),
    );
    const aggregate = selected.includes(2) || selected.includes(3);
    const relevant = components.filter(
      (component) =>
        aggregate ||
        component.rows.some((row) => activeSelection.includes(row.view.consumer.hash)) ||
        component.hashes.some((hash) => hash !== 2 && hash !== 3 && activeSelection.includes(hash)),
    );
    const ready = relevant.filter(
      (component) =>
        sync.status === 'current' &&
        component.rows.every((row) => {
          const stored = rowSchema.safeParse(this.read(tree, `globals/reviews/${row.id}.json`));
          return (
            stored.success && sameSources(stored.data.sources, sources) && this.approved(tree, row)
          );
        }),
    );
    // Aggregate selection can release independent approved components only. A selected
    // dependent cannot silently fall back to a different global revision.
    if (
      (!aggregate && ready.length !== relevant.length) ||
      (aggregate && relevant.length && !ready.length)
    )
      throw new Error('Sync pending: global dependency review required');
    const ids = ready.flatMap((component) => component.ids);
    const store = composeGlobalRelease(captured.published, captured.saved, ids);
    const hashes = [
      ...new Set([...selected, ...ready.flatMap((component) => component.hashes)]),
    ].sort((a, b) => a - b);
    if (ids.length) {
      const markers = pushedSchema.parse(this.read(tree, 'live/pushed.json'));
      const moves = this.publisher.movesAt(tree);
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
          throw new Error('Publish inactive move decisions before releasing global dependencies');
      }
    }
    const globals = projectGlobals(store);
    const documents = hashes.map((hash) => {
      const document =
        globals[hash] ?? captured.authored.tooltips[hash] ?? captured.live.tooltips[hash];
      if (!document) throw new Error('Deleted release dependency');
      return document;
    });
    const published = globalPublishedSchema.parse({
      version: 1,
      destination: this.options.liveBranch,
      store,
    });
    const digest = await globalIdentityDigest({
      sourceCommit: revision,
      sources,
      ids,
      documents,
      published,
      rows: ready.flatMap((component) => component.rows),
    });
    const receipt: GlobalReleaseReceipt = { version: 1, roots, sources, digest, published };
    return { documents, receipt };
  }
  async validate(
    receipt: GlobalReleaseReceipt | undefined,
    tree: Tree,
    head: string,
    live: string,
  ) {
    if (!hasGlobals(tree) && !receipt) return undefined;
    if (!receipt || receipt.version !== 1) throw new Error('Global release receipt required');
    const checked = await this.release(tree, head, receipt.roots, live);
    if (
      !checked ||
      checked.receipt.digest !== receipt.digest ||
      stableStringify(checked.receipt.published) !== stableStringify(receipt.published)
    )
      throw new Error('Global release changed since review');
    return checked.documents;
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
    const components = await this.plan(tree, head, live);
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
        for (const id of component.ids)
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
  async drain() {
    // One coalesced pass over all requests, not one drain per trigger or retry file.
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = this.publisher.head(this.options.dataBranch),
        original = this.git.tree(head);
      if (!hasGlobals(original)) return;
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
        if (stableStringify(tree) === stableStringify(original)) return;
        const commit = this.git.commit(
          head,
          tree,
          `Sync ${sync.causeIds.length} global causes`,
          appCredits,
        );
        this.git.cas(`refs/heads/${this.options.dataBranch}`, head, commit);
        return;
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
        sameSources(
          await this.sources(
            this.git.tree(intent.expectedHead),
            intent.sources.live,
            intent.expectedHead,
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
        if (document.hash === 2 || document.hash === 3) continue;
        for (const cell of Object.values(document.text))
          cell.text = rewriteGlobalReferences(cell.text, entry.kind, entry.name, intent.name).text;
      }
      const after = reconcileGlobalStore(before.aggregates, all);
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
  private async occupiedProofs(tree: Tree, head: string, live: string) {
    const captured = this.capture(tree, head, live);
    const sources = await this.sources(tree, live, head);
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
              : document.hash === 3
                ? Object.values(extractBlocks(source, 'title'))
                : [source];
          for (const text of localSources)
            for (const definition of markupDefinitions(text))
              localNames.add(`${definition.kind}:${definition.name}`);
        }
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
        localNames.has(`${entry.kind === 'variables' ? 'variable' : 'title'}:${entry.name}`)
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
      requested = new Map<string, { kind: 'variables' | 'titles'; name: string }>();
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
    // Establish resolver coverage even when there are no changed globals.
    for (const snapshot of snapshots) {
      const validation = calculateGlobalImpact(snapshot, snapshot, [], this.options.liveBranch);
      if (!validation.complete) throw new Error('Sync pending: proof coverage is incomplete');
    }
    for (const path of Object.keys(tree).filter((path) =>
      path.startsWith('globals/proofs/publication/'),
    ))
      delete tree[path];
    const moves = this.publisher.movesAt(tree);
    for (const document of Object.values(captured.authored.tooltips))
      for (const lang of [
        ...new Set([
          ...Object.keys(document.text),
          ...(isMovedInactive(document.hash, moves) ? ['en'] : []),
        ]),
      ]) {
        // A canonical removal exports no language body. This English-keyed
        // operation proof is pinned to the current inactive decision.
        const relevant = isMovedInactive(document.hash, moves)
          ? []
          : components.filter(
              (component) =>
                document.hash === 2 ||
                document.hash === 3 ||
                component.rows.some(
                  (row) =>
                    row.view.consumer.hash === document.hash && row.view.consumer.lang === lang,
                ),
            );
        const ready = relevant.filter((component) =>
          component.rows.every((row) => this.approved(tree, row)),
        );
        if (
          document.hash === 2 || document.hash === 3
            ? relevant.length > 0 && ready.length === 0
            : ready.length !== relevant.length
        )
          continue;
        const consumer = { hash: document.hash, lang, destination: this.options.liveBranch };
        this.write(
          tree,
          `globals/proofs/publication/${this.options.liveBranch}/${document.hash}-${lang}.json`,
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
    for (const request of requested.values()) {
      const owners = [...captured.saved.entries, ...captured.published.entries].filter(
        (entry) => !entry.tombstone && entry.kind === request.kind && entry.name === request.name,
      );
      const occupied = owners[0];
      const localClash = [...snapshots, authoredSources].some((snapshot) =>
        Object.values(snapshot.tooltips).some(
          (document) =>
            document.hash !== 2 &&
            document.hash !== 3 &&
            languages.some((lang) =>
              markupDefinitions(globalSourceText(document, lang, snapshot.mode) ?? '').some(
                (local) =>
                  local.name === request.name &&
                  local.kind === (request.kind === 'variables' ? 'variable' : 'title'),
              ),
            ),
        ),
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
          );
          return (
            !impact.complete ||
            impact.rows.length ||
            Object.values(snapshot.tooltips).some((document) =>
              languages.some(
                (language) =>
                  (!lang || language === lang || lang === 'en') &&
                  globalReferenceSpans(
                    globalSourceText(document, language, snapshot.mode) ?? '',
                    entry.kind,
                  ).some((span) => names.includes(span.name)),
              ),
            )
          );
        });
        const authoredReference = Object.values(authoredSources.tooltips).some((document) =>
          Object.values(document.text).some((cell) =>
            globalReferenceSpans(cell.text, entry.kind).some((span) => names.includes(span.name)),
          ),
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
