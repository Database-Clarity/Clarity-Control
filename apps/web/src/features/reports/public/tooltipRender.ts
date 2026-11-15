import { languages, type Lang } from '../../../../../../packages/core/src/languageCodes';
import {
  displayRevision,
  displayText,
} from '../../../../../../packages/core/src/reports/displayText';
import { markupImports } from '../../../../../../packages/core/src/markup/prepare';
import { parseMarkup } from '../../../../../../packages/core/src/markup/parse';
import type { MarkupGlobals, MarkupSpan } from '../../../../../../packages/core/src/markup/types';
import {
  loadReportCatalog,
  loadReportTooltip,
  type ReportCatalog,
  type ReportCatalogItem,
  type ReportTooltipFile,
} from '../../../services/reports';

/** The catalog is fetched once per page load; the picker, the form, and My reports share it. */
let catalogPromise: Promise<ReportCatalog> | undefined;
export function reportCatalog(fresh = false): Promise<ReportCatalog> {
  if (!catalogPromise || fresh) {
    const current = loadReportCatalog().catch((error: unknown) => {
      if (catalogPromise === current) catalogPromise = undefined;
      throw error;
    });
    catalogPromise = current;
  }
  return catalogPromise;
}

/** Direct links resolve their identity from the live catalog before first paint. */
export async function reportItemCatalog(viewed: number): Promise<ReportCatalog> {
  if (!Number.isInteger(viewed) || viewed <= 3 || viewed > 0xffffffff)
    return { v: 1, sourceCommit: '0'.repeat(40), items: {} };
  return reportCatalog(true);
}

/** The global documents every tooltip may read: exports (1), variables (2), titles (3). */
const globalHashes = [1, 2, 3];

/** One piece of a rendered line: text with its display offsets, or an icon (no offsets). */
export type RenderPart =
  | { kind: 'text'; start: number; end: number; text: string; classNames?: (string | undefined)[] }
  | { kind: 'icon'; classNames?: (string | undefined)[] };
/** One display line (a paragraph, or one table row whose cells are joined by a tab). */
export interface RenderLine {
  index: number;
  start: number;
  end: number;
  classNames?: (string | undefined)[];
  /** Table rows: the cells, each with its parts; plain lines: one cell. */
  cells: RenderPart[][];
  table: boolean;
}

export interface ReportRender {
  viewed: number;
  item: ReportCatalogItem;
  /** The language whose text is shown (English when the chosen one has none). */
  lang: Lang;
  /** The language the reporter chose. */
  seenLang: Lang;
  fallback: boolean;
  display: string;
  rev: string;
  lines: RenderLine[];
  dataCommit: string;
}

const tooltipFiles = new Map<string, Promise<ReportTooltipFile | undefined>>();
function tooltipFile(commit: string, hash: number): Promise<ReportTooltipFile | undefined> {
  const key = `${commit}:${hash}`;
  let file = tooltipFiles.get(key);
  if (!file) {
    file = loadReportTooltip(commit, hash).catch((error: unknown) => {
      tooltipFiles.delete(key);
      throw error;
    });
    tooltipFiles.set(key, file);
  }
  return file;
}

const textOf = (file: ReportTooltipFile | undefined, lang: Lang) => file?.text[lang]?.text ?? '';

/** The hash an `import … from <hash>` names, resolved to the file that holds it. */
function importSource(from: string, catalog: ReportCatalog): number {
  const hash = from === 'global' ? 1 : Number(from);
  return catalog.items[String(hash)]?.owner ?? hash;
}

/**
 * Loads the text a consumer sees for `viewed` in `lang` (English when that language has no text),
 * with the globals and every import it reads (up to the converter's five passes), all at the
 * catalog's data commit, and renders it with the core display-text function.
 */
