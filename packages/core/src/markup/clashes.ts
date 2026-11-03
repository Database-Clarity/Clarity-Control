import { markupCommentContext } from './prepare.js';
import { extractBlocks, extractVariables } from './syntax.js';
import type { MarkupGlobals } from './types.js';

export type DefinitionKind = 'variable' | 'title';

/** A `var` or `title` definition in authored text; `from`/`to` select the name. */
export interface LocalDefinition {
  kind: DefinitionKind;
  name: string;
  from: number;
  to: number;
}

/** Hashes of the reserved global documents: Variables and Titles. */
export const globalVariablesHash = 2;
export const globalTitlesHash = 3;

/**
 * Every definable name in `text`, found exactly the way the exporter finds it: variables with
 * `extractVariables` (comments are not stripped first) and titles with `extractBlocks` on the
 * comment-free text. Offsets always refer to the original `text`.
 */
export function markupDefinitions(text: string): LocalDefinition[] {
  const found: LocalDefinition[] = [];
  for (const match of text.matchAll(/^var ([a-zA-Z0-9]+) = (.+)$/gm)) {
    const from = match.index + 'var '.length;
    found.push({ kind: 'variable', name: match[1], from, to: from + match[1].length });
  }
  const clean = markupCommentContext(text);
  for (const match of clean.text.matchAll(/^title [A-z0-9 ]+ \([^]*?\n\)$/gm)) {
    const header = match[0].split('\n')[0];
    const name = header.replace(/title|\(.*/gi, '').trim();
    const prefix = header.match(/^title +/)?.[0].length ?? 0;
    const spelled = header.slice(prefix).replace(/ *\(.*$/, '');
    const start = match.index + prefix;
    if (!name || !spelled) continue;
    found.push({
      kind: 'title',
      name,
      from: clean.offsets[start],
      to: clean.offsets[start + spelled.length - 1] + 1,
    });
  }
  return found;
}

/** Local definitions whose name is already a global of the same kind (the global would win). */
export function findGlobalNameClashes(text: string, globals: MarkupGlobals): LocalDefinition[] {
  const variables = extractVariables(globals.variables);
  const titles = extractBlocks(globals.titles, 'title');
  return markupDefinitions(text).filter((definition) =>
    Object.hasOwn(definition.kind === 'variable' ? variables : titles, definition.name),
  );
}

export function describeGlobalClash(clash: LocalDefinition): string {
  return clash.kind === 'variable'
    ? `#${clash.name} is already a global variable (Variables, tooltip ${globalVariablesHash}) — rename it.`
    : `Title "${clash.name}" is already a global title (Titles, tooltip ${globalTitlesHash}) — rename it.`;
}
