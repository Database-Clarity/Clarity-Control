// ENHANCED-ARROW write plan: the exact file bytes the data write stores (owner 2026-11-14 "Rewrite
// now"). Pure planning: no I/O here, so the write CLI and the tests share every check.
//
// Each tooltip file whose text has a rewritable `#e` (rewrite.ts) or one of the reviewed hand
// rows gets exactly one change per language: `text.<lang>.text`. Nothing else: the change is
// markup-only (core isMarkupOnly), so updatedAt and updatedBy stay as stored (a new English
// updatedAt could flip translations over the fallback age and would mark the text as changed).
// Bytes come from the Worker's serializer (`blobContent`) with the stored key order kept, so each
// file's diff is exactly its `"text": ` JSON lines.
import { isDeepStrictEqual } from 'node:util';
import { blobContent, globalsFrom, sha256 } from '../mult-write/rewrite.js';
import {
  enhancedArrowMarkup,
  lowerDelimitedMarkup,
  tooltipSchema,
  validateTooltip,
  type MarkupGlobals,
  type Tooltip,
} from '../../packages/core/src/index.js';
import { rewriteLegacyArrow } from './rewrite.js';

/**
 * An `#e` followed by a digit inside a var line: the author meant the arrow and then the number
 * (`#e2 Stacks` = arrow, "2 Stacks"), but a plain reference takes the longest name, so the editor
 * warns that it merges. Decided by hand (ARROW-REWRITE): each becomes `<enhanced/>` + the number,
 * which renders the same in every exported file. The line must match exactly once.
 */
export interface HandRow {
  hash: number;
  lang: 'en';
  before: string;
  after: string;
}

export const handRows: readonly HandRow[] = [
  {
    hash: 1955165503,
    lang: 'en',
    before: 'var d = #e2 Stacks',
    after: 'var d = <enhanced/>2 Stacks',
  },
  {
    hash: 2610012052,
    lang: 'en',
    before: 'var refresh = refresh the buff duration to #e8 seconds.',
    after: 'var refresh = refresh the buff duration to <enhanced/>8 seconds.',
  },
  {
    hash: 2679249093,
    lang: 'en',
    before: 'var d = #e10 of the 12',
    after: 'var d = <enhanced/>10 of the 12',
  },
  {
    hash: 3619207468,
    lang: 'en',
    before: 'var tempGrowth = #e7.5?%',
    after: 'var tempGrowth = <enhanced/>7.5?%',
  },
  { hash: 4132187021, lang: 'en', before: 'var t = #e2', after: 'var t = <enhanced/>2' },
];

export interface TextChange {
  lang: string;
  /** 1-based lines of the decoded text that differ. */
  lines: number[];
  /** `#e` uses rewritten by the rule (rewrite.ts). */
  arrows: number;
  /** Hand rows applied (their `before` lines). */
  hand: string[];
}

export interface FileChange {
  path: string;
  hash: number;
  texts: TextChange[];
  before: string;
  after: string;
  beforeSha256: string;
  afterSha256: string;
  /** 1-based physical JSON lines that differ (each a `"text": ` line). */
  jsonLines: number[];
  /** Save-validator issues that only exist before or only after (`lang|severity|message`). */
  issuesRemoved: string[];
  issuesAdded: string[];
}

export interface Plan {
  changes: FileChange[];
}

const filePattern = /^tooltips\/([1-9]\d*|0)\.json$/;

/** Hand row shape checks: one line each, exactly one `#e<digit>` made `<enhanced/><digit>`. */
export function checkHandRows(rows: readonly HandRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.lang !== 'en') throw new Error(`Hand row ${row.hash}: English only`);
    if (/[\r\n]/.test(row.before) || /[\r\n]/.test(row.after))
      throw new Error(`Hand row ${row.hash}: one line`);
    const uses = [...row.before.matchAll(/#e(?=\d)/g)];
    if (uses.length !== 1) throw new Error(`Hand row ${row.hash}: needs exactly one #e<digit>`);
    const at = uses[0]!.index;
    if (row.after !== `${row.before.slice(0, at)}${enhancedArrowMarkup}${row.before.slice(at + 2)}`)
      throw new Error(`Hand row ${row.hash}: after is not the arrow symbol + the same text`);
    const key = `${row.hash}|${row.before}`;
    if (seen.has(key)) throw new Error(`Hand row ${row.hash}: duplicate`);
    seen.add(key);
  }
}

