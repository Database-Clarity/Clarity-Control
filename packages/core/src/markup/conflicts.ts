/**
 * Git-style conflict markers inside a tooltip's text. When a save finds that somebody else changed
 * the same text, the draft is rebased on their version and the lines both sides touched are written
 * as marker blocks the editor resolves in place:
 *
 *   <<<<<<< mine
 *   (my lines)
 *   =======
 *   (their lines)
 *   >>>>>>> theirs (author, time)
 *
 * Pure text functions: no editor, no store. Offsets are UTF-16 offsets into the text, the same
 * ones CodeMirror uses. Both LF and CRLF documents are handled and never mixed up.
 */

export type ConflictChoice = 'mine' | 'theirs' | 'both';

const openLine = /^<{7}(?: .*)?\s*$/;
const separatorLine = /^={7}\s*$/;
const closeLine = /^>{7}(?: .*)?\s*$/;

export interface ConflictBlock {
  /** Start of the opening marker line. */
  from: number;
  /** End of the opening marker line (before its line break): where the action widget sits. */
  openEnd: number;
  /** End of the closing marker line (before its line break). */
  to: number;
  /** The first line of "mine" starts here (the separator's start when "mine" has no lines). */
  mineFrom: number;
  /** Start of the separator line. */
  separatorFrom: number;
  /** The first line of "theirs" starts here (the closing marker's start when it has no lines). */
  theirsFrom: number;
  /** Start of the closing marker line. */
  closeFrom: number;
  mineLines: string[];
  theirsLines: string[];
  /** What follows ">>>>>>> theirs" on the closing line, e.g. "(alice, 2026-11-03 18:02)". */
  label: string;
}

interface Line {
  from: number;
  to: number;
  text: string;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let from = 0;
  for (;;) {
    const lf = text.indexOf('\n', from);
    if (lf < 0) {
      lines.push({ from, to: text.length, text: text.slice(from) });
      return lines;
    }
    const to = lf > from && text[lf - 1] === '\r' ? lf - 1 : lf;
    lines.push({ from, to, text: text.slice(from, to) });
    from = lf + 1;
  }
}

/** The line break the document uses (CRLF only when its first break is one). */
export function lineBreakOf(text: string): '\n' | '\r\n' {
  const lf = text.indexOf('\n');
  return lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
}

/** Every complete, well-ordered conflict block, in document order. */
export function findConflictBlocks(text: string): ConflictBlock[] {
  if (!text.includes('<<<<<<<')) return [];
  const blocks: ConflictBlock[] = [];
  const lines = linesOf(text);
  let open: Line | undefined;
  let separator: Line | undefined;
  let mine: Line[] = [];
  let theirs: Line[] = [];
  for (const line of lines) {
    if (openLine.test(line.text)) {
      // A new opening marker abandons an unfinished one (it stays a stray marker).
      open = line;
      separator = undefined;
      mine = [];
      theirs = [];
    } else if (open && !separator) {
      if (separatorLine.test(line.text)) separator = line;
      else mine.push(line);
    } else if (open && separator) {
      if (closeLine.test(line.text)) {
        blocks.push({
          from: open.from,
          openEnd: open.to,
          to: line.to,
          mineFrom: mine[0]?.from ?? separator.from,
          separatorFrom: separator.from,
          theirsFrom: theirs[0]?.from ?? line.from,
          closeFrom: line.from,
          mineLines: mine.map((entry) => entry.text),
          theirsLines: theirs.map((entry) => entry.text),
          label: line.text
            .replace(/^>{7}\s*/, '')
            .replace(/^theirs\s*/, '')
            .trim(),
        });
        open = undefined;
        separator = undefined;
        mine = [];
        theirs = [];
      } else theirs.push(line);
    }
  }
  return blocks;
}

/**
 * True while the text still carries a marker: a complete block, or a stray opening or closing
 * marker left by a hand edit. A lone `=======` is not enough (it is an ordinary line elsewhere).
 */
export function hasConflictMarkers(text: string): boolean {
  if (!text.includes('<<<<<<<') && !text.includes('>>>>>>>')) return false;
  return linesOf(text).some((line) => openLine.test(line.text) || closeLine.test(line.text));
}

