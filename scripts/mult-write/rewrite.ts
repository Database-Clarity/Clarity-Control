// MULT-WRITE: replace exact English lines of stored tooltips (owner 2026-11-11, multiplier
// rewrite). Pure planning: no I/O here, so the CLI and the tests share every check.
//
// A row names a tooltip file, a 1-based line of its decoded English text, the exact current
// line, and its replacement. A row whose line no longer matches exactly is DROPPED and listed,
// never guessed. Each changed file gets what a normal English save writes (the web app's
// metadata enricher, apps/web/src/services/save/enrichers/metadata.ts): new `text.en.text`,
// `text.en.updatedAt`, and `text.en.updatedBy`. Nothing else changes: no Bungie or Compendium
// snapshot (the rewrite reviews neither), no legacy fields, no other language. Bytes come from
// the Worker's serializer (`blobContent`) with the stored key order kept, so the file diff is
// exactly those JSON lines; a Worker save would store the same data in schema key order.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { blobContent } from '../../apps/worker/src/github.js';
import {
  parseMarkup,
  tooltipSchema,
  validateTooltip,
  type MarkupGlobals,
  type Tooltip,
} from '../../packages/core/src/index.js';

export { blobContent };

export interface Row {
  id: string;
  authoredFile: string;
  sourceLine: number;
  before: string;
  after: string;
}

export interface Stamp {
  /** ISO time written to text.en.updatedAt (fixed for the whole run, so dry run = write). */
  at: string;
  /** GitHub login written to text.en.updatedBy, as a save by that user would. */
  by: string;
}

export interface Dropped {
  id: string;
  authoredFile: string;
  sourceLine: number;
  reason: string;
  found: string | null;
}

export interface FileChange {
  path: string;
  hash: number;
  rows: string[];
  lines: number[];
  before: string;
  after: string;
  beforeSha256: string;
  afterSha256: string;
  /** 1-based physical JSON lines that differ (all inside text.en). */
  jsonLines: number[];
  /** Fields whose value changed. */
  fields: string[];
}

export interface Plan {
  changes: FileChange[];
  dropped: Dropped[];
}

export const sha256 = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

const filePattern = /^tooltips\/([1-9]\d*)\.json$/;
const isoPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

/** Shape checks for the approved rows; any problem stops the run (nothing is planned). */
export function checkRows(rows: readonly Row[]): void {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('No rows');
  const ids = new Set<string>();
  const places = new Set<string>();
  for (const row of rows) {
    const keys = Object.keys(row).sort().join(',');
    if (keys !== 'after,authoredFile,before,id,sourceLine') {
      throw new Error(`Row ${row.id}: unexpected fields ${keys}`);
    }
    const match = filePattern.exec(row.authoredFile);
    if (!match) throw new Error(`Row ${row.id}: bad file ${row.authoredFile}`);
    // Tooltips 0-3 hold globals and reserved documents; this rewrite never touches them.
    if (Number(match[1]) <= 3) throw new Error(`Row ${row.id}: reserved tooltip`);
    if (row.id !== `${match[1]}:${row.sourceLine}`) throw new Error(`Row ${row.id}: id mismatch`);
    if (!Number.isInteger(row.sourceLine) || row.sourceLine < 1) {
      throw new Error(`Row ${row.id}: bad line ${row.sourceLine}`);
    }
    for (const side of ['before', 'after'] as const) {
      const value = row[side];
      if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/.test(value)) {
        throw new Error(`Row ${row.id}: ${side} must be one non-empty line`);
      }
    }
    if (row.before === row.after) throw new Error(`Row ${row.id}: no change`);
    if (ids.has(row.id)) throw new Error(`Row ${row.id}: duplicate`);
    ids.add(row.id);
    const place = `${row.authoredFile}:${row.sourceLine}`;
    if (places.has(place)) throw new Error(`Row ${row.id}: duplicate line`);
    places.add(place);
  }
}

