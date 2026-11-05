import {
  diffCompendium,
  sameCell,
  styleKey,
  type CompendiumCell,
  type CompendiumDiffPart,
} from '@clarity/core';

export type PreparedDiffPart = CompendiumDiffPart & { description?: string };
export type PreparedDiffLines = PreparedDiffPart[][];

export function projectCompendiumDiff(
  before: CompendiumCell,
  after: CompendiumCell,
): PreparedDiffLines {
  return diffLines(
    sameCell(before, after) ? [{ kind: 'equal', before, after }] : diffCompendium(before, after),
  );
}

function changes(before: CompendiumCell, after: CompendiumCell): string[] {
  const values = (
    cell: CompendiumCell,
    key: 'color' | 'bold' | 'italic' | 'underline' | 'strike' | 'sizePt' | 'href' | 'textAlign',
  ) =>
    [
      ...new Set(
        cell.runs.map((run) =>
          String(
            run[key] ??
              (key === 'sizePt'
                ? 'default'
                : key === 'color'
                  ? 'default'
                  : key === 'textAlign'
                    ? 'inherited'
                    : false),
          ),
        ),
      ),
    ].join(', ');
  return (
    ['color', 'bold', 'italic', 'underline', 'strike', 'sizePt', 'href', 'textAlign'] as const
  ).flatMap((key) => {
    const old = values(before, key);
    const current = values(after, key);
    return old === current
      ? []
      : [
          `${key === 'color' ? 'colour' : key === 'textAlign' ? 'alignment' : key}: ${old} \u2192 ${current}`,
        ];
  });
}
const descriptions = new Map<string, string>();
function styleDescription(before: CompendiumCell, after: CompendiumCell) {
  const signature = (cell: CompendiumCell) =>
    cell.runs.map((run) => [
      run.color,
      run.bold,
      run.italic,
      run.underline,
      run.strike,
      run.sizePt,
      run.href,
      run.textAlign,
    ]);
  const key = JSON.stringify([signature(before), signature(after)]);
  const cached = descriptions.get(key);
  if (cached !== undefined) return cached;
  const description = changes(before, after).join('; ') || 'Styling changed within this word';
  if (descriptions.size >= 256) descriptions.delete(descriptions.keys().next().value!);
  descriptions.set(key, description);
  return description;
}

// Split fragments at line breaks before laying them out; each highlighted word
// remains inline within its source line, including for mixed-alignment selections.
function diffLines(parts: CompendiumDiffPart[]): PreparedDiffPart[][] {
  const lines: PreparedDiffPart[][] = [[]];
  let previousKey: string | undefined;
  for (const part of parts) {
    const source = part.after ?? part.before!;
    let offset = 0;
    source.plain.split(/(?<=\n)/).forEach((text) => {
      const slice = (cell: CompendiumCell): CompendiumCell => {
        let position = 0;
        return {
          plain: text,
          runs: cell.runs.flatMap((run) => {
            const start = Math.max(0, offset - position);
            const end = Math.min(run.text.length, offset + text.length - position);
            position += run.text.length;
            return end > start ? [{ ...run, text: run.text.slice(start, end) }] : [];
          }),
        };
      };
      const fragment: PreparedDiffPart = {
        kind: part.kind,
        ...(part.before ? { before: slice(part.before) } : {}),
        ...(part.after ? { after: slice(part.after) } : {}),
      };
      // Coalesce plain, identically styled neighbours instead of rendering one
      // RichCell and highlight wrapper per word. Links and style-change controls
      // keep their individual targets, and alignment never crosses a line break.
      const cells = [fragment.before, fragment.after].filter((cell) => cell !== undefined);
      const key =
        part.kind !== 'style' && cells.every((cell) => cell.runs.length === 1 && !cell.runs[0].href)
          ? JSON.stringify([part.kind, ...cells.map((cell) => styleKey(cell.runs[0]))])
          : undefined;
      const line = lines.at(-1)!;
      const previous = line.at(-1);
      if (key !== undefined && key === previousKey && previous) {
        for (const side of ['before', 'after'] as const) {
          if (previous[side] && fragment[side]) {
            previous[side].plain += fragment[side].plain;
            previous[side].runs[0].text += fragment[side].plain;
          }
        }
      } else {
        if (fragment.kind === 'style')
          fragment.description = styleDescription(fragment.before!, fragment.after!);
        line.push(fragment);
      }
      previousKey = key;
      offset += text.length;
      if (text.endsWith('\n')) {
        lines.push([]);
        previousKey = undefined;
      }
    });
  }
  return lines;
}
