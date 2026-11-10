import { languages, type Lang } from '../languages.js';
import {
  describeGlobalClash,
  findGlobalNameClashes,
  globalTitlesHash,
  globalVariablesHash,
  markupDefinitions,
  parseMarkup,
} from '../markup/index.js';
import { markupImports, prepareMarkup } from '../markup/prepare.js';
import { extractBlocks } from '../markup/syntax.js';
import type { MarkupGlobals } from '../markup/types.js';
import type { Tooltip } from '../schemas.js';
import { glyphWarnings } from './glyphs.js';
import { retiredWarnings } from './retired.js';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  from: number;
  to: number;
  /** Set for issues the editor draws or fixes in its own way (retired markup). */
  code?: 'retired';
}

export interface TooltipValidationIssue extends ValidationIssue {
  hash: number;
  lang: Lang;
}

export const emptyEnglishMessage = 'English text must not be empty.';

export function validateText(
  text: string,
  lang: Lang,
  globals: MarkupGlobals = { variables: '', titles: '' },
  requireEnglish = true,
  /** The tooltip being validated: the global documents themselves define the globals. */
  selfHash?: number,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  function add(severity: ValidationIssue['severity'], message: string, token?: string) {
    const from = token ? Math.max(0, text.indexOf(token)) : 0;
    const to = Math.min(text.length, from + (token?.length ?? text.length));
    if (!issues.some((issue) => issue.message === message)) {
      issues.push({ severity, message, from, to });
    }
  }
  if (requireEnglish && lang === 'en' && !text.trim()) {
    add('error', emptyEnglishMessage);
  }
  for (const diagnostic of parseMarkup(text, globals).diagnostics) {
    const token = diagnostic.message.match(/Unknown variable (#[a-zA-Z0-9]+)/)?.[1];
    add(diagnostic.severity, diagnostic.message, token);
  }
  if (selfHash !== globalVariablesHash && selfHash !== globalTitlesHash) {
    // The exporter lets a global silently win over a local definition of the same name.
    for (const clash of findGlobalNameClashes(text, globals)) {
      issues.push({
        severity: 'error',
        message: describeGlobalClash(clash),
        from: clash.from,
        to: clash.to,
      });
    }
  }
  const prepared = prepareMarkup(text, globals, []);
  for (const match of prepared.text.matchAll(/<title [^>\n]*?\[([^\]\n]+)\] \/>/g)) {
    if (!(match[1] in prepared.titles)) {
      add('warning', `Unknown title "${match[1]}".`, match[0]);
    }
  }
  return [
    ...issues,
    ...glyphWarnings(text).map(({ from, to, message }) => ({
      severity: 'warning' as const,
      from,
      to,
      message,
    })),
    // Retired markup still renders; the warning asks the author to fix it (blocks saving later).
    ...retiredWarnings(text).map(({ from, to, message }) => ({
      severity: 'warning' as const,
      from,
      to,
      message,
      code: 'retired' as const,
    })),
  ];
}

/**
 * Validates every language of a tooltip. With `base` (the saved tooltip this one replaces, or
 * null for a new tooltip), an error blocks only if the change is responsible for it: the
 * language's text is edited, or the error is raised more often than when this unchanged text is
 * validated against `baseGlobalsFor` (the globals and imports before the whole save, so a sibling change
 * that removes an import, variable, or title this text uses makes the save fail). Any other
 * error in unchanged text is listed as a warning, and an empty unwritten English text is not
 * reported at all (a link-only or metadata-only change leaves it alone). Without `base`, every
 * language counts as edited. `baseGlobalsFor` defaults to `globalsFor` (nothing else changed).
 */
export function validateTooltip(
  tooltip: Tooltip,
  globalsFor: (lang: Lang) => MarkupGlobals,
  base?: Tooltip | null,
  baseGlobalsFor: (lang: Lang) => MarkupGlobals = globalsFor,
): TooltipValidationIssue[] {
  const languages = new Set<Lang>(['en', ...(Object.keys(tooltip.text) as Lang[])]);
  // Reserved global documents are declaration libraries, not English descriptions.
  const requireEnglish = tooltip.hash > 3;
  return [...languages].flatMap((lang) => {
    const text = tooltip.text[lang]?.text ?? '';
    const edited = !base || (base.text[lang]?.text ?? '') !== text;
    const issues = validateText(
      text,
      lang,
      globalsFor(lang),
      requireEnglish && edited,
      tooltip.hash,
    );
    // An error in unchanged text is not this save's doing if it was already raised the same way
    // before the save. Messages alone cannot say which dependency fails (validateText lists a
    // repeated message once, and one repaired import can hide another that breaks), so an
    // unresolved import is attributed to the chain of import lines that reaches it, and any other
    // error to a count of its raw occurrences.
    const hasError = !edited && issues.some((issue) => issue.severity === 'error');
    const now = hasError ? failures(text, globalsFor(lang), tooltip.hash) : undefined;
    const then = hasError ? failures(text, baseGlobalsFor(lang), tooltip.hash) : undefined;
    const caused = (message: string) => {
      for (const [key, count] of now!) {
        if (key.startsWith(message + pathMark) && count > (then!.get(key) ?? 0)) return true;
      }
      return (
        sum(now!, message) > sum(then!, message) ||
        // A message the failures could not attribute (none seen now): stay safe, block.
        sum(now!, message) === 0
      );
    };
    return issues.map((issue) => ({
      ...issue,
      severity:
        edited || issue.severity === 'warning' || caused(issue.message)
          ? issue.severity
          : ('warning' as const),
      hash: tooltip.hash,
      lang,
    }));
  });
}

const pathMark = ' @ ';
const sum = (counts: Map<string, number>, message: string) => {
  let total = 0;
  for (const [key, count] of counts) if (key.startsWith(message + pathMark)) total += count;
  return total;
};

/**
 * How often each error is raised for this text, keyed by its message and, for an unresolved
 * import, by the chain of import lines that reaches it (the resolver's five passes). Other errors
 * (parser, global name clashes) have an empty chain. Counting happens before validateText merges
 * repeated messages.
 */
function failures(text: string, globals: MarkupGlobals, selfHash: number): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (message: string, chain = '') => {
    const key = message + pathMark + chain;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const walk = (source: string, chain: string[]) => {
    if (chain.length >= 5) return;
    for (const line of markupImports(source)) {
      if (line.includes('import self')) continue;
      const name = line.match(/(?<=import) .+ (?=from)/)?.[0].trim() ?? '';
      const from = line.match(/(?<=from) (\d+|global)/)?.[0].trim() ?? '';
      const document =
        globals.imports?.[from] ?? (from === 'global' ? globals.imports?.['1'] : undefined);
      const imported =
        name === 'main' || name === 'secondary'
          ? document
          : extractBlocks(document ?? '', 'export')[name];
      const here = [...chain, line.trim()];
      if (imported === undefined)
        add(`Unresolved import "${name}" from ${from}.`, here.join(' > '));
      else walk(imported, here);
    }
  };
  walk(text, []);
  const unresolved = /^Unresolved import /;
  for (const diagnostic of parseMarkup(text, globals).diagnostics) {
    if (diagnostic.severity === 'error' && !unresolved.test(diagnostic.message)) {
      add(diagnostic.message);
    }
  }
  if (selfHash !== globalVariablesHash && selfHash !== globalTitlesHash) {
    for (const clash of findGlobalNameClashes(text, globals)) add(describeGlobalClash(clash));
  }
  return counts;
}

const maxListedTooltips = 8;

/**
 * Creating or renaming a global is only allowed if no tooltip defines the same name locally in
 * that language. Only names this change adds are checked, so a global that already clashes stays
 * editable. A clashing tooltip is blocked from saving only when its own text is edited or this
 * change causes the clash (see validateTooltip); an untouched clashing tooltip only warns.
 */
export function validateGlobalAdditions(
  change: { base: Tooltip | null; next: Tooltip },
  tooltips: Readonly<Record<string, Tooltip>>,
): TooltipValidationIssue[] {
  const hash = change.next.hash;
  if (hash !== globalVariablesHash && hash !== globalTitlesHash) return [];
  const kind = hash === globalVariablesHash ? 'variable' : 'title';
  const issues: TooltipValidationIssue[] = [];
  for (const lang of languages) {
    const text = change.next.text[lang]?.text;
    if (!text) continue;
    const before = new Set(
      markupDefinitions(change.base?.text[lang]?.text ?? '')
        .filter((definition) => definition.kind === kind)
        .map((definition) => definition.name),
    );
    const added = new Map(
      markupDefinitions(text)
        .filter((definition) => definition.kind === kind && !before.has(definition.name))
        .map((definition) => [definition.name, definition]),
    );
    if (!added.size) continue;
    const users = new Map<string, number[]>();
    for (const tooltip of Object.values(tooltips)) {
      if (tooltip.hash === globalVariablesHash || tooltip.hash === globalTitlesHash) continue;
      const other = tooltip.text[lang]?.text;
      if (!other) continue;
      for (const definition of markupDefinitions(other)) {
        if (definition.kind !== kind || !added.has(definition.name)) continue;
        const list = users.get(definition.name) ?? [];
        if (!list.includes(tooltip.hash)) list.push(tooltip.hash);
        users.set(definition.name, list);
      }
    }
    for (const [name, hashes] of users) {
      const listed = hashes.slice(0, maxListedTooltips).join(', ');
      const more =
        hashes.length > maxListedTooltips ? ` and ${hashes.length - maxListedTooltips} more` : '';
      const plural = hashes.length === 1 ? '' : 's';
      const target = added.get(name)!;
      issues.push({
        severity: 'error',
        message: `${kind === 'variable' ? `#${name}` : `Title "${name}"`} is already defined locally in tooltip${plural} ${listed}${more} — rename ${plural ? 'them' : 'it'} before adding this global.`,
        from: target.from,
        to: target.to,
        hash,
        lang,
      });
    }
  }
  return issues;
}
