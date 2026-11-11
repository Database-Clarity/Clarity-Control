import { parseMarkup } from '../markup/parse.js';
import type { MarkupGlobals, MarkupSpan } from '../markup/types.js';
import type { ReportAnchor } from './schemas.js';

/** Consumer-visible text, including expanded imports, without icons or title popovers. */
export function displayText(
  text: string,
  globals: MarkupGlobals = { variables: '', titles: '' },
): string {
  const spans = (parts: MarkupSpan[] = []) => parts.map((p) => p.text ?? '').join('');
  return parseMarkup(text, globals)
    .lines.flatMap((line) =>
      line.table
        ? line.table.map((row) =>
            (row.rowContent ?? []).map((cell) => spans(cell.cellContent)).join('\t'),
          )
        : [spans(line.linesContent)],
    )
    .join('\n');
}

export async function displayRevision(display: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(display));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

export function resolveReportAnchor(
  display: string,
  rev: string,
  anchor: ReportAnchor,
): { status: 'exact' | 'moved'; start: number; end: number } | { status: 'stale' } {
  if (rev === anchor.rev && display.slice(anchor.start, anchor.end) === anchor.exact)
    return { status: 'exact', start: anchor.start, end: anchor.end };
  const hits: number[] = [];
  for (let at = display.indexOf(anchor.exact); at >= 0; at = display.indexOf(anchor.exact, at + 1))
    hits.push(at);
  const context = hits.filter(
    (at) =>
      display.slice(Math.max(0, at - anchor.prefix.length), at) === anchor.prefix &&
      display.slice(at + anchor.exact.length, at + anchor.exact.length + anchor.suffix.length) ===
        anchor.suffix,
  );
  const selected = context.length === 1 ? context : hits;
  return selected.length === 1
    ? { status: 'moved', start: selected[0], end: selected[0] + anchor.exact.length }
    : { status: 'stale' };
}
