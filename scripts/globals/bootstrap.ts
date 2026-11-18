import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { aliasesSchema, resolveAlias } from '../../packages/core/src/aliases.js';
import { tooltipSchema, type Tooltip } from '../../packages/core/src/schemas.js';
import { stableStringify } from '../../packages/core/src/contentHash.js';
import { exportLegacy } from '../../packages/core/src/exportLegacy.js';
import { projectGlobals } from '../../packages/core/src/globals/projection.js';
import { globalIdSchema, type GlobalRecord } from '../../packages/core/src/globals/model.js';
import {
  globalLayoutSchema,
  globalPublishedSchema,
} from '../../packages/core/src/globalsRelease/model.js';
import { catalogSchema, entrySchema, pageSchema } from '../../apps/worker/src/globals/model.js';
import { Publisher, type Options } from '../publisher/publisher.js';
import { globalsCensus, legacySnapshot } from './census.js';
import { bootstrapFiles, json, sha256 } from './bootstrap-model.js';

const oid = z.string().regex(/^[a-f0-9]{40}$/);
const inputsSchema = z
  .object({ version: z.literal(1), head: oid, live: oid, converter: oid })
  .strict();
type Inputs = z.infer<typeof inputsSchema>;
const planSchema = z
  .object({
    version: z.literal(1),
    inputs: inputsSchema,
    baseTree: oid,
    targetTree: oid,
    repository: z.string(),
    destination: z.string(),
    ids: z.record(z.string(), globalIdSchema),
    files: z.record(z.string(), z.string()),
    baseFiles: z.record(z.string(), z.string().nullable()).optional(),
    pins: z.record(z.string(), z.string().nullable()),
    backupSha256: z.string(),
    diffSha256: z.string(),
    refs: z.string(),
    toolSha256: z.string(),
    compatibilityRequired: z.array(z.string()),
    reviewDifferences: z.array(globalIdSchema),
    publishedSnapshots: z.unknown(),
    historicalPublishedAliases: z.unknown(),
    secondaryDifferences: z.unknown(),
    identityEvidence: z.unknown(),
    inventories: z.unknown(),
  })
  .strict();
type Plan = z.infer<typeof planSchema>;

/** No network, ref updates, commits, hooks, checkout/reset, or push entry point. */
export class OfflineGit {
  readonly repo: string;
  constructor(
    repo: string,
    readonly index?: string,
  ) {
    this.repo = realpathSync(repo);
  }
  run(args: string[], input?: string | Buffer): Buffer {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', this.repo, ...args], {
      input,
      maxBuffer: 128 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_NO_REPLACE_OBJECTS: '1',
        ...(this.index ? { GIT_INDEX_FILE: this.index } : {}),
      },
      windowsHide: true,
    });
  }
  text(...args: string[]) {
    return this.run(args).toString('utf8').trimEnd();
  }
  read(ref: string, path: string): unknown {
    return JSON.parse(this.text('show', `${ref}:${path}`));
  }
  readMany(ref: string, paths: string[]): unknown[] {
    const bytes = this.run(
      ['cat-file', '--batch'],
      paths.map((path) => `${ref}:${path}\n`).join(''),
    );
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let offset = 0;
    return paths.map(() => {
      const end = bytes.indexOf(10, offset);
      const header = bytes
        .subarray(offset, end)
        .toString('ascii')
        .match(/^[a-f0-9]{40} blob (\d+)$/);
      if (!header) throw new Error('Missing or invalid pinned blob');
      const size = Number(header[1]);
      offset = end + 1;
      const result = JSON.parse(decoder.decode(bytes.subarray(offset, offset + size)));
      offset += size + 1;
      return result;
    });
  }
  paths(ref: string) {
    return this.text('ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean);
  }
  head() {
    return this.text('rev-parse', 'HEAD');
  }
  clean() {
    if (this.text('status', '--porcelain=v1', '--untracked-files=all'))
      throw new Error('Repository is not pristine');
  }
}