export async function loadReportRender(
  viewed: number,
  requestedLang: string,
  catalog: ReportCatalog,
): Promise<ReportRender | undefined> {
  const item = catalog.items[String(viewed)];
  if (!item || viewed <= 3) return undefined;
  const seenLang: Lang = (languages as readonly string[]).includes(requestedLang)
    ? (requestedLang as Lang)
    : 'en';
  const commit = catalog.sourceCommit;
  const override = /^override:(\d+)$/.exec(item.variant);
  const source = override ? Number(override[1]) : item.owner;
  const [file, ...globals] = await Promise.all([
    tooltipFile(commit, source),
    ...globalHashes.map((hash) => tooltipFile(commit, hash)),
  ]);
  const fallback = !textOf(file, seenLang).trim();
  const lang: Lang = fallback ? 'en' : seenLang;
  const text = textOf(file, lang);
  const imports: Record<string, string> = {};
  globalHashes.forEach((hash, index) => (imports[hash] = textOf(globals[index], lang)));
  // Imports may import again: follow them breadth-first, as the converter's passes do.
  let pending = importedHashes(text, catalog);
  for (let pass = 0; pass < 5 && pending.length; pass++) {
    const files = await Promise.all(pending.map((hash) => tooltipFile(commit, hash)));
    const next: number[] = [];
    pending.forEach((hash, index) => {
      const body = textOf(files[index], lang);
      imports[hash] = body;
      next.push(...importedHashes(body, catalog));
    });
    pending = [...new Set(next)].filter((hash) => !(hash in imports));
  }
  // `import … from <alias>` reads the alias's owner file.
  const keyed = new Proxy(imports, {
    get: (target, key) =>
      typeof key === 'string'
        ? (target[key] ?? target[String(importSource(key, catalog))])
        : undefined,
  });
  const markupGlobals: MarkupGlobals = {
    variables: imports[2] ?? '',
    titles: imports[3] ?? '',
    imports: keyed,
    type: item.type,
  };
  const display = displayText(text, markupGlobals);
  const lines = renderLines(text, markupGlobals);
  return {
    viewed,
    item,
    lang,
    seenLang,
    fallback,
    display,
    rev: await displayRevision(display),
    lines: lines.text === display ? lines.lines : plainLines(display),
    dataCommit: commit,
  };
}

function importedHashes(text: string, catalog: ReportCatalog): number[] {
  return markupImports(text)
    .map((line) => /from (\d+|global)/.exec(line)?.[1])
    .filter((from): from is string => from !== undefined)
    .map((from) => importSource(from, catalog));
}

/**
 * The parsed lines with display offsets. The offsets follow the core display text exactly (lines
 * joined by "\n", table cells by "\t", title popovers excluded); the caller checks the joined text
 * against `displayText` and falls back to plain lines if they ever disagree.
 */
export function renderLines(
  text: string,
  globals: MarkupGlobals,
): { text: string; lines: RenderLine[] } {
  const parsed = parseMarkup(text, globals);
  let offset = 0;
  let joined = '';
  const lines: RenderLine[] = [];
  const parts = (spans: MarkupSpan[] = []): RenderPart[] =>
    spans.map((span) => {
      const value = span.text ?? '';
      if (!value) return { kind: 'icon', classNames: span.classNames };
      const part: RenderPart = {
        kind: 'text',
        start: offset,
        end: offset + value.length,
        text: value,
        classNames: span.classNames,
      };
      offset += value.length;
      joined += value;
      return part;
    });
  const push = (cells: MarkupSpan[][], table: boolean, classNames?: (string | undefined)[]) => {
    if (lines.length) {
      offset += 1;
      joined += '\n';
    }
    const start = offset;
    const built = cells.map((cell, index) => {
      if (index > 0) {
        offset += 1;
        joined += '\t';
      }
      return parts(cell);
    });
    lines.push({ index: lines.length, start, end: offset, classNames, cells: built, table });
  };
  for (const line of parsed.lines) {
    if (line.table)
      for (const row of line.table)
        push(
          (row.rowContent ?? []).map((cell) => cell.cellContent),
          true,
          row.classNames,
        );
    else push([line.linesContent ?? []], false, line.classNames);
  }
  return { text: joined, lines };
}

/** Unstyled lines straight from the display text (only if the structured render disagreed). */
function plainLines(display: string): RenderLine[] {
  let start = 0;
  return display.split('\n').map((value, index) => {
    const line: RenderLine = {
      index,
      start,
      end: start + value.length,
      cells: [value ? [{ kind: 'text', start, end: start + value.length, text: value }] : []],
      table: false,
    };
    start += value.length + 1;
    return line;
  });
}

/** The display line holding offset `at`. */
export function lineAt(lines: RenderLine[], at: number): RenderLine | undefined {
  return lines.find((line) => at >= line.start && at <= line.end);
}
