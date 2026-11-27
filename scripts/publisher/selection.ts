/**
 * Whole-selection publishes (`selection: 'whole'`, PIN capability `wholeSelectionV1`): the Worker
 * admits them without reading rows, so the publisher runs the ordinary route's row checks here,
 * one root at a time and with the Worker's own functions, plus the Action's own attributable
 * guards, and holds what fails instead of refusing the whole selection. A held row takes with it
 * every selected row that depends on it by Review's own dependency rules (publishDependencies:
 * the resolver's real reads, associations, and the live readers of a removal). Everything here
 * reads one data snapshot only, so the RECORD-time verification derives the same held rows again.
 */
import {
  extractBlocks,
  heldRowSchema,
  markupImports,
  isHeldSetBonus,
  isMovedInactive,
  pushedSchema,
  resolveAlias,
  selectedInactiveMoves,
  setBonusHoldMessage,
  stableStringify,
  tooltipSchema,
  type Aliases,
  type HeldRow,
  type InactiveMoves,
  type LegacyCatalog,
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
import { publishDependencies } from '../../apps/web/src/features/review/publishDependencies.js';
import type { Tree } from './git.js';

interface Reader {
  read<T>(tree: Tree, path: string): T | undefined;
}

export interface HoldInputs {
  reader: Reader;
  tree: Tree;
  aliases: Aliases;
  /** `config/inactive.json` at the snapshot (what the Worker's checks read). */
  stored: InactiveMoves;
  /** The stored moves plus the cleared removals of the selected documents. */
  moves: InactiveMoves;
  facts: LegacyCatalog;
  /** The reviewed digest of a saved document, as the ordinary path compares it. */
  digest(tooltip: Tooltip, hash: number): Promise<string | undefined>;
  /**
   * The shared-text (in-place globals) check per document for the rows still publishing: a map
   * of refused hash to reason. A failure that names no row is left to the publication itself.
   */
  inPlace?(kept: readonly number[], documents: readonly Tooltip[]): Map<number, string>;
}

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
/** Reasons are stored; a long refusal message is cut rather than failing the selection. */
const reasonOf = (text: string) => (text.length > 1000 ? `${text.slice(0, 997)}...` : text);

/** The saved documents of the data snapshot, by hash, read on demand (and listed for a spread). */
function savedDocuments(reader: Reader, tree: Tree): Record<string, Tooltip> {
  const read = (key: string | symbol) => {
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) return undefined;
    const parsed = tooltipSchema.safeParse(reader.read<unknown>(tree, `tooltips/${key}.json`)).data;
    return parsed?.hash === Number(key) ? parsed : undefined;
  };
  return new Proxy({} as Record<string, Tooltip>, {
    get: (_target, key) => read(key),
    has: (_target, key) => read(key) !== undefined,
    ownKeys: () =>
      Object.keys(tree).flatMap((path) => /^tooltips\/(\d+)\.json$/.exec(path)?.[1] ?? []),
    getOwnPropertyDescriptor: (_target, key) => {
      const value = read(key);
      return value && { value, enumerable: true, configurable: true, writable: false };
    },
  });
}

