/**
 * Scheduled batches in the publisher (spec .agents/reports/scheduled-changes/spec.md, phase P4):
 * pure editor-data tree edits for the claim and the terminal RECORD of a `batch` operation.
 * Contracts come ONLY from `@clarity/core/schedule`; every write here lands in the one commit
 * the caller CASes (claim commit or RECORD), never a commit of its own.
 */
import {
  batchMemberSchema,
  batchSchema,
  dueSchema,
  scheduleIndexSchema,
  scheduleLimits,
  schedulePaths,
  type Batch,
  type BatchMember,
  type Due,
} from '@clarity/core/schedule';
import { stableStringify } from '../../packages/core/src/index.js';
import type { Tree } from './git.js';

export const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
export const iso = (ms: number) => new Date(ms).toISOString();

/** What a tree edit needs from the repository: reads and blob writes, never refs. */
export interface TreeIo {
  read<T>(tree: Tree, path: string): T | undefined;
  writeBlob(bytes: string): string;
}

export const supersededMessage =
  'Superseded: the batch was rescheduled, unscheduled, or changed after this operation was signed';
export const resolveActivationMessage = 'Resolve the batch activation first';
export const unpublishedMessage =
  'This field has saved changes that are not published yet; publish them first';

type BatchEvent = Batch['events'][number];

/** The archived events directory of a batch (root ruling 2026-11-13: `<seq>` = archived count). */
export const eventsArchive = (batchId: string, seq: number) =>
  `schedule/batches/${batchId}/events/${String(seq).padStart(8, '0')}.json`;

/** Every member of a batch at `tree`, sorted by hash. Fails closed on a malformed entry. */
export function batchMembers(io: TreeIo, tree: Tree, batchId: string): BatchMember[] {
  const prefix = `schedule/batches/${batchId}/tooltips/`;
  const members: BatchMember[] = [];
  for (const path of Object.keys(tree)) {
    if (!path.startsWith(prefix)) continue;
    const name = path.slice(prefix.length);
    if (!/^(0|[1-9]\d*)\.json$/.test(name)) throw new Error(`Unexpected batch entry ${path}`);
    const member = batchMemberSchema.parse(io.read(tree, path));
    if (String(member.hash) !== name.slice(0, -5))
      throw new Error(`Batch member ${path} carries another hash`);
    members.push(member);
  }
  return members.sort((a, b) => a.hash - b.hash);
}

/**
 * `batch` with one event appended and its revision bumped (+1 on every write; contentRevision
 * unchanged: the publisher never changes content). Past 200 inline events, the oldest move to
 * events/<seq>.json in the same tree, seq = the count already archived (root ruling).
 */
export function withEvent(
  io: TreeIo,
  tree: Tree,
  batch: Batch,
  update: Partial<Batch>,
  event: Omit<BatchEvent, 'revision' | 'contentRevision'>,
): Batch {
  const revision = batch.revision + 1;
  let events = [...batch.events, { ...event, revision, contentRevision: batch.contentRevision }];
  const overflow = events.length - scheduleLimits.inlineEvents;
  if (overflow > 0) {
    const prefix = `schedule/batches/${batch.id}/events/`;
    let archived = 0;
    for (const path of Object.keys(tree)) {
      if (!path.startsWith(prefix)) continue;
      if (!/^\d{8}\.json$/.test(path.slice(prefix.length)))
        throw new Error(`Unexpected archive entry ${path}`);
      const file = io.read<{ events: unknown[] }>(tree, path);
      if (!Array.isArray(file?.events)) throw new Error(`Malformed archive ${path}`);
      archived += file.events.length;
    }
    const target = eventsArchive(batch.id, archived);
    if (tree[target]) throw new Error(`Archive ${target} already exists`);
    tree[target] = io.writeBlob(json({ events: events.slice(0, overflow) }));
    events = events.slice(overflow);
  }
  return batchSchema.parse({ ...batch, ...update, revision, events });
}

/**
 * Apply `edit` to schedule/due.json. due.json is the cron's trigger, never the authority (the
 * publisher trusts batch.json and the request): a missing or malformed file, or an edit that
 * would make it invalid, is left as it is (repair script), so it can never wedge the queue.
 */
export function editDue(io: TreeIo, tree: Tree, edit: (entries: Due['entries']) => Due['entries']) {
  const current = dueSchema.safeParse(io.read<unknown>(tree, schedulePaths.due));
  if (!current.success) return;
  const next = dueSchema.safeParse({ entries: edit(current.data.entries) });
  if (!next.success) return;
  if (stableStringify(next.data) !== stableStringify(current.data))
    tree[schedulePaths.due] = io.writeBlob(json(next.data));
}

/**
 * Upsert the batch's schedule/index.json entry (derived UI list, NOT a guard). A missing or
 * malformed index is left for the repair script. Terminal entries beyond the cap drop oldest first.
 */
export function editIndex(io: TreeIo, tree: Tree, batch: Batch, hashes: number[], at: string) {
  const current = scheduleIndexSchema.safeParse(io.read<unknown>(tree, schedulePaths.index));
  if (!current.success) return;
  const entry = {
    id: batch.id,
    name: batch.name,
    status: batch.status,
    notBefore: batch.notBefore,
    opId: batch.opId,
    revision: batch.revision,
    hashes,
    updatedAt: at,
  };
  const batches = current.data.batches.some((b) => b.id === batch.id)
    ? current.data.batches.map((b) => (b.id === batch.id ? entry : b))
    : [...current.data.batches, entry];
  const terminal = batches
    .filter((b) => b.status === 'published' || b.status === 'cancelled')
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  const drop = new Set(
    terminal.slice(0, Math.max(0, terminal.length - scheduleLimits.indexTerminal)).map((b) => b.id),
  );
  const next = scheduleIndexSchema.safeParse({
    batches: batches.filter((b) => !drop.has(b.id)),
  });
  if (next.success) tree[schedulePaths.index] = io.writeBlob(json(next.data));
}
