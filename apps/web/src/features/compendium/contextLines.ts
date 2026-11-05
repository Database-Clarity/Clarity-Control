import type { CompendiumCell, CompendiumRun } from '@clarity/core';

type Line = { cell: CompendiumCell; block: boolean; align?: CompendiumRun['textAlign'] };
const cache = new WeakMap<CompendiumCell, Line[]>();

/** Physical sheet lines are independent layout units; keep links intact. */
export function contextLines(cell: CompendiumCell) {
  const existing = cache.get(cell);
  if (existing) return existing;
  const lines: Line[] = [];
  const aligned = cell.runs.some((run) => run.textAlign);
  let runs: CompendiumRun[] = [];
  const finish = () => {
    lines.push({
      cell: { plain: runs.map((run) => run.text).join(''), runs },
      block: aligned || lines.length > 0,
      align: runs.find((run) => run.text.trim())?.textAlign ?? runs[0]?.textAlign,
    });
    runs = [];
  };
  for (const run of cell.runs) {
    // An unaligned multiline link is one native tab stop in RichCell.
    const parts = run.href && !aligned ? [run.text] : run.text.split('\n');
    for (const [index, text] of parts.entries()) {
      if (index) finish();
      runs.push({ ...run, text });
    }
  }
  finish();
  cache.set(cell, lines);
  return lines;
}