export function prepare(
  git: OfflineGit,
  inputs: Inputs,
  ids?: Record<string, string>,
  inspect = false,
) {
  if (!inspect && git.head() !== inputs.head) throw new Error('Expected data HEAD changed');
  for (const ref of [inputs.head, inputs.live, inputs.converter])
    if (git.text('rev-parse', `${ref}^{commit}`) !== ref) throw new Error('Unpinned input commit');
  const paths = git.paths(inputs.head);
  const installed = paths.some((path) => path.startsWith('globals/'));
  const config = git.read(inputs.head, '.publisher/config.json') as Options;
  if (
    config.dataBranch !== 'editor-data' ||
    !/^[\w-]+\/[\w-]+$/.test(config.repo) ||
    !/^[\w-]{1,80}$/.test(config.liveBranch)
  )
    throw new Error('Invalid configured repository/destination');
  // Contract v1 has exactly one independently observed destination, the configured liveBranch.
  oid.parse(config.generatorSha);
  const pin = z
    .object({ sourceSha: oid, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
    .passthrough()
    .parse(git.read(inputs.head, '.publisher/PIN'));
  if (sha256(git.run(['show', `${inputs.head}:.publisher/publisher.mjs`])) !== pin.sha256)
    throw new Error('Installed publisher differs from its PIN');
  const optional = (path: string) =>
    paths.includes(path) ? git.read(inputs.head, path) : undefined;
  const aliases = Publisher.aliasesAt(
    config,
    optional('config/alias-groups.json'),
    optional('config/sandbox-pointers.json'),
  );
  const documents: Record<string, Tooltip> = {};
  const tooltipPaths = paths.filter((path) => /^tooltips\/\d+\.json$/.test(path));
  const tooltipBlobs = git.readMany(inputs.head, tooltipPaths);
  for (const [i, path] of tooltipPaths.entries()) {
    const doc = tooltipSchema.parse(tooltipBlobs[i]);
    if (path !== `tooltips/${doc.hash}.json`) throw new Error('Tooltip path/hash mismatch');
    if (resolveAlias(doc.hash, aliases) !== doc.hash) continue; // Retain alias archives in Git, never export them as authored records.
    documents[doc.hash] = doc;
  }
  const savedSource = {
    repository: config.repo,
    revision: inputs.head,
    locate: (hash: 1 | 2 | 3, lang: string) => ({
      path: `tooltips/${hash}.json`,
      selector: ['text', lang, 'text'],
    }),
  };
  const publishedSource = {
    repository: config.repo,
    revision: inputs.live,
    locate: (hash: 1 | 2 | 3, lang: string) => ({
      path: 'liveDescriptions.json',
      selector: ['perks', String(hash), 'editor', lang, 'main'],
    }),
  };
  const liveInput = git.read(inputs.live, 'liveDescriptions.json');
  const live = legacySnapshot(liveInput, {
    repository: config.repo,
    revision: inputs.live,
    path: 'liveDescriptions.json',
  });
  const existing = installed
    ? (() => {
        const layout = globalLayoutSchema.parse(git.read(inputs.head, 'globals/layout.json'));
        const published = globalPublishedSchema.parse(
          git.read(inputs.head, `globals/live/${config.liveBranch}.json`),
        );
        if (published.destination !== config.liveBranch)
          throw new Error('Published destination mismatch');
        const catalog = catalogSchema.parse(git.read(inputs.head, 'globals/catalog.json'));
        const entries: GlobalRecord[] = [];
        for (let i = 0; i <= catalog.lastPage; i++) {
          const page = pageSchema.parse(git.read(inputs.head, `globals/pages/p${i}.json`));
          if (page.nextCursor !== (i < catalog.lastPage ? `p${i + 1}` : null))
            throw new Error('Incomplete installed catalogue');
          for (const id of page.ids) {
            const entry = entrySchema.parse(git.read(inputs.head, `globals/entries/${id}.json`));
            if (entry.id !== id || entries.some((previous) => previous.id === id))
              throw new Error('Installed identity mismatch');
            entries.push(entry);
          }
        }
        if (
          entries.length !==
          paths.filter((path) => /^globals\/entries\/[^/]+\.json$/.test(path)).length
        )
          throw new Error('Installed catalogue omits an identity');
        return {
          saved: { version: 1 as const, entries, aggregates: layout.aggregates },
          published: published.store,
        };
      })()
    : undefined;
  const proposal = bootstrapFiles(
    { documents, source: savedSource },
    { documents: live.tooltips, source: publishedSource },
    config.liveBranch,
    ids,
    existing,
  );
  // Unchanged metadata keeps its original bytes; old entries, reviews, proofs, and
  // pending work are never rewritten by the export conversion.
  if (existing)
    for (const [path, bytes] of Object.entries(proposal.files)) {
      if (
        paths.includes(path) &&
        stableStringify(git.read(inputs.head, path)) === stableStringify(JSON.parse(bytes))
      )
        delete proposal.files[path];
      else if (
        paths.includes(path) &&
        !/^(globals\/layout\.json|globals\/live\/[^/]+\.json|globals\/catalog\.json|globals\/pages\/p\d+\.json)$/.test(
          path,
        )
      )
        throw new Error(`Existing metadata would change: ${path}`);
    }
  const publishedSnapshots = [];
  const historicalPublishedAliases = [];
  for (const document of Object.values(live.tooltips)) {
    const path = `live/tooltips/${document.hash}.json`;
    if (paths.includes(path)) continue;
    if (existing) throw new Error(`Installed published snapshot is missing: ${path}`);
    const bytes = json(tooltipSchema.parse(document));
    proposal.files[path] = bytes;
    publishedSnapshots.push({
      path,
      sha256: sha256(bytes),
      source: {
        repository: config.repo,
        revision: inputs.live,
        path: 'liveDescriptions.json',
        selector: ['perks', String(document.hash)],
      },
    });
    if (aliases[document.hash]?.kind === 'frame') {
      const target = resolveAlias(document.hash, aliases);
      const text = (tooltip: Tooltip | undefined) =>
        Object.fromEntries(
          Object.entries(tooltip?.text ?? {}).map(([lang, cell]) => [lang, cell.text]),
        );
      historicalPublishedAliases.push({
        hash: document.hash,
        target,
        path,
        classification: 'historical published baseline, now a frame alias in config',
        differsFromPublishedCanonical:
          stableStringify(text(document)) !== stableStringify(text(live.tooltips[target])),
        targetSource: {
          repository: config.repo,
          revision: inputs.live,
          path: 'liveDescriptions.json',
          selector: ['perks', String(target)],
        },
      });
    }
  }
  const types = Object.fromEntries(
    Object.entries(config.facts).map(([hash, value]) => [hash, value.type]),
  );
  const saved = {
    repository: config.repo,
    revision: inputs.head,
    tooltips: documents,
    aliases: aliasesSchema.parse(aliases),
    types,
    mode: 'authored' as const,
  };
  const censuses = {
    saved: globalsCensus(saved, savedSource.locate, installed),
    live: globalsCensus(live, publishedSource.locate, installed),
  };
  for (const [key, census] of Object.entries(censuses))
    if (
      !census.aggregateParity ||
      !census.consumerInputParity ||
      !census.renderedParity ||
      !census.resolverComplete
    )
      throw new Error(`${key} census incomplete: ${json(census.blockers).slice(0, 8192)}`);
  const before = exportLegacy(Object.values(documents), 0, config.facts, aliases);
  const after = exportLegacy(
    Object.values({ ...documents, ...projectGlobals(proposal.savedStore) }),
    0,
    config.facts,
    aliases,
  );
  if (stableStringify(before) !== stableStringify(after))
    throw new Error('Saved consumer input changed');
  const raw = liveInput as {
    perks: Record<string, { editor?: Record<string, { main: string; secondary: string }> }>;
  };
  const liveProjected = exportLegacy(Object.values(projectGlobals(proposal.liveStore)), 0);
  const compatibilityRequired: string[] = [];
  const secondaryDifferences = Object.entries(raw.perks).flatMap(([hash, value]) =>
    Object.entries(value.editor ?? {})
      .filter(([, cell]) => cell.secondary !== cell.main)
      .map(([lang, cell]) => ({
        hash: Number(hash),
        lang,
        main: cell.main,
        secondary: cell.secondary,
        source: {
          revision: inputs.live,
          path: 'liveDescriptions.json',
          selector: ['perks', hash, 'editor', lang],
        },
      })),
  );
  // Root's v2 contract: secondary is derived output, never authored state. Preserve the raw
  // live input and compare every other editor field strictly, just as the publisher does.
  const authoredEditor = (editor: Record<string, { main: string; secondary: string }>) =>
    Object.fromEntries(
      Object.entries(editor).map(([lang, cell]) => {
        const { secondary: _secondary, ...authored } = cell;
        void _secondary;
        return [lang, authored];
      }),
    );
  for (const hash of installed ? [1, 2, 3] : [2, 3]) {
    const actual = raw.perks[hash]?.editor as Record<string, { main: string; secondary: string }>;
    const comparable = Object.fromEntries(
      Object.entries(actual).map(([lang, cell]) => {
        if (cell.secondary === '') compatibilityRequired.push(`${hash}/${lang}`);
        return [lang, cell];
      }),
    );
    if (
      stableStringify(
        authoredEditor(
          (liveProjected[hash] as { editor: Record<string, { main: string; secondary: string }> })
            .editor,
        ),
      ) !== stableStringify(authoredEditor(comparable))
    )
      throw new Error(`Published library ${hash} does not reproduce live editor bytes`);
  }
  const pins: Record<string, string | null> = {
    generator: config.generatorSha,
    publisherSource: pin.sourceSha,
    publisherRuntime: pin.sha256,
    converterEngine: sha256(git.run(['show', `${inputs.converter}:.exports/engine.mjs`])),
    converterPin: sha256(git.run(['show', `${inputs.converter}:.exports/PIN`])),
  };
  for (const path of [
    'config',
    'schedule',
    '.publisher/config.json',
    '.publisher/PIN',
    'config/alias-groups.json',
    'config/sandbox-pointers.json',
  ])
    pins[path] = git.text('ls-tree', inputs.head, '--', path) || null;
  return {
    ...proposal,
    config,
    censuses,
    pins,
    before,
    after,
    liveInput,
    compatibilityRequired,
    publishedSnapshots,
    historicalPublishedAliases,
    secondaryDifferences,
  };
}

const blobOid = (bytes: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(bytes)}\0`)
    .update(bytes)
    .digest('hex');
function stageFiles(git: OfflineGit, files: Record<string, string>, remove = false) {
  const updates = Object.entries(files)
    .map(
      ([path, bytes]) =>
        `${remove ? '0 ' + '0'.repeat(40) : '100644 ' + blobOid(bytes)}\t${path}\0`,
    )
    .join('');
  if (updates) git.run(['update-index', '-z', '--index-info'], updates);
}

function plannedTree(git: OfflineGit, out: string, head: string, files: Record<string, string>) {
  const index = join(out, 'tree.index');
  if (existsSync(index)) unlinkSync(index);
  const isolated = new OfflineGit(git.repo, index);
  isolated.text('read-tree', head);
  const payloadPaths: string[] = [];
  for (const [path, bytes] of Object.entries(files)) {
    if (!/^(globals\/[a-zA-Z0-9_/-]+|live\/tooltips\/\d+)\.json$/.test(path))
      throw new Error('Unsafe bootstrap path');
    const payload = safeFile(out, `payload/${path}`);
    if (/[\r\n]/.test(payload)) throw new Error('Unsupported newline in evidence path');
    mkdirSync(dirname(payload), { recursive: true });
    writeFileSync(payload, bytes);
    payloadPaths.push(payload.replaceAll('\\', '/'));
  }
  const hashes = isolated
    .run(['hash-object', '-w', '--no-filters', '--stdin-paths'], payloadPaths.join('\n') + '\n')
    .toString()
    .trim()
    .split('\n');
  if (JSON.stringify(hashes) !== JSON.stringify(Object.values(files).map(blobOid)))
    throw new Error('Payload object bytes differ from manifest');
  stageFiles(isolated, files);
  return isolated.text('write-tree');
}

function loadPlan(out: string, expected: string): Plan {
  const bytes = readFileSync(join(out, 'plan.json'));
  if (sha256(bytes) !== expected) throw new Error('Reviewed plan SHA mismatch');
  const plan = planSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (
    sha256(readFileSync(join(out, 'backup.bundle'))) !== plan.backupSha256 ||
    sha256(readFileSync(join(out, 'staged.diff'))) !== plan.diffSha256
  )
    throw new Error('Backup/diff integrity mismatch');
  return plan;
}

function safeFile(repo: string, path: string) {
  const target = resolve(repo, path);
  if (!target.startsWith(repo + sep)) throw new Error('Path escaped repository');
  let current = repo;
  for (const component of relative(repo, target).split(sep)) {
    current = join(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error('Symlink in bootstrap path');
  }
  return target;
}

function verify(git: OfflineGit, plan: Plan) {
  if (git.head() !== plan.inputs.head) throw new Error('HEAD differs from receipt');
  if (git.text('write-tree') !== plan.targetTree)
    throw new Error('Staged tree differs from receipt');
  if (git.text('diff', '--no-ext-diff', '--name-only'))
    throw new Error('Working tree differs from receipt');
  if (git.text('ls-files', '--others', '--exclude-standard'))
    throw new Error('Untracked files prevent verification');
  for (const [path, bytes] of Object.entries(plan.files))
    if (!readFileSync(safeFile(git.repo, path)).equals(Buffer.from(bytes)))
      throw new Error(`Working bytes differ: ${path}`);
}

/** Also recover an interrupted local apply, but never remove an edited file or newer work. */
function restorable(git: OfflineGit, plan: Plan) {
  if (git.head() !== plan.inputs.head) throw new Error('HEAD differs from receipt');
  const changed = new Set(
    [
      ...git.text('diff', '--no-ext-diff', '--cached', '--name-only', plan.inputs.head).split('\n'),
      ...git.text('diff', '--no-ext-diff', '--name-only').split('\n'),
      ...git.text('ls-files', '--others', '--exclude-standard').split('\n'),
    ].filter(Boolean),
  );
  if ([...changed].some((path) => !Object.hasOwn(plan.files, path)))
    throw new Error('Unrelated changes prevent restoration');
  const stages = new Map(
    git
      .run(['ls-files', '--stage', '-z'])
      .toString()
      .split('\0')
      .filter(Boolean)
      .map((line) => [line.slice(line.indexOf('\t') + 1), line]),
  );
  for (const [path, bytes] of Object.entries(plan.files)) {
    const target = safeFile(git.repo, path);
    const base = plan.baseFiles?.[path] ?? null;
    if (
      existsSync(target) &&
      !readFileSync(target).equals(Buffer.from(bytes)) &&
      (base === null || !readFileSync(target).equals(Buffer.from(base)))
    )
      throw new Error(`Working file differs from receipt: ${path}`);
    const staged = stages.get(path);
    const expectedBlob = blobOid(bytes);
    if (
      staged &&
      staged !== `100644 ${expectedBlob} 0\t${path}` &&
      (base === null || staged !== `100644 ${blobOid(base)} 0\t${path}`)
    )
      throw new Error(`Staged file differs from receipt: ${path}`);
  }
}

/** Restore original bytes for replacements, and remove only newly created paths. */
function restoreFiles(git: OfflineGit, plan: Plan, paths = Object.keys(plan.files)) {
  const restored: Record<string, string> = {},
    removed: Record<string, string> = {};
  for (const path of paths) {
    const original = plan.baseFiles?.[path] ?? null;
    const target = safeFile(git.repo, path);
    if (original === null) {
      if (existsSync(target)) unlinkSync(target);
      removed[path] = plan.files[path];
    } else {
      writeFileSync(target, original);
      restored[path] = original;
    }
  }
  stageFiles(git, removed, true);
  stageFiles(git, restored);
}

export async function main(args: string[], toolSha256 = 'test-only-unbundled') {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      out: { type: 'string' },
      head: { type: 'string' },
      live: { type: 'string' },
      converter: { type: 'string' },
      'expect-plan': { type: 'string' },
    },
  });
  const command = positionals[0];
  if (
    positionals.length !== 1 ||
    !['inspect', 'plan', 'apply', 'verify', 'restore'].includes(command) ||
    !values.repo ||
    !values.out
  )
    throw new Error(
      'Usage: bootstrap.mjs inspect|plan|apply|verify|restore --repo private-clone --out evidence-dir (inspect/plan: --head SHA --live SHA --converter SHA; others: --expect-plan SHA256)',
    );
  const git = new OfflineGit(resolve(values.repo)),
    out = resolve(values.out);
  const rel = relative(git.repo, out);
  if (command !== 'inspect' && !rel.startsWith('..') && !isAbsolute(rel))
    throw new Error('Evidence directory must be outside the data repository');
  if (command === 'plan' || command === 'inspect') {
    if (command === 'plan') git.clean();
    if (existsSync(out))
      throw new Error('Plan output already exists; preserve it and choose a fresh directory');
    const inputs = inputsSchema.parse({
      version: 1,
      head: values.head,
      live: values.live,
      converter: values.converter,
    });
    const prepared = prepare(git, inputs, undefined, command === 'inspect');
    mkdirSync(out, { recursive: true });
    if (command === 'inspect') {
      writeFileSync(
        join(out, 'proposal.json'),
        json({ inputs, ...prepared, writesEnabled: false }),
      );
      process.stdout.write(
        json({
          inputs,
          writesEnabled: false,
          files: Object.keys(prepared.files).length,
          reviewDifferences: prepared.reviewDifferences,
        }),
      );
      return;
    }
    const targetTree = plannedTree(git, out, inputs.head, prepared.files);
    // The checkout index can make Git reuse CRLF worktree bytes for an LF blob.
    // Changed entries in the planned index have no worktree stat cache.
    const diff = new OfflineGit(git.repo, join(out, 'tree.index')).run([
      '-c',
      'core.autocrlf=false',
      'diff-tree',
      '--no-textconv',
      '--no-ext-diff',
      '--no-commit-id',
      '--binary',
      '--full-index',
      '-p',
      inputs.head,
      targetTree,
    ]);
    writeFileSync(join(out, 'staged.diff'), diff);
    const refs = git.text('for-each-ref', '--format=%(refname) %(objectname)');
    const backup = join(out, 'backup.bundle');
    git.text('bundle', 'create', backup, '--all');
    git.text('bundle', 'verify', backup);
    const restored = join(out, 'backup-restore');
    execFileSync('git', ['clone', '--no-checkout', backup, restored], { windowsHide: true });
    const restoredGit = new OfflineGit(restored);
    const baseTree = git.text('rev-parse', `${inputs.head}^{tree}`);
    for (const ref of [inputs.head, inputs.live, inputs.converter])
      if (restoredGit.text('rev-parse', `${ref}^{tree}`) !== git.text('rev-parse', `${ref}^{tree}`))
        throw new Error('Backup restore tree mismatch');
    const plan: Plan = {
      version: 1,
      inputs,
      baseTree,
      targetTree,
      repository: prepared.config.repo,
      destination: prepared.config.liveBranch,
      ids: prepared.ids,
      files: prepared.files,
      baseFiles: Object.fromEntries(
        Object.keys(prepared.files).map((path) => [
          path,
          git.text('ls-tree', inputs.head, '--', path)
            ? git.run(['show', `${inputs.head}:${path}`]).toString('utf8')
            : null,
        ]),
      ),
      pins: prepared.pins,
      backupSha256: sha256(readFileSync(backup)),
      diffSha256: sha256(diff),
      refs,
      identityEvidence: prepared.identityEvidence,
      inventories: prepared.inventories,
      toolSha256,
      compatibilityRequired: prepared.compatibilityRequired,
      reviewDifferences: prepared.reviewDifferences,
      publishedSnapshots: prepared.publishedSnapshots,
      historicalPublishedAliases: prepared.historicalPublishedAliases,
      secondaryDifferences: prepared.secondaryDifferences,
    };
    writeFileSync(join(out, 'plan.json'), json(plan));
    writeFileSync(join(out, 'census.json'), json(prepared.censuses));
    writeFileSync(join(out, 'refs.txt'), refs + '\n');
    process.stdout.write(
      json({
        planSha256: sha256(json(plan)),
        head: inputs.head,
        targetTree,
        files: Object.keys(plan.files).length,
        backupRestored: true,
        offlineOnly: true,
      }),
    );
    return;
  }
  if (!values['expect-plan']) throw new Error('Explicit reviewed --expect-plan SHA256 is required');
  const plan = loadPlan(out, values['expect-plan']);
  if (plan.toolSha256 !== toolSha256)
    throw new Error('Bootstrap executable changed; prepare a new reviewed plan');
  // Recompute every schema, source, identity, and bound; do not trust a serialized file list.
  const prepared = prepare(git, plan.inputs, plan.ids);
  if (
    stableStringify(prepared.files) !== stableStringify(plan.files) ||
    (plan.baseFiles !== undefined &&
      stableStringify(plan.baseFiles) !==
        stableStringify(
          Object.fromEntries(
            Object.keys(prepared.files).map((path) => [
              path,
              git.text('ls-tree', plan.inputs.head, '--', path)
                ? git.run(['show', `${plan.inputs.head}:${path}`]).toString('utf8')
                : null,
            ]),
          ),
        )) ||
    stableStringify(prepared.pins) !== stableStringify(plan.pins) ||
    stableStringify(JSON.parse(json(prepared.identityEvidence))) !==
      stableStringify(plan.identityEvidence) ||
    stableStringify(prepared.inventories) !== stableStringify(plan.inventories) ||
    stableStringify(prepared.compatibilityRequired) !==
      stableStringify(plan.compatibilityRequired) ||
    stableStringify(prepared.reviewDifferences) !== stableStringify(plan.reviewDifferences) ||
    stableStringify(prepared.publishedSnapshots) !== stableStringify(plan.publishedSnapshots) ||
    stableStringify(prepared.historicalPublishedAliases) !==
      stableStringify(plan.historicalPublishedAliases) ||
    stableStringify(prepared.secondaryDifferences) !== stableStringify(plan.secondaryDifferences) ||
    plannedTree(git, out, plan.inputs.head, plan.files) !== plan.targetTree
  )
    throw new Error('Plan does not match independently reconstructed contract tree');
  if (command === 'verify') {
    verify(git, plan);
  } else if (command === 'restore') {
    restorable(git, plan);
    restoreFiles(git, plan);
    git.clean();
    if (git.text('write-tree') !== plan.baseTree)
      throw new Error('Restored tree differs from backup');
  } else {
    git.clean();
    for (const path of Object.keys(plan.files)) {
      const target = safeFile(git.repo, path),
        original = plan.baseFiles?.[path] ?? null;
      if (
        original === null
          ? existsSync(target)
          : !existsSync(target) || !readFileSync(target).equals(Buffer.from(original))
      )
        throw new Error('Bootstrap path differs from its expected original');
    }
    const written: string[] = [];
    try {
      for (const [path, bytes] of Object.entries(plan.files)) {
        const target = safeFile(git.repo, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes, {
          flag:
            plan.baseFiles?.[path] === null || plan.baseFiles?.[path] === undefined ? 'wx' : 'w',
        });
        written.push(path);
      }
      stageFiles(git, plan.files);
      verify(git, plan);
    } catch (error) {
      restoreFiles(git, plan, written.reverse());
      throw error;
    }
  }
  const receipt = {
    version: 1,
    operation: command,
    planSha256: values['expect-plan'],
    head: git.head(),
    tree: git.text('write-tree'),
    verifiedAt: new Date().toISOString(),
    offlineOnly: true,
  };
  writeFileSync(join(out, `${command}-receipt.json`), json(receipt));
  process.stdout.write(json(receipt));
}
