import { z } from 'zod';
import { resolveAlias, type Aliases } from './aliases.js';
import { hashSchema } from './legacy.js';

/**
 * Maintainer picks for shared sandbox perks (owner 2026-11-12): a sandbox perk that items with
 * different tooltips share gets no generator alias; a maintainer points it at one reviewed
 * tooltip, or confirms "no tooltip". The picks live in the editor-data file below and are merged
 * into the generator's aliases by `mergeSandboxPointers`, the one function every exporter calls.
 */
export const sandboxPointersPath = 'config/sandbox-pointers.json';
/** Generator file: sandbox perk hash -> the tooltip identities that share it, sorted. */
export const sandboxConflictsFile = 'sandboxConflicts.json';
/** PIN capability of a publisher build that merges `config/sandbox-pointers.json`. */
export const sandboxPointersCapability = 'sandboxPointers';

const hashKey = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((value) => Number(value) <= 0xffffffff);
const decided = {
  /** The generator's candidate set when the pick was made, sorted; flags later changes. */
  candidates: z.array(hashSchema),
  /** GitHub numeric id of the maintainer, as in permissions. */
  by: z.number().int().positive(),
  at: z.string().datetime({ offset: true }),
};
/** A decision: exactly one of `to` (point at that canonical tooltip) or `none` (no tooltip). */
export const sandboxDecisionSchema = z.union([
  z.object({ to: hashSchema, ...decided }).strict(),
  z.object({ none: z.literal(true), ...decided }).strict(),
]);
/**
 * A pick that was undone (root 2026-11-13): kept as a tombstone so the file still names the perk
 * and every export recomputes its live entry (core mergeLivePerks). Not "no tooltip": it outputs
 * exactly what an unreviewed row outputs, and the worklist shows the row as unreviewed.
 */
export const sandboxUndoneSchema = z
  .object({ state: z.literal('undone'), by: decided.by, at: decided.at })
  .strict();
export const sandboxPointerSchema = z.union([sandboxDecisionSchema, sandboxUndoneSchema]);
export const sandboxPointersSchema = z
  .object({ version: z.literal(1), pointers: z.record(hashKey, sandboxPointerSchema) })
  .strict();
export const sandboxConflictsSchema = z.record(hashKey, z.array(hashSchema));
/** A pick as the worklist stages it: the decision alone (who, when, and what set are server-side). */
export const sandboxPickSchema = z.union([
  z.object({ to: hashSchema }).strict(),
  z.object({ none: z.literal(true) }).strict(),
]);

export type SandboxPointer = z.infer<typeof sandboxPointerSchema>;
export type SandboxDecision = z.infer<typeof sandboxDecisionSchema>;
export type SandboxPointers = z.infer<typeof sandboxPointersSchema>;
export type SandboxConflicts = z.infer<typeof sandboxConflictsSchema>;
export type SandboxPick = z.infer<typeof sandboxPickSchema>;

export const emptySandboxPointers = (): SandboxPointers => ({ version: 1, pointers: {} });

export function sameCandidates(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  return x.every((value, index) => value === y[index]);
}

/** A stored entry that is a decision (`to` or `none`), not an undone tombstone. */
export function isSandboxDecision(pointer: SandboxPointer | undefined): pointer is SandboxDecision {
  return !!pointer && !('state' in pointer);
}

const pickKey = (value: SandboxPick | SandboxPointer) =>
  'to' in value ? `to:${value.to}` : 'none' in value ? 'none' : 'undone';
export function samePick(a: SandboxPick | SandboxPointer, b: SandboxPick | SandboxPointer) {
  return pickKey(a) === pickKey(b);
}

const targetSets = new WeakMap<Aliases, Set<number>>();
/** Every hash some alias points at directly (a picked perk has no alias of its own to chain). */
function aliasTargets(aliases: Aliases): Set<number> {
  let targets = targetSets.get(aliases);
  if (!targets) {
    targets = new Set();
    for (const entry of Object.values(aliases))
      if (entry && typeof entry.to === 'number') targets.add(entry.to);
    targetSets.set(aliases, targets);
  }
  return targets;
}

/**
 * Why a `to` pointer is not merged, or null when it is. A pick applies while its sandbox hash is
 * still a generator conflict without a generator alias, and its target is canonical (neither a
 * generator alias nor another picked sandbox hash). A changed candidate set does NOT stop it
 * (owner 2026-11-12 "Keep working, flag it"); `sandboxPointerChanged` flags that row instead.
 * A perk a generator alias points into is refused too. Whether the target has text is the exporter's own check: a target that is not exported writes
 * no stub (exportLegacy only writes stubs for exported canonical tooltips).
 */