export function checkStamp({ at, by }: Stamp): void {
  if (!isoPattern.test(at) || new Date(at).toISOString() !== at) throw new Error(`Bad --at ${at}`);
  if (!/^[A-Za-z0-9-]{1,39}$/.test(by)) throw new Error(`Bad --by ${by}`);
}

/** Globals as the editor passes them to the parser: tooltip 2 (variables) and 3 (titles). */
export function globalsFrom(variables: Tooltip | undefined, titles: Tooltip | undefined) {
  return {
    variables: variables?.text.en?.text ?? '',
    titles: titles?.text.en?.text ?? '',
  } satisfies MarkupGlobals;
}

const issueKeys = (tooltip: Tooltip, globals: MarkupGlobals) =>
  validateTooltip(tooltip, () => globals, null)
    .map((issue) => `${issue.lang}|${issue.severity}|${issue.message}`)
    .sort();

/**
 * Plans one file. Throws on anything that would make the result unsafe (non-canonical bytes,
 * other languages, unexpected English fields); returns the matching rows' change and the drifted
 * rows. A file whose rows all drifted has no change.
 */
export function planFile(
  path: string,
  bytes: string,
  rows: readonly Row[],
  stamp: Stamp,
  globals: MarkupGlobals,
): { change?: FileChange; dropped: Dropped[] } {
  if (rows.some((row) => row.authoredFile !== path)) throw new Error(`${path}: foreign row`);
  const hash = Number(filePattern.exec(path)?.[1]);
  const stored = JSON.parse(bytes) as Record<string, unknown>;
  if (blobContent(stored) !== bytes) throw new Error(`${path}: stored bytes are not canonical`);
  const before = tooltipSchema.parse(stored);
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(before)), stored)) {
    throw new Error(`${path}: schema would change stored data`);
  }
  if (before.hash !== hash) throw new Error(`${path}: hash mismatch`);
  const languages = Object.keys(before.text);
  if (languages.join(',') !== 'en') throw new Error(`${path}: languages ${languages.join(',')}`);
  const storedEn = (stored.text as Record<string, Record<string, unknown>>).en!;
  if (Object.keys(storedEn).join(',') !== 'text,updatedAt,updatedBy') {
    throw new Error(`${path}: unexpected English fields ${Object.keys(storedEn).join(',')}`);
  }
  const lines = before.text.en!.text.split('\n');
  const dropped: Dropped[] = [];
  const applied: Row[] = [];
  for (const row of rows) {
    const found = lines[row.sourceLine - 1];
    if (found !== row.before) {
      dropped.push({
        id: row.id,
        authoredFile: path,
        sourceLine: row.sourceLine,
        reason: found === undefined ? 'line missing' : 'line differs',
        found: found ?? null,
      });
      continue;
    }
    applied.push(row);
  }
  if (!applied.length) return { dropped };
  const nextLines = [...lines];
  for (const row of applied) nextLines[row.sourceLine - 1] = row.after;
  const nextText = nextLines.join('\n');
  // Same object, same key order: only the three English fields are reassigned.
  const next = structuredClone(stored) as typeof stored;
  const nextEn = (next.text as Record<string, Record<string, unknown>>).en!;
  nextEn.text = nextText;
  nextEn.updatedAt = stamp.at;
  nextEn.updatedBy = stamp.by;
  const after = blobContent(next);

  // Post-conditions, all on the produced bytes.
  const reparsed = JSON.parse(after) as Record<string, unknown>;
  const parsedAfter = tooltipSchema.parse(reparsed);
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(parsedAfter)), reparsed)) {
    throw new Error(`${path}: schema would change written data`);
  }
  const strip = (value: Record<string, unknown>) => {
    const copy = structuredClone(value);
    const en = (copy.text as Record<string, Record<string, unknown>>).en!;
    delete en.text;
    delete en.updatedAt;
    delete en.updatedBy;
    return copy;
  };
  if (!isDeepStrictEqual(strip(reparsed), strip(stored))) throw new Error(`${path}: other fields`);
  const afterLines = parsedAfter.text.en!.text.split('\n');
  if (afterLines.length !== lines.length) throw new Error(`${path}: line count changed`);
  const changedLines = lines.flatMap((line, index) =>
    line === afterLines[index] ? [] : [index + 1],
  );
  const wanted = applied.map((row) => row.sourceLine).sort((a, b) => a - b);
  if (!isDeepStrictEqual(changedLines, wanted)) throw new Error(`${path}: unexpected text lines`);
  const jsonBefore = bytes.split('\n');
  const jsonAfter = after.split('\n');
  if (jsonBefore.length !== jsonAfter.length) throw new Error(`${path}: JSON line count changed`);
  const jsonLines = jsonBefore.flatMap((line, index) =>
    line === jsonAfter[index] ? [] : [index + 1],
  );
  const allowed = new Set(
    [`"text": `, `"updatedAt": `, `"updatedBy": `].map((key) => `      ${key}`),
  );
  for (const line of jsonLines) {
    const text = jsonAfter[line - 1]!;
    if (![...allowed].some((prefix) => text.startsWith(prefix))) {
      throw new Error(`${path}: JSON line ${line} outside text.en`);
    }
  }
  // The real parser and the save validator: no new or lost diagnostics.
  const parsedBefore = JSON.stringify(parseMarkup(before.text.en!.text, globals).diagnostics);
  const parsedNext = JSON.stringify(parseMarkup(nextText, globals).diagnostics);
  if (parsedBefore !== parsedNext) throw new Error(`${path}: parser diagnostics changed`);
  if (!isDeepStrictEqual(issueKeys(before, globals), issueKeys(parsedAfter, globals))) {
    throw new Error(`${path}: validation issues changed`);
  }
  const fields = ['text.en.text', 'text.en.updatedAt', 'text.en.updatedBy'].filter(
    (field) => storedEn[field.slice(8)] !== nextEn[field.slice(8)],
  );
  return {
    dropped,
    change: {
      path,
      hash,
      rows: applied.map((row) => row.id),
      lines: wanted,
      before: bytes,
      after,
      beforeSha256: sha256(bytes),
      afterSha256: sha256(after),
      jsonLines,
      fields,
    },
  };
}

