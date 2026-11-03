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

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  from: number;
  to: number;
}

export interface TooltipValidationIssue extends ValidationIssue {
  hash: number;
  lang: Lang;
}

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
    add('error', 'English text must not be empty.');
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
  ];
}

export function validateTooltip(
  tooltip: Tooltip,
  globalsFor: (lang: Lang) => MarkupGlobals,
): TooltipValidationIssue[] {
  const languages = new Set<Lang>(['en', ...(Object.keys(tooltip.text) as Lang[])]);
  // Reserved global documents are declaration libraries, not English descriptions.
  const requireEnglish = tooltip.hash > 3;
  return [...languages].flatMap((lang) =>
    validateText(
      tooltip.text[lang]?.text ?? '',
      lang,
      globalsFor(lang),
      requireEnglish,
      tooltip.hash,
    ).map((issue) => ({ ...issue, hash: tooltip.hash, lang })),
  );
}

const maxListedTooltips = 8;

/**
 * Creating or renaming a global is only allowed if no tooltip defines the same name locally in
 * that language. Only names this change adds are checked, so an already-clashing global stays
 * editable; the clashing tooltips are blocked from saving instead.
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