const issueKeys = (tooltip: Tooltip, globals: MarkupGlobals) =>
  validateTooltip(tooltip, () => globals, null).map(
    (issue) => `${issue.lang}|${issue.severity}|${issue.message}`,
  );

/** Multiset difference a - b. */
function minus(a: readonly string[], b: readonly string[]): string[] {
  const left = [...b];
  return a.filter((value) => {
    const index = left.indexOf(value);
    if (index < 0) return true;
    left.splice(index, 1);
    return false;
  });
}

/**
 * Plans one file; undefined when nothing changes. Throws on anything unsafe: non-canonical bytes,
 * a schema round trip that changes data, a hand row that does not match exactly once, or any
 * change outside `text.<lang>.text`.
 */
export function planFile(
  path: string,
  bytes: string,
  hand: readonly HandRow[],
  globals: MarkupGlobals,
): FileChange | undefined {
  const hash = Number(filePattern.exec(path)?.[1]);
  if (!Number.isInteger(hash)) throw new Error(`${path}: not a tooltip file`);
  if (hand.some((row) => row.hash !== hash)) throw new Error(`${path}: foreign hand row`);
  const stored = JSON.parse(bytes) as Record<string, unknown>;
  const before = tooltipSchema.parse(stored);
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(before)), stored))
    throw new Error(`${path}: schema would change stored data`);
  if (before.hash !== hash) throw new Error(`${path}: hash mismatch`);

  const next = structuredClone(stored);
  const nextText = next.text as Record<string, Record<string, unknown>>;
  const texts: TextChange[] = [];
  /** Per language: the rule's text and the line indexes the hand rows replaced. */
  const ruled = new Map<string, { text: string; handAt: Map<number, HandRow> }>();
  for (const [lang, entry] of Object.entries(before.text)) {
    if (!entry) continue;
    const rule = rewriteLegacyArrow(entry.text);
    const lines = rule.text.split('\n');
    const applied: string[] = [];
    const handAt = new Map<number, HandRow>();
    for (const row of hand.filter((row) => row.lang === lang)) {
      const at = lines.indexOf(row.before);
      if (at < 0 || lines.lastIndexOf(row.before) !== at)
        throw new Error(`${path}: hand row "${row.before}" must match exactly one line`);
      lines[at] = row.after;
      applied.push(row.before);
      handAt.set(at, row);
    }
    ruled.set(lang, { text: rule.text, handAt });
    const text = lines.join('\n');
    if (text === entry.text) continue;
    const oldLines = entry.text.split('\n');
    if (oldLines.length !== lines.length) throw new Error(`${path}: line count changed`);
    nextText[lang]!.text = text;
    texts.push({
      lang,
      lines: oldLines.flatMap((line, index) => (line === lines[index] ? [] : [index + 1])),
      arrows: rule.rewritten.length,
      hand: applied,
    });
  }
  if (hand.some((row) => !texts.some((change) => change.hand.includes(row.before))))
    throw new Error(`${path}: hand row not applied`);
  if (!texts.length) return undefined;
  // Only changed files are rewritten, so only they must already be in the serializer's form.
  if (blobContent(stored) !== bytes) throw new Error(`${path}: stored bytes are not canonical`);
  const after = blobContent(next);

  // Post-conditions, all on the produced bytes.
  const reparsed = JSON.parse(after) as Record<string, unknown>;
  const parsedAfter = tooltipSchema.parse(reparsed);
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(parsedAfter)), reparsed))
    throw new Error(`${path}: schema would change written data`);
  const strip = (value: Record<string, unknown>) => {
    const copy = structuredClone(value);
    for (const entry of Object.values(copy.text as Record<string, Record<string, unknown>>))
      delete entry.text;
    return copy;
  };
  if (!isDeepStrictEqual(strip(reparsed), strip(stored))) throw new Error(`${path}: other fields`);
  for (const change of texts) {
    const old = before.text[change.lang as keyof Tooltip['text']]!.text;
    const now = parsedAfter.text[change.lang as keyof Tooltip['text']]!.text.split('\n');
    const { text, handAt } = ruled.get(change.lang)!;
    // The rule's text lowers to the stored text (exports read lowered text), and the written text
    // differs from the rule's text only on the hand rows' lines, each exactly before -> after.
    if (lowerDelimitedMarkup(text) !== old) throw new Error(`${path}: not markup-only`);
    const ruleLines = text.split('\n');
    if (ruleLines.length !== now.length) throw new Error(`${path}: line count changed`);
    for (const [index, line] of now.entries()) {
      const row = handAt.get(index);
      if (row ? ruleLines[index] !== row.before || line !== row.after : line !== ruleLines[index])
        throw new Error(`${path}: line ${index + 1} differs from the plan rules`);
    }
  }
  const jsonBefore = bytes.split('\n');
  const jsonAfter = after.split('\n');
  if (jsonBefore.length !== jsonAfter.length) throw new Error(`${path}: JSON line count changed`);
  const jsonLines = jsonBefore.flatMap((line, index) =>
    line === jsonAfter[index] ? [] : [index + 1],
  );
  for (const line of jsonLines)
    if (!jsonAfter[line - 1]!.startsWith('      "text": '))
      throw new Error(`${path}: JSON line ${line} is not a text line`);
  if (jsonLines.length !== texts.length) throw new Error(`${path}: unexpected JSON lines`);
  const issuesBefore = issueKeys(before, globals);
  const issuesAfter = issueKeys(parsedAfter, globals);
  return {
    path,
    hash,
    texts,
    before: bytes,
    after,
    beforeSha256: sha256(bytes),
    afterSha256: sha256(after),
    jsonLines,
    issuesRemoved: minus(issuesBefore, issuesAfter),
    issuesAdded: minus(issuesAfter, issuesBefore),
  };
}