/** Plans every file named by `rows`; `read` returns a file's stored bytes (undefined: absent). */
export function planRewrite(
  rows: readonly Row[],
  read: (path: string) => string | undefined,
  stamp: Stamp,
): Plan {
  checkRows(rows);
  checkStamp(stamp);
  const load = (path: string) => {
    const bytes = read(path);
    return bytes === undefined ? undefined : tooltipSchema.parse(JSON.parse(bytes));
  };
  const globals = globalsFrom(load('tooltips/2.json'), load('tooltips/3.json'));
  const byFile = new Map<string, Row[]>();
  for (const row of rows)
    byFile.set(row.authoredFile, [...(byFile.get(row.authoredFile) ?? []), row]);
  const changes: FileChange[] = [];
  const dropped: Dropped[] = [];
  for (const [path, fileRows] of [...byFile].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const bytes = read(path);
    if (bytes === undefined) {
      dropped.push(
        ...fileRows.map((row) => ({
          id: row.id,
          authoredFile: path,
          sourceLine: row.sourceLine,
          reason: 'file missing',
          found: null,
        })),
      );
      continue;
    }
    const result = planFile(path, bytes, fileRows, stamp, globals);
    dropped.push(...result.dropped);
    if (result.change) changes.push(result.change);
  }
  return { changes, dropped };
}

/** The plan file's exact bytes (hashed for approval). */
export const planBytes = (plan: Plan) => `${JSON.stringify(plan, null, 1)}\n`;
