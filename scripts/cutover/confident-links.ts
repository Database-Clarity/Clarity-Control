import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { aliasesSchema, resolveAlias } from '../../packages/core/src/aliases.js';
import {
  aliasGroupsSchema,
  composeAliases,
  type AliasGroups,
} from '../../packages/core/src/aliasGroups.js';
import { tooltipSchema, hasTooltipText, type Tooltip } from '../../packages/core/src/schemas.js';
import { compendiumDataSchema } from '../../packages/core/src/compendium/types.js';
import { withCompendiumMatchingIndex } from '../../packages/core/src/compendium/resolve.js';
import { isTrackedCompendiumTab } from '../../packages/core/src/compendium/config.js';
import { inactiveMovesSchema } from '../../packages/core/src/inactiveMoves.js';
import {
  hasSandboxTargets,
  sandboxPointersSchema,
  sandboxConflictsSchema,
} from '../../packages/core/src/sandboxPointers.js';
import { itemsSchema, categorySchema } from '../../apps/web/src/services/generatorSchema.js';
import { presentCategories } from '../../apps/web/src/services/categoryLabels.js';
import { displayMatches } from '../../apps/web/src/features/compendium/displayMatches.js';
import { reviewEvidence } from '../../apps/web/src/features/compendium/reviewQueue.js';
import { proposalFor } from '../../apps/web/src/features/compendium/rapidReview.js';
import { emptyProgress } from '../../apps/web/src/features/compendium/reviewProgress.js';
import { confirmCompendiumSelection } from '../../apps/web/src/features/compendium/selection.js';
import approved from '../../apps/web/src/features/compendium/approved-guidance.v1.json';
import type { EditorData } from '../../apps/web/src/stores/data.js';