/** The rows of a whole-selection request the publisher holds, sorted by hash, with why. */
export async function heldRows(
  inputs: HoldInputs,
  payload: Pick<PublishPayload, 'hashes' | 'expected'>,
): Promise<HeldRow[]> {
  const { reader, tree, aliases, stored, moves, facts } = inputs;
  const held = new Map<number, HeldRow>();
  const hold = (row: HeldRow) => {
    if (!held.has(row.hash))
      held.set(row.hash, heldRowSchema.parse({ ...row, reason: reasonOf(row.reason) }));
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
      (isMovedInactive(canonical, stored) &&
      reader.read(tree, `tooltips/${canonical}.json`) === undefined
        ? { hash: canonical, text: {}, associated: [] }
        : undefined);
    if (!source) {
      hold({ hash: canonical, code: 'changed', reason: 'The saved tooltip is missing.' });
      continue;
    }
    saved.set(canonical, source);
    const reviewed = await inputs.digest(source, canonical);
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
  // 3. The ordinary Worker admission checks, one root at a time, with the Worker's functions,
  // then the Action's own guards that name one row (checkAndExport keeps them for the rest).
  const github = snapshotReads(reader, tree);
  const pin = { value: reader.read<unknown>(tree, publisherPinPath) };
  const active = [...roots.keys()].filter((hash) => !isMovedInactive(hash, stored));
  const removals = new Map<number, string>();
  for (const [hash, state] of await clearedStates(
    github,
    '',
    active.flatMap((hash) => saved.get(hash) ?? []),
    stored,
  ))
    if (state.state === 'removal') removals.set(hash, state.reviewed);
  for (const root of active) {
    if (held.has(root)) continue;
    try {
      const checked = await refuseBaseEnhanced(github, '', [root], aliases, [], undefined, {
        moves: stored,
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
      continue;
    }
    const own = saved.get(root)!;
    if (removals.has(root)) continue;
    if (!own.custom && !facts[root])
      hold({ hash: root, code: 'refused', reason: 'Missing generator facts.' });
    else if (isHeldSetBonus(own, facts[root]))
      hold({ hash: root, code: 'refused', reason: setBonusHoldMessage });
  }
  // 4. Dependencies, by Review's own rules: a row waits for every selected row it depends on.
  const dependencies = selectedDependencies(inputs, roots, saved);
  const close = () => {
    for (let changed = true; changed;) {
      changed = false;
      for (const [root, needs] of dependencies) {
        if (held.has(root)) continue;
        const on = needs.find((hash) => held.has(hash));
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
  };
  close();
  // 4b. What stays LIVE (unselected published rows and the held ones) must still resolve: a kept
  // removal it imports or associates, or a kept edit that drops an export it imports, is held.
  const stays = (hash: number) => held.has(hash) || !roots.has(hash);
  const retained = retainedReaders(
    inputs,
    document,
    [...roots.keys()].filter((hash) => !stays(hash)),
    stays,
    saved,
  );
  for (const [hash, reason] of retained) hold({ hash, code: 'refused', reason });
  close();
  // 5. Shared text (in-place globals) per document for what is still publishing.
  if (inputs.inPlace) {
    const kept = [...roots.keys()].filter((hash) => !held.has(hash));
    const documents = kept.flatMap((hash) =>
      isMovedInactive(hash, moves) ? [] : (saved.get(hash) ?? []),
    );
    for (const [hash, reason] of inputs.inPlace(kept, documents))
      hold({ hash, code: 'refused', reason });
    close();
  }
  return [...held.values()].sort((a, b) => a.hash - b.hash);
}

/**
 * Kept rows that would break text staying LIVE: removals (Inactive or cleared) that a retained
 * published row imports or associates, and edits that drop a named export a retained published row
 * imports. The publication's own consumer checks refuse these for the whole selection.
 */
function retainedReaders(
  { tree, aliases, moves }: HoldInputs,
  document: (prefix: string, hash: number) => Tooltip | undefined,
  kept: readonly number[],
  stays: (hash: number) => boolean,
  saved: ReadonlyMap<number, Tooltip>,
): Map<number, string> {
  const removals = new Set(kept.filter((hash) => isMovedInactive(hash, moves)));
  const dropped = new Map<number, Set<string>>();
  for (const hash of kept) {
    if (removals.has(hash)) continue;
    const before = document('live/tooltips', hash);
    const after = saved.get(hash);
    if (!before || !after) continue;
    const names = new Set<string>();
    for (const [lang, cell] of Object.entries(before.text)) {
      const now = extractBlocks(after.text[lang as keyof Tooltip['text']]?.text ?? '', 'export');
      for (const name of Object.keys(extractBlocks(cell?.text ?? '', 'export')))
        if (!Object.hasOwn(now, name)) names.add(name);
    }
    if (names.size) dropped.set(hash, names);
  }
  const refused = new Map<number, string>();
  if (!removals.size && !dropped.size) return refused;
  const kind = (hash: number) => (moves[hash]?.cleared ? 'cleared' : 'inactive');
  for (const path of Object.keys(tree)) {
    const reader = Number(/^live\/tooltips\/(\d+)\.json$/.exec(path)?.[1]);
    if (!Number.isInteger(reader) || !stays(reader)) continue;
    const live = document('live/tooltips', reader);
    if (!live) continue;
    for (const hash of live.associated) {
      const target = resolveAlias(hash, aliases);
      if (removals.has(target) && !refused.has(target))
        refused.set(
          target,
          `Tooltip ${reader} associates ${kind(target)} tooltip ${hash} on live.`,
        );
    }
    for (const cell of Object.values(live.text))
      for (const line of markupImports(cell?.text ?? '')) {
        const parts = /^import ([A-z0-9 ]+?) from (\d+) *$/.exec(line);
        if (!parts) continue;
        const target = resolveAlias(Number(parts[2]), aliases);
        if (target === reader || refused.has(target)) continue;
        if (removals.has(target))
          refused.set(
            target,
            `Tooltip ${reader} imports ${kind(target)} tooltip ${parts[2]} on live.`,
          );
        else {
          const name = parts[1]!.split(' ').find((word) => dropped.get(target)?.has(word));
          if (name)
            refused.set(
              target,
              `Tooltip ${reader} imports ${name} from this tooltip on live, which this edit removes.`,
            );
        }
      }
  }
  return refused;
}

/** Each selected root's selected dependencies (publishDependencies, as Review plans parts). */
function selectedDependencies(
  { reader, tree, aliases, moves }: HoldInputs,
  roots: ReadonlyMap<number, number[]>,
  saved: ReadonlyMap<number, Tooltip>,
): Map<number, number[]> {
  const selected = [...roots.keys()].flatMap((hash) => saved.get(hash) ?? []);
  const removing = Object.keys(
    selectedInactiveMoves(
      moves,
      selected.map(({ hash }) => hash),
      aliases,
    ),
  ).some((hash) => isMovedInactive(Number(hash), moves));
  let published: Record<number, Tooltip | null | undefined> = {};
  if (removing) {
    // As Review: the published version of a row with a marker, explicitly undefined without one.
    const pushed = pushedSchema.parse(reader.read(tree, 'live/pushed.json') ?? {});
    published = Object.fromEntries(
      selected.map(({ hash }) => {
        if (pushed[hash] === undefined) return [hash, undefined];
        const live = tooltipSchema.safeParse(reader.read(tree, `live/tooltips/${hash}.json`)).data;
        return [hash, live?.hash === hash ? live : null];
      }),
    );
  }
  return publishDependencies(
    savedDocuments(reader, tree),
    aliases,
    new Set(roots.keys()),
    selected,
    { moves, published },
  );
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
