import { expect, it } from 'vitest';
import { diffCompendium, type CompendiumCell, type CompendiumRun } from '@clarity/core';
import {
  HOIST_MIN_LINES,
  INLINE_MAX_SHARE,
  PAIR_MIN_SIMILARITY,
  changedShare,
  lineAlign,
  projectCompendiumDiff,
  similarity,
  splitLines,
  type DiffLine,
} from './compendiumDiffProjection';
import reviewed from './owner-reviewed.json';
import fixture from './fixtures/compendium-links.json';

const cell = (...runs: CompendiumRun[]): CompendiumCell => ({
  plain: runs.map((run) => run.text).join(''),
  runs,
});
const text = (plain: string, style: Omit<CompendiumRun, 'text'> = {}) =>
  cell({ text: plain, ...style });
/** The approved snapshot and the current sheet cell of a real changed entry. */
function real(hash: 4019266109 | 1888882410) {
  const approval = reviewed.reapproved[hash];
  const after = fixture.source.tabs
    .find((tab) => tab.gid === approval.gid)!
    .rows.find((row) => row.rowIndex === approval.sourceRow)!.cell as CompendiumCell;
  return { before: approval.approvedSnapshot as CompendiumCell, after };
}
const lineOf = (cell: CompendiumCell, start: string) =>
  splitLines(cell).find((line) => line.plain.startsWith(start))!;
const share = (before: CompendiumCell, after: CompendiumCell) =>
  changedShare(diffCompendium(before, after));
const shownText = (line: DiffLine) =>
  line.kind === 'equal'
    ? line.cell.plain
    : line.kind === 'inline'
      ? line.after.plain
      : line.after.map((item) => item.plain).join('\n');
type Block = Extract<DiffLine, { kind: 'block' }>;
const lastBlock = (lines: DiffLine[]) =>
  lines.filter((line): line is Block => line.kind === 'block').at(-1)!;
const styled = (lines: DiffLine[]) =>
  lines.filter((line) => line.kind !== 'block' && line.style).length;

it('names the thresholds', () => {
  expect([INLINE_MAX_SHARE, PAIR_MIN_SIMILARITY, HOIST_MIN_LINES]).toEqual([0.4, 0.3, 3]);
});

it('keeps the real small edits inline and turns the real rewrite into a block', () => {
  const demolition = real(4019266109);
  const pugilism = real(1888882410);
  // "Scoring damage instances ..." -> "Each scored damage instance ...": the closest real edit.
  const scoring = share(lineOf(pugilism.before, 'Scoring'), lineOf(pugilism.after, 'Each scored'));
  expect(scoring).toBeGreaterThan(0.3);
  expect(scoring).toBeLessThanOrEqual(INLINE_MAX_SHARE);
  // "... duration seconds, up to" -> "... duration, up to".
  expect(
    share(lineOf(pugilism.before, 'Additional'), lineOf(pugilism.after, 'Additional')),
  ).toBeLessThan(0.2);
  // "Grenade Ability Gains:" pairs with its replacement heading, but reads as a rewrite.
  const heading = [
    lineOf(demolition.before, 'Grenade Ability Gains:'),
    lineOf(demolition.after, 'Approximate Grenade Ability Gains'),
  ] as const;
  expect(similarity(heading[0].plain, heading[1].plain)).toBeGreaterThan(PAIR_MIN_SIMILARITY);
  expect(share(...heading)).toBeGreaterThan(0.6);

  const lines = projectCompendiumDiff(pugilism.before, pugilism.after).lines;
  const inline = lines.filter((line) => line.kind === 'inline');
  expect(inline.map((line) => line.after.plain.slice(0, 11))).toEqual([
    'Each scored',
    'Additional ',
  ]);
  expect(inline[1].parts.filter((part) => part.kind !== 'equal')).toMatchObject([
    { kind: 'removed', cell: { plain: 'duration' } },
    { kind: 'added', cell: { plain: 'duration,' } },
    { kind: 'removed', cell: { plain: 'seconds, ' } },
  ]);
  const rewrite = lastBlock(lines);
  expect(rewrite.before).toHaveLength(8);
  expect(rewrite.after).toHaveLength(9);
  // Every line of the current cell is shown once, in order.
  expect(lines.map(shownText).join('\n')).toBe(pugilism.after.plain);
});

it('draws removed lines with the alignment of the sheet when the snapshot stores none', () => {
  const { before, after } = real(4019266109);
  expect(before.runs.some((run) => run.textAlign)).toBe(false);
  const rewrite = lastBlock(projectCompendiumDiff(before, after).lines);
  expect(rewrite.before.map((line) => [line.plain, lineAlign(line)])).toEqual([
    ['Grenade Ability Gains:', 'center'],
    ['PENDING AT SOME POINT :)', 'center'],
    ['PENDING AT SOME POINT :)', 'center'],
    ['PENDING AT SOME POINT :)', 'center'],
  ]);
  // The snapshot itself is never changed.
  expect(before.runs.some((run) => run.textAlign)).toBe(false);
});

