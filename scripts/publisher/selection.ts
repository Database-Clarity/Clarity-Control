/**
 * Whole-selection publishes (`selection: 'whole'`, PIN capability `wholeSelectionV1`): the Worker
 * admits them without reading rows, so the publisher runs the ordinary route's row checks here,
 * one root at a time and with the Worker's own functions, and holds what fails instead of
 * refusing the whole selection. A held row takes with it every selected row that imports it, and
 * every selected removal that its published text still imports. Everything here reads one data
 * snapshot only, so the RECORD-time verification derives the same held rows again.
 */
import {
  heldRowSchema,
  isMovedInactive,
  markupImports,
  resolveAlias,
  stableStringify,
  tooltipSchema,
  type Aliases,
  type HeldRow,
  type InactiveMoves,
  type PublishPayload,
  type Tooltip,
} from '../../packages/core/src/index.js';
import { schedulePaths } from '@clarity/core/schedule';
import { refuseBaseEnhanced } from '../../apps/worker/src/baseEnhanced.js';
import { publisherPinPath, refuseUnlowerable } from '../../apps/worker/src/elementTags.js';
import { HttpError } from '../../apps/worker/src/http.js';
import { clearedStates } from '../../apps/worker/src/inactiveMoves.js';
import { refuseHeldSetBonuses } from '../../apps/worker/src/setBonusHold.js';
import type { GitHub, RepoFile } from '../../apps/worker/src/github.js';
import type { Tree } from './git.js';

interface Reader {
  read<T>(tree: Tree, path: string): T | undefined;
}
type Digest = (tooltip: Tooltip, hash: number) => Promise<string | undefined>;

