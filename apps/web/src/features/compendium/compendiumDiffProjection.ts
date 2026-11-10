import {
  diffCompendium,
  sameCell,
  styleKey,
  type CompendiumCell,
  type CompendiumDiffPart,
  type CompendiumRun,
} from '@clarity/core';

/**
 * The Changes view, prepared off the main thread (compendiumDiff.worker.ts) and cached by content
 * (compendiumDiffCache.ts). Lines are aligned first; a word diff is drawn only inside aligned
 * pairs that still read as the same line (changed-ink share <= INLINE_MAX_SHARE); everything else
 * becomes a block: the removed lines, then the added lines. Style-only differences never draw
 * per-word boxes: a line carries one note, and a note shared by several lines is hoisted to the
 * cell. Alignment and sheet background are display-only (core evidenceCell) and are never marked.
 */
export const INLINE_MAX_SHARE = 0.4;
/** Lines of a changed hunk pair up when their words overlap more than this (Dice coefficient). */
export const PAIR_MIN_SIMILARITY = 0.3;
/** A style note shared by this many lines moves from the lines to the cell. */
export const HOIST_MIN_LINES = 3;

type Align = CompendiumRun['textAlign'];
export type InlinePart = { kind: 'equal' | 'removed' | 'added'; cell: CompendiumCell };
export type StyleChange = { key: string; from: string; to: string };
export type StyleNote = {
  description: string;
  changes: StyleChange[];
  before: CompendiumCell;
  after: CompendiumCell;
};
export type DiffLine =
  /** Text unchanged (styling may differ: `style`). */
  | { kind: 'equal'; cell: CompendiumCell; style?: StyleNote }
  /** A small edit: the new line with its removed and added words inline. */
  | { kind: 'inline'; parts: InlinePart[]; after: CompendiumCell; style?: StyleNote }
  /** Rewritten, removed, or added lines: old lines (may be empty), then new lines (may be empty). */
  | { kind: 'block'; before: CompendiumCell[]; after: CompendiumCell[] };
export type PreparedDiff = {
  lines: DiffLine[];
  /** One note for a style change shared by HOIST_MIN_LINES or more lines. */
  cellStyle?: string;
};
/** The cache and worker contract: the prepared Changes view of one before/after pair. */
export type PreparedDiffLines = PreparedDiff;

/** The alignment a line is drawn with: that of its first run with ink. */
export const lineAlign = (cell: CompendiumCell | undefined): Align =>
  (cell?.runs.find((run) => run.text.trim()) ?? cell?.runs[0])?.textAlign;

export function projectCompendiumDiff(before: CompendiumCell, after: CompendiumCell): PreparedDiff {
  if (sameCell(before, after))
    return { lines: splitLines(after).map((cell) => ({ kind: 'equal', cell })) };
  // A side with no text at all (a first revision, a removed link) has no lines, not one blank line.
  const left = before.plain ? splitLines(before) : [];
  const right = after.plain ? splitLines(after) : [];
  // Saved snapshots carry no alignment (it is not approval evidence): a removed line without its
  // own takes the sheet's from the new line it pairs with, a neighbouring line, or the cell.
  const cellAlign = commonAlign(right);
  const items: DiffLine[] = [];
  let li = 0;
  let ri = 0;
  for (const [l, r] of [...commonLines(left, right), [left.length, right.length]]) {
    if (l > li || r > ri) {
      const fallback = lineAlign(right[ri - 1] ?? right[r]) ?? cellAlign;
      for (const item of hunk(left.slice(li, l), right.slice(ri, r), fallback))
        pushMerging(items, item);
    }
    if (l < left.length) items.push(equalLine(left[l], right[r]));
    li = l + 1;
    ri = r + 1;
  }
  return hoistStyle({ lines: items });
}

/** The longest run of lines both sides share, in order: [old index, new index] per line. */
function commonLines(left: CompendiumCell[], right: CompendiumCell[]): [number, number][] {
  const cols = right.length + 1;
  const table = new Uint32Array((left.length + 1) * cols);
  for (let i = left.length - 1; i >= 0; i--)
    for (let j = right.length - 1; j >= 0; j--)
      table[i * cols + j] =
        left[i].plain === right[j].plain
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
  const matches: [number, number][] = [];
  for (let i = 0, j = 0; i < left.length && j < right.length;) {
    if (left[i].plain === right[j].plain) matches.push([i++, j++]);
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) i++;
    else j++;
  }
  return matches;
}

/** One cell per physical line (no newline characters); runs sliced to the line. */
export function splitLines(cell: CompendiumCell): CompendiumCell[] {
  const lines: CompendiumCell[] = [];
  let runs: CompendiumCell['runs'] = [];
  const finish = () => {
    lines.push({ plain: runs.map((run) => run.text).join(''), runs });
    runs = [];
  };
  for (const run of cell.runs) {
    run.text.split('\n').forEach((text, index) => {
      if (index) finish();
      if (text || !runs.length) runs.push({ ...run, text });
    });
  }
  finish();
  return lines;
}

