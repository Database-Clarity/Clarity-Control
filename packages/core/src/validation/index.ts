import { languages, type Lang } from '../languages.js';
import {
  describeGlobalClash,
  findGlobalNameClashes,
  globalTitlesHash,
  globalVariablesHash,
  markupDefinitions,
  parseMarkup,
} from '../markup/index.js';
import { prepareMarkup } from '../markup/prepare.js';
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
    // An error in unchanged text is not this save's doing only if its message occurs no more
    // often than before the save. Counting raw diagnostics (validateText lists a repeated
    // message once) keeps a second, newly broken path from hiding behind an older error.
    const hasError = !edited && issues.some((issue) => issue.severity === 'error');
    const after = hasError ? errorCounts(text, globalsFor(lang), tooltip.hash) : undefined;
    const before = hasError ? errorCounts(text, baseGlobalsFor(lang), tooltip.hash) : undefined;
    const caused = (message: string) => (after!.get(message) ?? 0) > (before!.get(message) ?? 0);
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

/** How often each error message is raised for this text, before validateText merges repeats. */
function errorCounts(text: string, globals: MarkupGlobals, selfHash: number): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (message: string) => counts.set(message, (counts.get(message) ?? 0) + 1);
  for (const diagnostic of parseMarkup(text, globals).diagnostics) {
    if (diagnostic.severity === 'error') add(diagnostic.message);
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
