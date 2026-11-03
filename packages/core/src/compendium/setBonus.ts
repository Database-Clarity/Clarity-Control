import { normaliseRuns, withBackground, type CompendiumCell } from './types.js';

/** Select one explicitly labelled piece-count block, preserving source styles. */
export function setBonusCell(cell: CompendiumCell, pieces: 2 | 4): CompendiumCell | undefined {
  const headings = [...cell.plain.matchAll(/^(2|4)[ -]Pieces?\b[^\n]*/gim)];
  const matches = headings.filter((match) => Number(match[1]) === pieces);
  if (matches.length !== 1) return;
  const start = matches[0].index!;
  const next = headings.find((match) => match.index! > start)?.index ?? cell.plain.length;
  const end = start + cell.plain.slice(start, next).trimEnd().length;
  let offset = 0;
  return withBackground(
    normaliseRuns(
      cell.runs.flatMap((run) => {
        const from = Math.max(0, start - offset);
        const to = Math.min(run.text.length, end - offset);
        offset += run.text.length;
        return to > from ? [{ ...run, text: run.text.slice(from, to) }] : [];
      }),
    ),
    cell.background,
  );
}