it('inherits alignment for removed-only lines from a neighbour and keeps a stored alignment', () => {
  const right = text('Kept\n', { textAlign: 'right' });
  const after = cell(...right.runs, { text: 'Last', textAlign: 'center' });
  const removedOnly = projectCompendiumDiff(text('Kept\nGone entirely\nLast'), after).lines;
  expect(removedOnly.map((line) => line.kind)).toEqual(['equal', 'block', 'equal']);
  const block = removedOnly[1] as Block;
  expect(block.after).toEqual([]);
  expect(lineAlign(block.before[0])).toBe('right');

  const stored = projectCompendiumDiff(
    cell({ text: 'Kept\n', textAlign: 'right' }, { text: 'Old words here', textAlign: 'left' }),
    cell({ text: 'Kept\n', textAlign: 'right' }, { text: 'Fresh text now', textAlign: 'center' }),
  ).lines[1] as Block;
  expect(lineAlign(stored.before[0])).toBe('left');
});

it('keeps a synthetic small edit inline and mixes inline and block in one cell', () => {
  const before = text('Grants 10% increased damage.\nBuff can be activated while stowed.');
  const small = projectCompendiumDiff(
    before,
    text('Grants 12% increased damage.\nBuff can be activated while stowed.'),
  ).lines;
  expect(small.map((line) => line.kind)).toEqual(['inline', 'equal']);
  expect(share(splitLines(before)[0], text('Grants 12% increased damage.'))).toBeLessThanOrEqual(
    0.15,
  );
  const mixed = projectCompendiumDiff(
    before,
    text('Grants 12% increased damage.\nLasts only while the weapon is held.\nNew last line.'),
  ).lines;
  expect(mixed).toMatchObject([
    { kind: 'inline' },
    {
      kind: 'block',
      before: [{ plain: 'Buff can be activated while stowed.' }],
      after: [{ plain: 'Lasts only while the weapon is held.' }, { plain: 'New last line.' }],
    },
  ]);
});

it('shows added-only lines as a one-sided block', () => {
  // A side with no text has no lines: a first revision is all added, with no removed blank line.
  expect(projectCompendiumDiff({ plain: '', runs: [] }, text('One\nTwo')).lines).toMatchObject([
    { kind: 'block', before: [], after: [{ plain: 'One' }, { plain: 'Two' }] },
  ]);
  const lines = projectCompendiumDiff(text('One\nThree'), text('One\nTwo\nThree')).lines;
  expect(lines).toMatchObject([
    { kind: 'equal' },
    { kind: 'block', before: [], after: [{ plain: 'Two' }] },
    { kind: 'equal' },
  ]);
});

it('marks a style-only line once and hoists a change shared by three lines', () => {
  const plain = ['First line', 'Second line', 'Third line', 'Fourth line'];
  const sized = (sizes: (number | undefined)[]) =>
    cell(
      ...plain.map((line, index) => ({
        text: line + (index < plain.length - 1 ? '\n' : ''),
        sizePt: sizes[index],
      })),
    );
  const two = projectCompendiumDiff(sized([9, 9, 9, 9]), sized([7, 7, 9, 9]));
  expect(two.cellStyle).toBeUndefined();
  expect(two.lines.map((line) => line.kind)).toEqual(['equal', 'equal', 'equal', 'equal']);
  expect(styled(two.lines)).toBe(2);
  expect(two.lines[0]).toMatchObject({ style: { description: 'size: 9 → 7' } });

  const three = projectCompendiumDiff(
    sized([9, 9, 9, 9]),
    cell(...sized([7, 7, 6, 9]).runs.slice(0, 3), { text: plain[3], sizePt: 9, bold: true }),
  );
  expect(three.cellStyle).toBe('size: 9 → 7, 9 → 6 (3 lines)');
  // The line with another signature keeps its own marker.
  expect(styled(three.lines)).toBe(1);
  expect(three.lines[3]).toMatchObject({ style: { description: 'bold: off → true' } });
});

it('never marks a difference that is only alignment', () => {
  const before = text('Centred heading\nBody text');
  const after = cell(
    { text: 'Centred heading\n', textAlign: 'center' },
    { text: 'Body text', textAlign: 'right' },
  );
  const diff = projectCompendiumDiff(before, after);
  expect(diff).toEqual({ lines: splitLines(after).map((line) => ({ kind: 'equal', cell: line })) });
  // With a text change elsewhere, the realigned line still carries no note.
  const edited = projectCompendiumDiff(
    before,
    cell(...after.runs, { text: '\nAdded', textAlign: 'center' }),
  );
  expect(edited.cellStyle).toBeUndefined();
  expect(styled(edited.lines)).toBe(0);
  expect(JSON.stringify(edited)).not.toMatch(/alignment/i);
});