/** How many blocks the text carries; stray markers each count one so none is overlooked. */
export function countConflicts(text: string): number {
  if (!hasConflictMarkers(text)) return 0;
  const complete = findConflictBlocks(text).length;
  if (complete > 0) return complete;
  return linesOf(text).filter((line) => openLine.test(line.text) || closeLine.test(line.text))
    .length;
}

/** Writes one block. `label` goes after ">>>>>>> theirs". */
export function writeConflictMarkers(
  mine: readonly string[],
  theirs: readonly string[],
  label = '',
  eol: '\n' | '\r\n' = '\n',
): string {
  return [
    '<<<<<<< mine',
    ...mine,
    '=======',
    ...theirs,
    `>>>>>>> theirs${label ? ` ${label}` : ''}`,
  ].join(eol);
}

function chosenLines(block: ConflictBlock, choice: ConflictChoice): string[] {
  return choice === 'mine'
    ? block.mineLines
    : choice === 'theirs'
      ? block.theirsLines
      : [...block.mineLines, ...block.theirsLines];
}

/** The edit that resolves one block (keep both = mine, then theirs). */
export function resolveConflictBlock(
  text: string,
  block: ConflictBlock,
  choice: ConflictChoice,
): { from: number; to: number; insert: string } {
  const lines = chosenLines(block, choice);
  if (lines.length > 0)
    return { from: block.from, to: block.to, insert: lines.join(lineBreakOf(text)) };
  // Nothing remains: take the block and one line break with it, so no blank line is left behind.
  const eol = lineBreakOf(text);
  if (text.startsWith(eol, block.to))
    return { from: block.from, to: block.to + eol.length, insert: '' };
  if (block.from >= eol.length && text.startsWith(eol, block.from - eol.length))
    return { from: block.from - eol.length, to: block.to, insert: '' };
  return { from: block.from, to: block.to, insert: '' };
}

/** Resolves every block the same way: "mine" is what a preview shows while markers remain. */
export function resolveConflictMarkers(text: string, choice: ConflictChoice = 'mine'): string {
  const blocks = findConflictBlocks(text);
  if (!blocks.length) return text;
  let out = text;
  for (const block of [...blocks].reverse()) {
    const edit = resolveConflictBlock(text, block, choice);
    out = out.slice(0, edit.from) + edit.insert + out.slice(edit.to);
  }
  return out;
}

/**
 * The same text with every marker line and every "theirs" line blanked to spaces (line breaks
 * kept), so a validator sees only "mine" yet every offset still points into the real document.
 */
export function maskConflicts(text: string): string {
  const blocks = findConflictBlocks(text);
  if (!blocks.length) return text;
  const blank = (slice: string) => slice.replace(/[^\r\n]/g, ' ');
  let out = '';
  let at = 0;
  for (const block of blocks) {
    out += text.slice(at, block.from);
    out += blank(text.slice(block.from, block.mineFrom)); // opening marker
    out += text.slice(block.mineFrom, block.separatorFrom); // mine
    out += blank(text.slice(block.separatorFrom, block.to)); // separator, theirs, closing marker
    at = block.to;
  }
  return out + text.slice(at);
}

// --- Line-level three-way merge ------------------------------------------------------------

interface Hunk {
  /** Base lines [start, end) are replaced by `lines` (a pure insertion has start === end). */
  start: number;
  end: number;
  lines: string[];
  /** Where those lines start in the other text. */
  at: number;
}

const maxDiffCells = 4_000_000;

/** The changes turning `base` into `other`, as hunks; null when the inputs are too big to diff. */
function diffLines(base: string[], other: string[]): Hunk[] | null {
  const n = base.length;
  const m = other.length;
  let head = 0;
  while (head < n && head < m && base[head] === other[head]) head++;
  let tail = 0;
  while (tail < n - head && tail < m - head && base[n - 1 - tail] === other[m - 1 - tail]) tail++;
  const a = base.slice(head, n - tail);
  const b = other.slice(head, m - tail);
  if (a.length * b.length > maxDiffCells) return null;
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let current: Hunk | undefined;
  const flush = () => {
    if (current) hunks.push(current);
    current = undefined;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (
      j < b.length &&
      (i === a.length || table[i * width + j + 1] >= table[(i + 1) * width + j])
    ) {
      current ??= { start: head + i, end: head + i, lines: [], at: head + j };
      current.lines.push(b[j++]);
    } else {
      current ??= { start: head + i, end: head + i, lines: [], at: head + j };
      current.end = head + ++i;
    }
  }
  flush();
  return hunks;
}

