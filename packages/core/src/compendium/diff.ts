import { diffArrays } from 'diff';
import { normaliseRuns, sameCell, type CompendiumCell, type CompendiumRun } from './types.js';

export interface CompendiumDiffPart {
  kind: 'equal' | 'added' | 'removed' | 'style';
  before?: CompendiumCell;
  after?: CompendiumCell;
}
interface Word {
  text: string;
  cell: CompendiumCell;
}
function words(cell: CompendiumCell): Word[] {
  const result: Word[] = [];
  let runIndex = 0;
  let runOffset = 0;
  for (const [text] of cell.plain.matchAll(/\s+|[^\s]+/gu)) {
    let remaining = text.length;
    const runs: CompendiumRun[] = [];
    while (remaining > 0) {
      const run = cell.runs[runIndex];
      if (!run) throw new Error('Compendium plain text does not match runs');
      const length = Math.min(remaining, run.text.length - runOffset);
      if (length) runs.push({ ...run, text: run.text.slice(runOffset, runOffset + length) });
      remaining -= length;
      runOffset += length;
      if (runOffset === run.text.length) {
        runIndex++;
        runOffset = 0;
      }
    }
    result.push({ text, cell: normaliseRuns(runs) });
  }
  return result;
}

export function diffCompendium(
  before: CompendiumCell,
  after: CompendiumCell,
): CompendiumDiffPart[] {
  const left = words(before);
  const right = words(after);
  const result: CompendiumDiffPart[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  for (const change of diffArrays(left, right, { comparator: (a, b) => a.text === b.text })) {
    for (let i = 0; i < change.count; i++) {
      if (change.added) {
        result.push({ kind: 'added', after: right[rightIndex++].cell });
      } else if (change.removed) {
        result.push({ kind: 'removed', before: left[leftIndex++].cell });
      } else {
        const before = left[leftIndex++].cell;
        const after = right[rightIndex++].cell;
        result.push({ kind: sameCell(before, after) ? 'equal' : 'style', before, after });
      }
    }
  }
  return result;
}