/** Plans every tooltip file; `paths` are `tooltips/<hash>.json`, `read` returns stored bytes. */
export function planWrite(
  paths: readonly string[],
  read: (path: string) => string | undefined,
  hand: readonly HandRow[] = handRows,
): Plan {
  checkHandRows(hand);
  const load = (path: string) => {
    const bytes = read(path);
    return bytes === undefined ? undefined : tooltipSchema.parse(JSON.parse(bytes));
  };
  const globals = globalsFrom(load('tooltips/2.json'), load('tooltips/3.json'));
  const sorted = [...paths].sort();
  for (const row of hand)
    if (!sorted.includes(`tooltips/${row.hash}.json`))
      throw new Error(`Hand row ${row.hash}: file missing`);
  const changes: FileChange[] = [];
  for (const path of sorted) {
    const bytes = read(path);
    if (bytes === undefined) throw new Error(`${path}: missing`);
    const hash = Number(filePattern.exec(path)?.[1]);
    const change = planFile(
      path,
      bytes,
      hand.filter((row) => row.hash === hash),
      globals,
    );
    if (change) changes.push(change);
  }
  return { changes };
}

/** The plan file's exact bytes (hashed for approval). */
export const planBytes = (plan: Plan) => `${JSON.stringify(plan, null, 1)}\n`;

export function summary(plan: Plan) {
  const texts = plan.changes.flatMap((change) => change.texts);
  return {
    files: plan.changes.length,
    texts: texts.length,
    arrows: texts.reduce((sum, text) => sum + text.arrows, 0),
    handRows: texts.reduce((sum, text) => sum + text.hand.length, 0),
    languages: [...new Set(texts.map((text) => text.lang))].sort(),
    jsonLines: plan.changes.reduce((sum, change) => sum + change.jsonLines.length, 0),
    issuesRemoved: plan.changes.reduce((sum, change) => sum + change.issuesRemoved.length, 0),
    issuesAdded: plan.changes.reduce((sum, change) => sum + change.issuesAdded.length, 0),
  };
}
