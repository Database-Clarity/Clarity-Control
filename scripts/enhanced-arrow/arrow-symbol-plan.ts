// Read-only plan for the gated U+1F81A -> <arrow/> data rewrite.
// Reuse the editor's quick-fix policy; never change metadata or write data here.
import { isDeepStrictEqual } from 'node:util';
import {
  canReplaceGlyph,
  glyphWarnings,
  tooltipSchema,
  validateTooltip,
} from '../../packages/core/src/index.js';
import { blobContent, globalsFrom, sha256 } from '../mult-write/rewrite.js';
import type { Plan } from './plan.js';

export function rewriteTypedArrow(text: string) {
  const rewritten: number[] = [];
  const refused: number[] = [];
  let next = text;
  // Apply in source order, checking the evolving text just as repeated quick fixes do.
  let offset = 0;
  for (const warning of glyphWarnings(text).filter((row) => row.codePoint === 'U+1F81A')) {
    const from = warning.from + offset;
    const to = warning.to + offset;
    if (!canReplaceGlyph(next, { ...warning, from, to })) {
      refused.push(warning.from);
      continue;
    }
    if (warning.replacement !== '<arrow/>') throw new Error('Arrow quick-fix policy changed');
    next = next.slice(0, from) + warning.replacement + next.slice(to);
    offset += warning.replacement.length - (warning.to - warning.from);
    rewritten.push(warning.from);
  }
  return { text: next, rewritten, refused };
}

export function planTypedArrows(files: Record<string, string>) {
  const plan: Plan = { changes: [] };
  const globalTooltip = (hash: number) => {
    const bytes = files[`tooltips/${hash}.json`];
    return bytes === undefined ? undefined : tooltipSchema.parse(JSON.parse(bytes));
  };
  const globals = globalsFrom(globalTooltip(2), globalTooltip(3));
  const issues = (bytes: string) =>
    validateTooltip(tooltipSchema.parse(JSON.parse(bytes)), () => globals, null).map(
      (issue) => `${issue.lang}|${issue.severity}|${issue.message}`,
    );
  const minus = (a: string[], b: string[]) => {
    const remaining = [...b];
    return a.filter((issue) => {
      const at = remaining.indexOf(issue);
      if (at < 0) return true;
      remaining.splice(at, 1);
      return false;
    });
  };
  const refused: { path: string; lang: string; at: number; text: string }[] = [];
  for (const path of Object.keys(files).sort()) {
    if (!/^tooltips\/(0|[1-9]\d*)\.json$/.test(path)) throw new Error(`Bad path: ${path}`);
    const before = files[path]!;
    const stored = JSON.parse(before);
    const parsed = tooltipSchema.parse(stored);
    if (parsed.hash !== Number(path.slice(9, -5))) throw new Error(`${path}: hash mismatch`);
    const next = structuredClone(stored);
    const texts: Plan['changes'][number]['texts'] = [];
    for (const [lang, entry] of Object.entries(parsed.text)) {
      const result = rewriteTypedArrow(entry.text);
      refused.push(...result.refused.map((at) => ({ path, lang, at, text: entry.text })));
      if (!result.rewritten.length) continue;
      next.text[lang].text = result.text;
      const lines = entry.text.split('\n');
      texts.push({
        lang,
        lines: result.text.split('\n').flatMap((line, at) => (line === lines[at] ? [] : [at + 1])),
        arrows: result.rewritten.length,
        hand: [],
      });
    }
    if (!texts.length) continue;
    if (blobContent(stored) !== before) throw new Error(`${path}: non-canonical bytes`);
    const after = blobContent(next);
    tooltipSchema.parse(JSON.parse(after));
    const expected = structuredClone(next);
    for (const lang of Object.keys(stored.text)) expected.text[lang].text = stored.text[lang].text;
    if (!isDeepStrictEqual(expected, stored)) throw new Error(`${path}: metadata changed`);
    const oldLines = before.split('\n');
    const newLines = after.split('\n');
    if (oldLines.length !== newLines.length) throw new Error(`${path}: JSON line count changed`);
    const jsonLines = newLines.flatMap((line, at) => (line === oldLines[at] ? [] : [at + 1]));
    if (
      jsonLines.length !== texts.length ||
      jsonLines.some((line) => !newLines[line - 1]!.startsWith('      "text": '))
    )
      throw new Error(`${path}: changed non-text JSON lines`);
    plan.changes.push({
      path,
      hash: parsed.hash,
      texts,
      before,
      after,
      beforeSha256: sha256(before),
      afterSha256: sha256(after),
      jsonLines,
      issuesRemoved: minus(issues(before), issues(after)),
      issuesAdded: minus(issues(after), issues(before)),
    });
  }
  return { plan, refused };
}