/** Exact UTF-8 blobs, not a checkout. Callers fetch immutable Git objects. */
export interface Inputs {
  editorHead: string;
  engineCommit: string;
  catalogCommit: string;
  compendiumCommit: string;
  snapshotAt: string;
  itemsJson: string;
  categoriesJson: string;
  aliasesJson: string;
  compendiumJson: string;
  /** Exact editor-data config blobs; null means absent at editorHead. */
  inactiveJson: string | null;
  aliasGroupsJson: string | null;
  sandboxPointersJson: string | null;
  /** From the same generator commit; required for target picks and accepted groups. */
  sandboxConflictsJson: string | null;
  files: Record<string, string>;
}
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const digest = (bytes: string) => createHash('sha256').update(bytes, 'utf8').digest('hex');
/** Stable across object insertion order; blob values retain their exact bytes. */
export function bytes(value: unknown): string {
  function ordered(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(ordered);
    if (v !== null && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, ordered(val)]),
      );
    return v;
  }
  return JSON.stringify(ordered(value), null, 2) + '\n';
}
function inventory(files: Record<string, string>): string {
  return digest(bytes(files));
}
function parseAliasGroups(raw: Inputs['aliasGroupsJson']): AliasGroups | undefined {
  return raw === null ? undefined : aliasGroupsSchema.parse(JSON.parse(raw));
}
function inputs(input: Inputs) {
  for (const key of ['editorHead', 'engineCommit', 'catalogCommit', 'compendiumCommit'] as const)
    sha.parse(input[key]);
  z.string().datetime({ offset: true }).parse(input.snapshotAt);
  const items = itemsSchema.parse(JSON.parse(input.itemsJson));
  const categories = presentCategories(
    z.array(categorySchema).parse(JSON.parse(input.categoriesJson)),
  );
  const pointers =
    input.sandboxPointersJson === null
      ? undefined
      : sandboxPointersSchema.parse(JSON.parse(input.sandboxPointersJson));
  const conflicts =
    input.sandboxConflictsJson === null
      ? undefined
      : sandboxConflictsSchema.parse(JSON.parse(input.sandboxConflictsJson));
  const aliasGroups = parseAliasGroups(input.aliasGroupsJson);
  if (!conflicts && (hasSandboxTargets(pointers) || Object.keys(aliasGroups?.groups ?? {}).length))
    throw new Error('Sandbox target picks and accepted alias groups require pinned conflicts');
  const generatorAliases = aliasesSchema.parse(JSON.parse(input.aliasesJson));
  const { aliases, issues } = composeAliases(
    generatorAliases,
    aliasGroups,
    items,
    conflicts,
    pointers,
  );
  const data = compendiumDataSchema.parse(JSON.parse(input.compendiumJson));
  data.tabs = data.tabs.filter((tab) => isTrackedCompendiumTab(tab.name));
  const inactiveMoves =
    input.inactiveJson === null ? {} : inactiveMovesSchema.parse(JSON.parse(input.inactiveJson));
  const tooltips: Record<string, Tooltip> = {};
  for (const [path, raw] of Object.entries(input.files)) {
    if (!/^tooltips\/(0|[1-9]\d*)\.json$/.test(path)) throw new Error(`Invalid path: ${path}`);
    const tooltip = tooltipSchema.parse(JSON.parse(raw));
    if (path !== `tooltips/${tooltip.hash}.json`) throw new Error(`Hash mismatch: ${path}`);
    tooltips[tooltip.hash] = tooltip;
  }
  const editor: EditorData = {
    items,
    categories,
    aliases,
    generatorAliases,
    aliasGroupIssues: issues,
    ...(conflicts ? { sandboxConflicts: conflicts } : {}),
    bundle: {
      sourceCommit: input.editorHead,
      generatedAt: input.snapshotAt,
      permissions: { users: {} },
      pushed: {},
      tooltips,
      inactiveMoves,
      aliasGroups,
      sandboxPointers: pointers,
    },
  };
  return { items, aliases, data, tooltips, editor };
}
const optionalDigest = (value: string | null) => (value === null ? null : digest(value));
function pins(input: Inputs) {
  return {
    engineCommit: input.engineCommit,
    catalogCommit: input.catalogCommit,
    compendiumCommit: input.compendiumCommit,
    snapshotAt: input.snapshotAt,
    itemsSha256: digest(input.itemsJson),
    categoriesSha256: digest(input.categoriesJson),
    aliasesSha256: digest(input.aliasesJson),
    compendiumSha256: digest(input.compendiumJson),
    inactiveSha256: optionalDigest(input.inactiveJson),
    aliasGroupsSha256: optionalDigest(input.aliasGroupsJson),
    sandboxPointersSha256: optionalDigest(input.sandboxPointersJson),
    sandboxConflictsSha256: optionalDigest(input.sandboxConflictsJson),
    guidanceSha256: digest(bytes(approved)),
  };
}
export interface Change {
  path: string;
  before: string | null;
  after: string | null;
  beforeSha256: string | null;
  afterSha256: string | null;
}
export interface Manifest {
  version: 1;
  direction: 'link' | 'rollback';
  rollbackOf?: string;
  editorHead: string;
  pins: ReturnType<typeof pins>;
  beforeInventory: string;
  afterInventory: string;
  changes: Change[];
  rows: { hash: number; reason: string; linkOnly: boolean }[];
}
function change(path: string, before: string | null, after: string | null): Change {
  return {
    path,
    before,
    after,
    beforeSha256: before === null ? null : digest(before),
    afterSha256: after === null ? null : digest(after),
  };
}
function afterFiles(files: Record<string, string>, changes: Change[]) {
  const next = { ...files };
  for (const row of changes) {
    if (row.after === null) delete next[row.path];
    else next[row.path] = row.after;
  }
  return next;
}
/** Includes the whole catalog, including entries with no stored tooltip or English text. */
export function plan(input: Inputs): Manifest {
  const { items, aliases, data, tooltips, editor } = inputs(input);
  const changes: Change[] = [];
  const rows: Manifest['rows'] = [];
  const hashes = [...new Set([...Object.keys(items), ...Object.keys(tooltips)])]
    .map(Number)
    .sort((a, b) => a - b);
  withCompendiumMatchingIndex(data, () => {
    // The app's actual display pipeline is authoritative, including shipped guidance.
    // No local drafts, local guidance, or personal review progress enter cut-over.
    const proposals = new Map(
      reviewEvidence(editor, data, {}, '').map((entry) => [
        entry.hash,
        proposalFor(entry.base, editor, data),
      ]),
    );
    const displayed = displayMatches(
      editor,
      data,
      {},
      emptyProgress(),
      undefined,
      approved.scope,
      proposals,
    );
    const decisions = new Map(displayed.decisions.map((decision) => [decision.hash, decision]));
    for (const hash of hashes) {
      const tooltip = tooltips[hash] ?? { hash, text: {}, associated: [] };
      const linkOnly = !hasTooltipText(tooltip);
      // A human link remains authoritative even if its source was deleted or moved.
      let reason: string;
      let next: Tooltip | undefined;
      if (tooltip.compendium) reason = 'preserved';
      else if (tooltip.archive) reason = 'archived';
      else if (!items[hash]) reason = 'unknown';
      else if (resolveAlias(hash, aliases) !== hash) reason = 'alias';
      else {
        const match = displayed.matches.get(hash);
        const link = match && confirmCompendiumSelection(match, data);
        if (match && !link) throw new Error(`Displayed match cannot be confirmed: ${hash}`);
        reason = link ? 'linked' : (decisions.get(hash)?.confidence ?? 'not-displayed');
        if (link) next = { ...tooltip, compendium: { ...link, snapshotAt: input.snapshotAt } };
      }
      if (next) {
        tooltipSchema.parse(next);
        // Only add the link: retain all existing fields, and all language timestamps.
        const path = `tooltips/${hash}.json`;
        const original = input.files[path] ?? null;
        const raw = original === null ? tooltip : JSON.parse(original);
        const after = JSON.stringify({ ...raw, compendium: next.compendium }, null, 2) + '\n';
        changes.push(change(path, original, after));
      }
      rows.push({ hash, reason, linkOnly });
    }
  });
  return {
    version: 1,
    direction: 'link',
    editorHead: input.editorHead,
    pins: pins(input),
    beforeInventory: inventory(input.files),
    afterInventory: inventory(afterFiles(input.files, changes)),
    changes,
    rows,
  };
}

