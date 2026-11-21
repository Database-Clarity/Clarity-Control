// The preview's view of one output entry (format v2, spec section 7): its lines as the app's
// tooltip renderer draws them (the Rendered pane), and the entry printed one tooltip line per row
// (the Output pane), so a row of Output and a line of Rendered read side by side.
import type { MarkupLine, MarkupSpan } from '@clarity/core';
import type { Line } from '@clarity/export';

/** A description as the file holds it: format v2 lines, or one string (the text shape). */
export type Description = Line[] | string;
export type Descriptions = Record<string, Description>;

/** True for format v2 lines (`parts` or `spacer`); an older engine's output is not. */
export const isStructuredLines = (text: unknown): text is Line[] =>
  Array.isArray(text) &&
  text.every((line) => !!line && typeof line === 'object' && ('parts' in line || 'spacer' in line));

/** One format v2 line as the tooltip renderer reads lines: each part's keys as class names. */
export function renderLine(line: Line): MarkupLine {
  if ('spacer' in line) return { classNames: ['spacer'] };
  return {
    ...(line.style ? { classNames: line.style } : {}),
    linesContent: line.parts.map((part): MarkupSpan => {
      const classNames = [
        ...(part.icon ? [part.icon] : []),
        ...(part.style ?? []),
        ...(part.link !== undefined ? ['link'] : []),
        ...(part.note ? ['title'] : []),
        ...(part.element ? ['elementText', part.element] : []),
      ];
      return {
        ...(part.text !== undefined ? { text: part.text } : {}),
        ...(part.link !== undefined ? { link: part.link } : {}),
        ...(part.note ? { title: part.note.map(renderLine) } : {}),
        ...(classNames.length ? { classNames } : {}),
      };
    }),
  };
}

/** One printed row of an entry. `line` names the tooltip line it holds, if it holds one. */
export interface Row {
  text: string;
  indent: number;
  line?: { language: string; index: number };
}

/**
 * The entry as JSON with one tooltip line per row. A text-shape string breaks after each `\n`
 * (display only; Copy JSON gives the JSON itself).
 */
export function outputRows(entry: unknown): Row[] {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry))
    return [{ text: JSON.stringify(entry), indent: 0 }];
  const rows: Row[] = [{ text: '{', indent: 0 }];
  const keys = Object.entries(entry as Record<string, unknown>);
  keys.forEach(([key, value], at) => {
    const comma = at < keys.length - 1 ? ',' : '';
    if (key !== 'descriptions' || !value || typeof value !== 'object') {
      rows.push({ text: `${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`, indent: 1 });
      return;
    }
    rows.push({ text: '"descriptions": {', indent: 1 });
    const languages = Object.entries(value as Record<string, unknown>);
    languages.forEach(([language, text], index) => {
      const end = index < languages.length - 1 ? ',' : '';
      if (typeof text === 'string') {
        const parts = JSON.stringify(text).split(/(?<=\\n)/);
        parts.forEach((part, line) =>
          rows.push({
            text: `${line ? '' : `${JSON.stringify(language)}: `}${part}${line === parts.length - 1 ? end : ''}`,
            indent: line ? 3 : 2,
            line: { language, index: line },
          }),
        );
        return;
      }
      if (!Array.isArray(text)) {
        rows.push({
          text: `${JSON.stringify(language)}: ${JSON.stringify(text)}${end}`,
          indent: 2,
        });
        return;
      }
      rows.push({ text: `${JSON.stringify(language)}: [`, indent: 2 });
      text.forEach((line, lineIndex) =>
        rows.push({
          text: `${JSON.stringify(line)}${lineIndex < text.length - 1 ? ',' : ''}`,
          indent: 3,
          line: { language, index: lineIndex },
        }),
      );
      rows.push({ text: `]${end}`, indent: 2 });
    });
    rows.push({ text: `}${comma}`, indent: 1 });
  });
  rows.push({ text: '}', indent: 0 });
  return rows;
}

/**
 * Each row's identity for "what changed": its language, place in the tree, and text without the
 * comma, plus which occurrence of that row it is, so two equal lines (after a style is dropped)
 * and equal lines in two languages stay apart.
 */
export function rowKeys(rows: readonly Row[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = `${row.line?.language ?? ''}\n${row.indent}\n${row.text.replace(/,$/, '')}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return `${key}\n${occurrence}`;
  });
}

export const rowsText = (rows: readonly Row[]) =>
  rows.map((row) => `${'  '.repeat(row.indent)}${row.text}`).join('\n');

/**
 * What the last config change did to the shown entry: the rows that are new, and how many rows
 * went. `before` holds the row keys (rowKeys) from before the change.
 */
export function lastEdit(rows: readonly Row[], before: ReadonlySet<string>) {
  const keys = rowKeys(rows);
  const changed = new Set(rows.filter((_, index) => !before.has(keys[index]!)));
  const now = new Set(keys);
  let removed = 0;
  for (const key of before) if (!now.has(key)) removed += 1;
  const message = changed.size
    ? `${changed.size} ${changed.size === 1 ? 'line' : 'lines'} changed by your last edit`
    : removed
      ? `${removed} ${removed === 1 ? 'line' : 'lines'} removed by your last edit`
      : 'Your last edit does not change this perk';
  return { changed, message };
}
