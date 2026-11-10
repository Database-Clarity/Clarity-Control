import { resolveAlias, type Aliases } from '../aliases.js';
import type { Lang } from '../languages.js';
import { globalTitlesHash, globalVariablesHash } from '../markup/clashes.js';
import { markupImports } from '../markup/prepare.js';
import { extractBlocks, extractVariables } from '../markup/syntax.js';
import type { Tooltip } from '../schemas.js';

export interface BatchChange {
  hash: number;
  base: Tooltip | null;
  next: Tooltip;
}

/** The text of a document (a tooltip, by hash) in one language, before and after the save. */
export interface BatchDocuments {
  before(lang: Lang, hash: number): string | undefined;
  after(lang: Lang, hash: number): string | undefined;
}

/** The resolver follows imports for five passes. */
const maxPasses = 5;

const textOf = (tooltip: Tooltip | null, lang: Lang) => tooltip?.text[lang]?.text ?? '';

/** Names defined in one text but not the other, or defined differently. */
function changedNames(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (name) =>
      !Object.hasOwn(before, name) || !Object.hasOwn(after, name) || before[name] !== after[name],
  );
}

/**
 * Rule A for errors in text that this save does not edit. Such an error blocks only if something
 * the text can be affected by changes in the same save; otherwise it was there before and only
 * warns. Returns, for a language and an unedited text, what it uses that this save changes (a
 * phrase for the message), or undefined when nothing it can depend on changes. The text can be
 * affected by:
 *  - a document it imports, directly or through other imports (every import line is followed for
 *    the resolver's five passes, in the documents as they were before and as they will be, by
 *    target id whether or not the target resolves, aliases resolved), when that document's text
 *    changes in this save, including a document that is new;
 *  - a global variable or title (documents 2 and 3) that the save adds, removes, or changes and
 *    whose name appears anywhere in the text or the documents it imports. A mention is enough, so
 *    references, local definitions that would clash with it, and formulas are all covered.
 * Over-blocking is accepted: a text that mentions the name of a changed global in passing, or that
 * imports a document the save edits harmlessly, blocks if it already has an error.
 */
export function batchReach(
  changes: readonly BatchChange[],
  documents: BatchDocuments,
  aliases: Aliases,
  nameOf: (hash: number) => string,
): (lang: Lang, text: string) => string | undefined {
  return (lang, text) => {
    const changed = new Map<number, string>();
    const names: { name: string; label: string }[] = [];
    for (const change of changes) {
      const before = textOf(change.base, lang);
      const after = textOf(change.next, lang);
      if (before === after) continue;
      changed.set(change.hash, `"${nameOf(change.hash)}" (${change.hash})`);
      if (change.hash === globalVariablesHash) {
        for (const name of changedNames(extractVariables(before), extractVariables(after))) {
          names.push({ name, label: `the global variable "${name}"` });
        }
      }
      if (change.hash === globalTitlesHash) {
        for (const name of changedNames(
          extractBlocks(before, 'title'),
          extractBlocks(after, 'title'),
        )) {
          names.push({ name, label: `the global title "${name}"` });
        }
      }
    }
    if (!changed.size) return undefined;
    const sources = [text];
    const visited = new Set<number>();
    let frontier = [text];
    for (let pass = 0; pass < maxPasses && frontier.length; pass++) {
      const next: string[] = [];
      for (const source of frontier) {
        for (const line of markupImports(source)) {
          const from = line.match(/(?<=from) (\d+|global)/)?.[0].trim();
          if (!from) continue;
          const target = resolveAlias(from === 'global' ? 1 : Number(from), aliases);
          const label = changed.get(target);
          if (label) return label;
          if (visited.has(target)) continue;
          visited.add(target);
          for (const document of [documents.before(lang, target), documents.after(lang, target)]) {
            if (document !== undefined) {
              next.push(document);
              sources.push(document);
            }
          }
        }
      }
      frontier = next;
    }
    for (const { name, label } of names) {
      if (sources.some((source) => source.includes(name))) return label;
    }
    return undefined;
  };
}