function commonAlign(lines: CompendiumCell[]): Align {
  const counts = new Map<Align, number>();
  for (const line of lines)
    if (line.plain.trim()) counts.set(lineAlign(line), (counts.get(lineAlign(line)) ?? 0) + 1);
  let common: Align;
  let most = 0;
  for (const [align, count] of counts)
    if (count > most) {
      common = align;
      most = count;
    }
  return common;
}

/** An old line keeps the alignment it stores; one that stores none takes `align`. */
const aligned = (cell: CompendiumCell, align: Align): CompendiumCell =>
  align && !lineAlign(cell)
    ? { ...cell, runs: cell.runs.map((run) => ({ ...run, textAlign: align })) }
    : cell;

function equalLine(before: CompendiumCell, after: CompendiumCell): DiffLine {
  const style = sameCell(before, after) ? undefined : styleNote(before, after);
  return style ? { kind: 'equal', cell: after, style } : { kind: 'equal', cell: after };
}

/**
 * A changed hunk: each old line pairs with the first later new line similar enough to be the same
 * line; small edits stay inline, the rest form blocks.
 */
function hunk(removed: CompendiumCell[], added: CompendiumCell[], fallback: Align): DiffLine[] {
  const items: DiffLine[] = [];
  let next = 0;
  for (const old of removed) {
    let match = next;
    while (match < added.length && similarity(old.plain, added[match].plain) <= PAIR_MIN_SIMILARITY)
      match++;
    if (match === added.length) {
      // Unpaired: the new line at this position in the hunk is its neighbour.
      const neighbour = added[Math.min(next, added.length - 1)];
      items.push({
        kind: 'block',
        before: [aligned(old, lineAlign(neighbour) ?? fallback)],
        after: [],
      });
      continue;
    }
    for (let j = next; j < match; j++) items.push({ kind: 'block', before: [], after: [added[j]] });
    items.push(pair(old, added[match], lineAlign(added[match]) ?? fallback));
    next = match + 1;
  }
  for (let j = next; j < added.length; j++)
    items.push({ kind: 'block', before: [], after: [added[j]] });
  return items;
}

const ink = (text: string) => text.replace(/\s+/gu, '').length;

/** The share of a paired line's ink that changed: (removed + added) / (2 × equal + removed + added). */
export function changedShare(parts: CompendiumDiffPart[]): number {
  let changed = 0;
  let total = 0;
  for (const part of parts) {
    const size = ink((part.after ?? part.before!).plain);
    if (part.kind === 'added' || part.kind === 'removed') changed += size;
    total += part.kind === 'added' || part.kind === 'removed' ? size : 2 * size;
  }
  return total ? changed / total : 0;
}

/** Word diff inside an aligned pair: inline while the changed ink stays a minority, else a block. */
function pair(before: CompendiumCell, after: CompendiumCell, oldAlign: Align): DiffLine {
  const parts = diffCompendium(before, after);
  if (changedShare(parts) > INLINE_MAX_SHARE)
    return { kind: 'block', before: [aligned(before, oldAlign)], after: [after] };
  const styleBefore: CompendiumCell['runs'] = [];
  const styleAfter: CompendiumCell['runs'] = [];
  const inline: InlinePart[] = [];
  for (const part of parts) {
    if (part.kind === 'style') {
      styleBefore.push(...part.before!.runs);
      styleAfter.push(...part.after!.runs);
    }
    const cell = part.kind === 'removed' ? part.before! : part.after!;
    const kind = part.kind === 'style' ? 'equal' : part.kind;
    const previous = inline.at(-1);
    // Coalesce identically styled neighbours: one box per run, not per word.
    if (
      previous &&
      previous.kind === kind &&
      previous.cell.runs.length === 1 &&
      cell.runs.length === 1 &&
      !cell.runs[0].href &&
      styleKey(previous.cell.runs[0]) === styleKey(cell.runs[0])
    ) {
      previous.cell.plain += cell.plain;
      previous.cell.runs[0].text += cell.plain;
    } else
      inline.push({
        kind,
        cell: { plain: cell.plain, runs: cell.runs.map((run) => ({ ...run })) },
      });
  }
  // The note names what changed on the words both lines share; its popover shows the whole lines.
  const style = styleBefore.length
    ? {
        ...styleNote(
          { plain: styleBefore.map((run) => run.text).join(''), runs: styleBefore },
          { plain: styleAfter.map((run) => run.text).join(''), runs: styleAfter },
        ),
        before,
        after,
      }
    : undefined;
  return style
    ? { kind: 'inline', parts: inline, after, style }
    : { kind: 'inline', parts: inline, after };
}

/** Neighbouring blocks merge into one: all removed lines, then all added lines, in hunk order. */
function pushMerging(items: DiffLine[], item: DiffLine) {
  const previous = items.at(-1);
  if (item.kind === 'block' && previous?.kind === 'block') {
    previous.before.push(...item.before);
    previous.after.push(...item.after);
  } else items.push(item);
}