/** Backup is separate, digest-bound, and contains absence markers for newly created files. */
export function backup(manifest: Manifest) {
  return {
    manifestSha256: digest(bytes(manifest)),
    editorHead: manifest.editorHead,
    files: Object.fromEntries(manifest.changes.map((row) => [row.path, row.before])),
  };
}

function sameSources(input: Inputs, manifest: Manifest) {
  inputs(input);
  if (bytes(pins(input)) !== bytes(manifest.pins)) throw new Error('Stale source pins');
}

/** Forward rollback requires a NEW approval and preserves intervening edits by refusing them. */
export function planRollback(original: Manifest, current: Inputs): Manifest {
  sameSources(current, original);
  if (original.direction !== 'link' || inventory(current.files) !== original.afterInventory)
    throw new Error('Rollback requires exact after-images');
  const changes = original.changes.map((row) => change(row.path, row.after, row.before));
  const restored = afterFiles(current.files, changes);
  // Reconstruct the forward candidate through the real resolver, rejecting forged manifests.
  const forward = plan({ ...current, editorHead: original.editorHead, files: restored });
  if (bytes(forward) !== bytes(original)) throw new Error('Invalid original manifest');
  return {
    version: 1,
    direction: 'rollback',
    rollbackOf: digest(bytes(original)),
    editorHead: current.editorHead,
    pins: pins(current),
    beforeInventory: original.afterInventory,
    afterInventory: original.beforeInventory,
    changes,
    rows: [],
  };
}

