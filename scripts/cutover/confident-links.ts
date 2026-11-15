import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { aliasesSchema, resolveAlias } from '../../packages/core/src/aliases.js';
import { tooltipSchema, hasTooltipText, type Tooltip } from '../../packages/core/src/schemas.js';
import { autoLinkCompendium } from '../../packages/core/src/compendium/link.js';
import { compendiumDataSchema } from '../../packages/core/src/compendium/types.js';
import { withCompendiumMatchingIndex } from '../../packages/core/src/compendium/resolve.js';

/** Exact UTF-8 blobs, not a checkout. Callers fetch immutable Git objects. */
export interface Inputs {
  editorHead: string;
  engineCommit: string;
  catalogCommit: string;
  compendiumCommit: string;
  snapshotAt: string;
  itemsJson: string;
  aliasesJson: string;
  compendiumJson: string;
  files: Record<string, string>;
}
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const itemSchema = z
  .object({
    hash: z.number().int().min(0).max(0xffffffff),
    name: z.string(),
    categoryId: z.string(),
    itemName: z.string().optional(),
    baseHash: z.number().int().optional(),
    setName: z.string().optional(),
    pieceCount: z.union([z.literal(2), z.literal(4)]).optional(),
    hiddenFromEditor: z.boolean().optional(),
    inGameDescription: z.string().optional(),
  })
  .passthrough();
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
function inputs(input: Inputs) {
  for (const key of ['editorHead', 'engineCommit', 'catalogCommit', 'compendiumCommit'] as const)
    sha.parse(input[key]);
  z.string().datetime({ offset: true }).parse(input.snapshotAt);
  const items = z.record(z.string(), itemSchema).parse(JSON.parse(input.itemsJson));
  for (const [key, item] of Object.entries(items))
    if (key !== String(item.hash)) throw new Error(`Invalid catalog key: ${key}`);
  const aliases = aliasesSchema.parse(JSON.parse(input.aliasesJson));
  for (const key of Object.keys(aliases)) resolveAlias(Number(key), aliases);
  const data = compendiumDataSchema.parse(JSON.parse(input.compendiumJson));
  const tooltips: Record<string, Tooltip> = {};
  for (const [path, raw] of Object.entries(input.files)) {
    if (!/^tooltips\/(0|[1-9]\d*)\.json$/.test(path)) throw new Error(`Invalid path: ${path}`);
    const tooltip = tooltipSchema.parse(JSON.parse(raw));
    if (path !== `tooltips/${tooltip.hash}.json`) throw new Error(`Hash mismatch: ${path}`);
    tooltips[tooltip.hash] = tooltip;
  }
  return { items, aliases, data, tooltips };
}
function pins(input: Inputs) {
  return {
    engineCommit: input.engineCommit,
    catalogCommit: input.catalogCommit,
    compendiumCommit: input.compendiumCommit,
    snapshotAt: input.snapshotAt,
    itemsSha256: digest(input.itemsJson),
    aliasesSha256: digest(input.aliasesJson),
    compendiumSha256: digest(input.compendiumJson),
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
  const { items, aliases, data, tooltips } = inputs(input);
  const changes: Change[] = [];
  const rows: Manifest['rows'] = [];
  const hashes = [...new Set([...Object.keys(items), ...Object.keys(tooltips)])]
    .map(Number)
    .sort((a, b) => a - b);
  const families = new Map<number, (typeof items)[string][]>();
  for (const item of Object.values(items)) {
    const owner = resolveAlias(item.hash, aliases);
    const family = families.get(owner) ?? [];
    family.push(item);
    families.set(owner, family);
  }
  withCompendiumMatchingIndex(data, () => {
    for (const hash of hashes) {
      const tooltip = tooltips[hash] ?? { hash, text: {}, associated: [] };
      const linkOnly = !hasTooltipText(tooltip);
      // A human link remains authoritative even if its source was deleted or moved.
      let reason: string;
      let next: Tooltip | undefined;
      if (tooltip.compendium) reason = 'preserved';
      else if (tooltip.archive) reason = 'archived';
      else if (!items[hash]) reason = 'unknown';
      else {
        const result = autoLinkCompendium(
          tooltip,
          items,
          aliases,
          data,
          input.snapshotAt,
          tooltips,
          families.get(hash) ?? [],
        );
        reason = result.reason;
        next = result.next;
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
  bundle: { sourceCommit: string; tooltips: Record<string, Tooltip> },
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
}

function main() {
  const { values } = parseArgs({ options: { input: { type: 'string' }, out: { type: 'string' } } });
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
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