/** The Worker's GitHub reads, answered from one data snapshot (the `head` argument is ignored). */
function snapshotReads(reader: Reader, tree: Tree): GitHub {
  const files = async (paths: readonly string[]): Promise<(RepoFile | null)[]> =>
    paths.map((path) => {
      const value = reader.read<unknown>(tree, path);
      return value === undefined ? null : { sha: tree[path]!, value };
    });
  return { files } as unknown as GitHub;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Imports named by a document's text, in every language, as hashes (global = 1). */
function imports(document: Tooltip | undefined, aliases: Aliases): number[] {
  if (!document) return [];
  return Object.values(document.text).flatMap((translation) =>
    translation
      ? markupImports(translation.text).flatMap((line) => {
          const from = line.match(/ from (\d+|global) *$/)?.[1];
          return from ? [resolveAlias(from === 'global' ? 1 : Number(from), aliases)] : [];
        })
      : [],
  );
}

/**
 * The rows of a whole-selection request the publisher holds, sorted by hash, with why. `digest`
 * is the reviewed digest of a saved document, as the ordinary path compares it.
 */
export async function heldRows(
  reader: Reader,
  tree: Tree,
  payload: Pick<PublishPayload, 'hashes' | 'expected'>,
  aliases: Aliases,
  moves: InactiveMoves,
  digest: Digest,
): Promise<HeldRow[]> {
  const held = new Map<number, HeldRow>();
  const hold = (row: HeldRow) => {
    if (!held.has(row.hash)) held.set(row.hash, heldRowSchema.parse(row));
  };
  const document = (prefix: string, hash: number) => {
    const raw = reader.read<unknown>(tree, `${prefix}/${hash}.json`);
    const parsed = raw === undefined ? undefined : tooltipSchema.safeParse(raw).data;
    return parsed?.hash === hash ? parsed : undefined;
  };
  // 1. What the ordinary publisher path calls stale or missing (its per-row outcomes).
  const roots = new Map<number, number[]>();
  for (const hash of payload.hashes) {
    const canonical = resolveAlias(hash, aliases);
    roots.set(canonical, [...(roots.get(canonical) ?? []), hash]);
  }
  const saved = new Map<number, Tooltip>();
  for (const [canonical, hashes] of roots) {
    const source =
      document('tooltips', canonical) ??
      (isMovedInactive(canonical, moves) &&
      reader.read(tree, `tooltips/${canonical}.json`) === undefined
        ? { hash: canonical, text: {}, associated: [] }
        : undefined);
    if (!source) {
      hold({ hash: canonical, code: 'changed', reason: 'The saved tooltip is missing.' });
      continue;
    }
    saved.set(canonical, source);
    const reviewed = await digest(source, canonical);
    if (hashes.some((hash) => payload.expected[hash] !== reviewed))
      hold({ hash: canonical, code: 'changed', reason: 'Saved text changed after review.' });
  }
  // 2. The scheduled-batch activation guard (R3), per row instead of for the whole request.
  for (const canonical of roots.keys())
    if (tree[schedulePaths.conflict(canonical)])
      hold({
        hash: canonical,
        code: 'activation',
        reason: 'A scheduled batch activation conflict on this tooltip waits to be resolved.',
      });
  // 3. The ordinary Worker admission checks, one root at a time, with the Worker's functions.
  const github = snapshotReads(reader, tree);
  const pin = { value: reader.read<unknown>(tree, publisherPinPath) };
  const active = [...roots.keys()].filter((hash) => !isMovedInactive(hash, moves));
  const removals = new Map<number, string>();
  for (const [hash, state] of await clearedStates(
    github,
    '',
    active.flatMap((hash) => saved.get(hash) ?? []),
    moves,
  ))
    if (state.state === 'removal') removals.set(hash, state.reviewed);
  const walks = new Map<number, Set<number>>();
  for (const root of active) {
    if (held.has(root)) continue;
    try {
      const checked = await refuseBaseEnhanced(github, '', [root], aliases, [], undefined, {
        moves,
        removals: new Map(removals),
      });
      for (const checkedDocument of checked.values())
        refuseUnlowerable(checkedDocument, pin, 'published');
      const own = checked.get(root);
      refuseHeldSetBonuses(own ? [own] : []);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      hold({
        hash: root,
        code: error.status === 409 ? 'changed' : 'refused',
        reason: error.status === 409 ? 'Saved text changed after review.' : message(error),
      });
    }
  }
  // 4. Dependencies: a row publishes with what its saved text imports (directly or through other
  // documents), and a removal waits for the held rows whose published text imports it.
  const walk = (root: number) => {
    let seen = walks.get(root);
    if (seen) return seen;
    seen = new Set<number>();
    const pending = imports(saved.get(root), aliases);
    while (pending.length) {
      const hash = pending.pop()!;
      if (seen.has(hash)) continue;
      seen.add(hash);
      pending.push(...imports(saved.get(hash) ?? document('tooltips', hash), aliases));
    }
    walks.set(root, seen);
    return seen;
  };
  const removing = new Set(
    [...roots.keys()].filter((hash) => isMovedInactive(hash, moves) || removals.has(hash)),
  );
  for (let changed = true; changed;) {
    changed = false;
    for (const root of roots.keys()) {
      if (held.has(root)) continue;
      const on =
        [...walk(root)].find((hash) => held.has(hash)) ??
        (removing.has(root)
          ? [...held.keys()].find((hash) =>
              imports(document('live/tooltips', hash), aliases).includes(root),
            )
          : undefined);
      if (on === undefined) continue;
      hold({
        hash: root,
        code: 'dependency',
        reason: `Publishes together with held tooltip ${on}.`,
        on,
      });
      changed = true;
    }
  }
  return [...held.values()].sort((a, b) => a.hash - b.hash);
}

/** The request as published after holding: the held rows (and their alias hashes) left out. */
export function keptPayload<T extends Pick<PublishPayload, 'hashes' | 'expected'>>(
  payload: T,
  held: readonly HeldRow[],
  aliases: Aliases,
): T {
  if (!held.length) return payload;
  const out = new Set(held.map(({ hash }) => hash));
  const hashes = payload.hashes.filter((hash) => !out.has(resolveAlias(hash, aliases)));
  return {
    ...payload,
    hashes,
    expected: Object.fromEntries(hashes.map((hash) => [hash, payload.expected[hash]!])),
  };
}

export const sameHeld = (a: readonly HeldRow[] | undefined, b: readonly HeldRow[] | undefined) =>
  stableStringify(a ?? []) === stableStringify(b ?? []);