export interface Store {
  read(): Promise<Inputs>;
  /** MUST atomically compare the head AND source pins, and commit ALL blobs or NONE.
   * The adapter must enforce the complete inventory, not just changed paths.
   * Never implement this as a loop over Worker save endpoints or local file writes. */
  compareAndSwap(
    expected: Inputs,
    changes: readonly Change[],
    manifestSha256: string,
  ): Promise<boolean>;
}
/** No CLI write command. S2 supplies a Git-ref CAS adapter at the owner-approved cut-over. */
export async function applyApproved(
  store: Store,
  manifest: Manifest,
  approvedManifestSha256: string,
  savedBackup: ReturnType<typeof backup>,
  original?: Manifest,
): Promise<{ status: 'applied' | 'noop'; head: string; manifestSha256: string }> {
  const id = digest(bytes(manifest));
  if (!/^[a-f0-9]{64}$/.test(approvedManifestSha256) || approvedManifestSha256 !== id)
    throw new Error('Explicit approved manifest digest required');
  if (bytes(savedBackup) !== bytes(backup(manifest))) throw new Error('Backup mismatch');
  const current = await store.read();
  sameSources(current, manifest);
  // Validate even on retry: inverse images reconstruct the exact approved starting state.
  const replay = inventory(current.files) === manifest.afterInventory;
  const before = replay
    ? afterFiles(
        current.files,
        manifest.changes.map((row) => change(row.path, row.after, row.before)),
      )
    : current.files;
  const base = { ...current, editorHead: manifest.editorHead, files: before };
  const candidate =
    manifest.direction === 'link'
      ? plan(base)
      : original
        ? planRollback(original, base)
        : undefined;
  if (bytes(candidate) !== bytes(manifest)) throw new Error('Manifest does not match pinned plan');
  if (replay) return { status: 'noop', head: current.editorHead, manifestSha256: id };
  if (
    current.editorHead !== manifest.editorHead ||
    inventory(current.files) !== manifest.beforeInventory
  )
    throw new Error('Stale editor head or inventory');
  if (!(await store.compareAndSwap(current, manifest.changes, id))) throw new Error('CAS conflict');
  const persisted = await store.read();
  sameSources(persisted, manifest);
  if (inventory(persisted.files) !== manifest.afterInventory)
    throw new Error('Persisted verification failed');
  return { status: 'applied', head: persisted.editorHead, manifestSha256: id };
}

/** S2 must call this on its rebuilt bundle BEFORE issuing the first upload's receipt. */
export function verifyBundle(
  manifest: Manifest,
  persisted: Inputs,
  bundle: { sourceCommit: string; tooltips: Record<string, Tooltip>; aliasGroups?: AliasGroups },
): void {
  sameSources(persisted, manifest);
  if (
    inventory(persisted.files) !== manifest.afterInventory ||
    bundle.sourceCommit !== persisted.editorHead
  )
    throw new Error('Bundle head or persisted inventory mismatch');
  const expected = Object.fromEntries(
    Object.entries(persisted.files).map(([, raw]) => {
      const t = tooltipSchema.parse(JSON.parse(raw));
      return [t.hash, t];
    }),
  );
  if (bytes(bundle.tooltips) !== bytes(expected)) throw new Error('Bundle tooltips mismatch');
  if (
    bytes(bundle.aliasGroups ?? null) !== bytes(parseAliasGroups(persisted.aliasGroupsJson) ?? null)
  )
    throw new Error('Bundle alias groups mismatch');
}

/** Explicit CLI entry: imports must stay inert when S2 bundles this library. */
export function runCli(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { input: { type: 'string' }, out: { type: 'string' } },
  });
  if (!values.input || !values.out)
    throw new Error('Usage: --input pinned-inputs.json --out NEW-directory');
  const input = JSON.parse(readFileSync(values.input, 'utf8')) as Inputs;
  const manifest = plan(input);
  const out = resolve(values.out);
  mkdirSync(out); // Exclusive directory: never overwrite an earlier candidate or backup.
  writeFileSync(join(out, 'manifest.json'), bytes(manifest), { flag: 'wx' });
  writeFileSync(join(out, 'backup.json'), bytes(backup(manifest)), { flag: 'wx' });
  console.log(
    bytes({
      manifestSha256: digest(bytes(manifest)),
      changes: manifest.changes.length,
      linkOnly: manifest.changes.filter((c) =>
        manifest.rows.some((r) => r.linkOnly && c.path === `tooltips/${r.hash}.json`),
      ).length,
      reasons: manifest.rows.reduce<Record<string, number>>((counts, row) => {
        counts[row.reason] = (counts[row.reason] ?? 0) + 1;
        return counts;
      }, {}),
    }),
  );
}