/** Dice coefficient over the words of two lines. */
export function similarity(a: string, b: string): number {
  const left = new Set(a.split(/\s+/u).filter(Boolean));
  const right = new Set(b.split(/\s+/u).filter(Boolean));
  if (!left.size && !right.size) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return (2 * shared) / (left.size + right.size);
}

// Alignment is display-only and never listed (owner 2026-11-06).
const styleKeys = ['color', 'bold', 'italic', 'underline', 'strike', 'sizePt', 'href'] as const;
const styleLabels: Record<(typeof styleKeys)[number], string> = {
  color: 'colour',
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strike: 'strike',
  sizePt: 'size',
  href: 'link',
};
const shown = (run: CompendiumRun, key: (typeof styleKeys)[number]) =>
  String(run[key] ?? (key === 'sizePt' || key === 'color' ? 'default' : 'off'));
const changeCache = new Map<string, StyleChange[]>();
/**
 * The styling that differs between two cells of the same text, compared character by character so
 * a colour that moved to other words still shows: [{ key: 'size', from: '9', to: '6' }, ...].
 */
export function styleChanges(before: CompendiumCell, after: CompendiumCell): StyleChange[] {
  // The result depends on where the ink is (ink is compared before spaces), so the key keeps it.
  const signature = (cell: CompendiumCell) =>
    cell.runs.map((run) => [run.text.replace(/\S/gu, 'x'), ...styleKeys.map((key) => run[key])]);
  const key = JSON.stringify([signature(before), signature(after)]);
  const cached = changeCache.get(key);
  if (cached !== undefined) return cached;
  const found = new Map<string, StyleChange>();
  const length = Math.min(before.plain.length, after.plain.length);
  // Ink first; a difference carried only by spaces (a trailing space, say) is named too.
  for (const spaces of [false, true]) {
    let b = 0;
    let a = 0;
    let bEnd = before.runs[0]?.text.length ?? 0;
    let aEnd = after.runs[0]?.text.length ?? 0;
    for (let i = 0; i < length; i++) {
      while (i >= bEnd && b < before.runs.length - 1) bEnd += before.runs[++b].text.length;
      while (i >= aEnd && a < after.runs.length - 1) aEnd += after.runs[++a].text.length;
      const old = before.runs[b];
      const current = after.runs[a];
      if (!old || !current || !before.plain[i].trim() !== spaces) continue;
      for (const name of styleKeys) {
        const from = shown(old, name);
        const to = shown(current, name);
        if (from !== to) found.set(`${name}|${from}|${to}`, { key: styleLabels[name], from, to });
      }
    }
    if (found.size) break;
  }
  const changes = [...found.values()];
  if (changeCache.size >= 256) changeCache.delete(changeCache.keys().next().value!);
  changeCache.set(key, changes);
  return changes;
}
/** "size: 9 → 6; colour: #ffd966 → #cccccc, #6fa8dc → #cccccc" grouped by property. */
export function describeChanges(changes: StyleChange[]): string {
  const byKey = new Map<string, Set<string>>();
  for (const change of changes) {
    const pairs = byKey.get(change.key) ?? new Set();
    pairs.add(`${change.from} → ${change.to}`);
    byKey.set(change.key, pairs);
  }
  // More than three distinct pairs of one property read as a list, not a change: count them.
  return (
    [...byKey]
      .map(
        ([key, pairs]) =>
          `${key}: ${pairs.size > 3 ? `${pairs.size} different values` : [...pairs].join(', ')}`,
      )
      .join('; ') || 'styling changed'
  );
}
function styleNote(before: CompendiumCell, after: CompendiumCell): StyleNote {
  const changes = styleChanges(before, after);
  return { description: describeChanges(changes), changes, before, after };
}

/**
 * Lines whose notes change the same properties (e.g. size + colour) are one cell-wide change when
 * HOIST_MIN_LINES or more share that signature: their markers go, and the key line names the
 * change once with every value pair seen. Lines with a different signature keep their markers.
 */
function hoistStyle(diff: PreparedDiff): PreparedDiff {
  const signature = (note: StyleNote) =>
    [...new Set(note.changes.map((change) => change.key))].sort().join('+');
  const counts = new Map<string, number>();
  for (const line of diff.lines)
    if (line.kind !== 'block' && line.style) {
      const key = signature(line.style);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  let hoisted: string | undefined;
  for (const [key, count] of counts)
    if (count >= HOIST_MIN_LINES && (hoisted === undefined || count > counts.get(hoisted)!))
      hoisted = key;
  if (hoisted === undefined) return diff;
  const changes: StyleChange[] = [];
  for (const line of diff.lines)
    if (line.kind !== 'block' && line.style && signature(line.style) === hoisted) {
      changes.push(...line.style.changes);
      delete line.style;
    }
  return { ...diff, cellStyle: `${describeChanges(changes)} (${counts.get(hoisted)} lines)` };
}