export function sandboxPointerProblem(
  hash: string,
  to: number,
  aliases: Aliases,
  conflicts: SandboxConflicts,
  /** Every pick (stored or staged) by sandbox hash; only the keys are read. */
  pointers: Readonly<Record<string, unknown>>,
): string | null {
  if (!Object.hasOwn(conflicts, hash)) return 'is no longer a shared sandbox perk';
  if (Object.hasOwn(aliases, hash)) return 'already has a generator tooltip pointer';
  // A generator alias into the perk would re-resolve through the pick (e.g. a frame stub to it).
  if (aliasTargets(aliases).has(Number(hash))) return 'is the target of a generator alias';
  if (String(to) === hash) return 'cannot point at itself';
  if (Object.hasOwn(aliases, String(to)) || resolveAlias(to, aliases) !== to)
    return `points at ${to}, which is an alias, not a canonical tooltip`;
  if (Object.hasOwn(pointers, String(to))) return `points at ${to}, another shared sandbox perk`;
  return null;
}

/** Whether the generator's candidate set for this pick differs from the one the maintainer saw. */
export function sandboxPointerChanged(
  hash: string,
  pointer: SandboxDecision,
  conflicts: SandboxConflicts,
): boolean {
  const current = conflicts[hash];
  return !current || !sameCandidates(current, pointer.candidates);
}

/**
 * Generator aliases plus every valid `to` pick as a `sandbox` alias. Every path that emits
 * clarityV2 sandbox stubs (Worker push, publisher, the editor's alias view) uses this, so the
 * stubs and the publishable digests agree everywhere. "No tooltip" picks, undone picks, and
 * unreviewed rows add nothing. With no applicable pick the very same `aliases` object is returned
 * (byte-identical output, and alias-keyed caches stay warm).
 */
export function mergeSandboxPointers(
  aliases: Aliases,
  conflicts: SandboxConflicts,
  pointers: SandboxPointers | null | undefined,
): Aliases {
  if (!pointers) return aliases;
  // Decisions only: an undone tombstone is no pick, so it never blocks a target (as the route,
  // which validates against the decisions a save sends).
  const decisions = Object.fromEntries(
    Object.entries(pointers.pointers).filter(([, pointer]) => isSandboxDecision(pointer)),
  );
  let merged: Aliases | undefined;
  for (const [hash, pointer] of Object.entries(decisions)) {
    if (!('to' in pointer)) continue;
    if (sandboxPointerProblem(hash, pointer.to, aliases, conflicts, decisions)) continue;
    merged ??= { ...aliases };
    merged[hash] = { to: pointer.to, kind: 'sandbox' };
  }
  if (!merged) return aliases;
  // Keys in numeric order, like the generator writes them.
  return Object.fromEntries(
    Object.entries(merged).sort(([a], [b]) => Number(a) - Number(b)),
  ) as Aliases;
}

/** Whether any pick points at a tooltip (only then do exporters need the conflicts file). */
export function hasSandboxTargets(pointers: SandboxPointers | null | undefined): boolean {
  return Boolean(pointers && Object.values(pointers.pointers).some((pointer) => 'to' in pointer));
}

/**
 * The document a save writes: `picks` is the complete desired set of decisions. A pick whose
 * decision is unchanged keeps its stored entry (who, when, and the candidate set they saw); a new
 * or changed one records `by`, `at`, and the current candidate set. A stored hash the picks omit
 * becomes (or stays) an undone tombstone, never erased, so exports keep recomputing its entry.
 */
export function applySandboxPicks(
  current: SandboxPointers,
  picks: Record<string, SandboxPick>,
  conflicts: SandboxConflicts,
  by: number,
  at: string,
): SandboxPointers {
  const pointers: SandboxPointers['pointers'] = {};
  for (const hash of Object.keys(picks).sort((a, b) => Number(a) - Number(b))) {
    const pick = picks[hash]!;
    const stored = current.pointers[hash];
    if (stored && samePick(stored, pick)) {
      pointers[hash] = stored;
      continue;
    }
    const candidates = [...(conflicts[hash] ?? [])].sort((a, b) => a - b);
    pointers[hash] =
      'to' in pick ? { to: pick.to, candidates, by, at } : { none: true, candidates, by, at };
  }
  for (const [hash, stored] of Object.entries(current.pointers)) {
    if (Object.hasOwn(picks, hash)) continue;
    pointers[hash] = isSandboxDecision(stored) ? { state: 'undone', by, at } : stored;
  }
  return {
    version: 1,
    pointers: Object.fromEntries(
      Object.entries(pointers).sort(([a], [b]) => Number(a) - Number(b)),
    ),
  };
}