export interface TextMerge {
  text: string;
  /** Conflict blocks written (0: the two sides merged cleanly). */
  conflicts: number;
}

const splitLines = (text: string) => text.split(/\r?\n/);

/** `base` with the hunks of one side applied over base lines [start, end). */
function applied(base: string[], hunks: Hunk[], start: number, end: number): string[] {
  const out: string[] = [];
  let at = start;
  for (const hunk of hunks) {
    out.push(...base.slice(at, hunk.start), ...hunk.lines);
    at = hunk.end;
  }
  out.push(...base.slice(at, end));
  return out;
}

/**
 * Merges two edits of `base` the way git does: lines only one side changed are taken, lines both
 * changed the same way are taken once, and lines both changed differently (or that touch each
 * other) become a marker block. `label` describes "theirs" on the closing marker.
 */
export function mergeTextWithMarkers(
  base: string,
  mine: string,
  theirs: string,
  label = '',
): TextMerge {
  const eol = lineBreakOf(mine.includes('\n') ? mine : theirs);
  const baseLines = splitLines(base);
  const mineLines = splitLines(mine);
  const theirsLines = splitLines(theirs);
  const mineHunks = diffLines(baseLines, mineLines);
  const theirsHunks = diffLines(baseLines, theirsLines);
  if (!mineHunks || !theirsHunks)
    return { text: writeConflictMarkers(mineLines, theirsLines, label, eol), conflicts: 1 };
  const tagged = [
    ...mineHunks.map((hunk) => ({ hunk, side: 'mine' as const })),
    ...theirsHunks.map((hunk) => ({ hunk, side: 'theirs' as const })),
  ].sort((x, y) => x.hunk.start - y.hunk.start || x.hunk.end - y.hunk.end);
  const out: string[] = [];
  let conflicts = 0;
  let at = 0;
  for (let index = 0; index < tagged.length;) {
    // One group = hunks that overlap or touch, from either side.
    const start = tagged[index].hunk.start;
    let end = tagged[index].hunk.end;
    const group = [tagged[index++]];
    while (index < tagged.length && tagged[index].hunk.start <= end) {
      end = Math.max(end, tagged[index].hunk.end);
      group.push(tagged[index++]);
    }
    out.push(...baseLines.slice(at, start));
    at = end;
    const mineSide = group.filter((entry) => entry.side === 'mine').map((entry) => entry.hunk);
    const theirsSide = group.filter((entry) => entry.side === 'theirs').map((entry) => entry.hunk);
    const mineRegion = applied(baseLines, mineSide, start, end);
    const theirsRegion = applied(baseLines, theirsSide, start, end);
    if (!theirsSide.length) out.push(...mineRegion);
    else if (!mineSide.length) out.push(...theirsRegion);
    else if (
      mineRegion.length === theirsRegion.length &&
      mineRegion.every((line, position) => line === theirsRegion[position])
    )
      out.push(...mineRegion);
    else {
      conflicts++;
      out.push(
        '<<<<<<< mine',
        ...mineRegion,
        '=======',
        ...theirsRegion,
        `>>>>>>> theirs${label ? ` ${label}` : ''}`,
      );
    }
  }
  out.push(...baseLines.slice(at));
  return { text: out.join(eol), conflicts };
}

/** Which lines of `other` (0-based) are new or changed compared with `base`. */
export function changedLines(base: string, other: string): Set<number> {
  const otherLines = splitLines(other);
  const hunks = diffLines(splitLines(base), otherLines);
  const changed = new Set<number>();
  if (!hunks) return new Set(otherLines.keys());
  for (const hunk of hunks) for (let k = 0; k < hunk.lines.length; k++) changed.add(hunk.at + k);
  return changed;
}
