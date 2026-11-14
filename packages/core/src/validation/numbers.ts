import type { Lang } from '../languages.js';
import { numberBlockOpen, numberMathRanges, numberTargetRanges } from '../markup/numberSlots.js';
import { numberTokens, numberValues, readNumberMap, type NumberValues } from '../numbers/map.js';
import type { Tooltip } from '../schemas.js';
import type { ValidationIssue } from './index.js';

/** No comment exception: consumers lower and validate every token before stripping comments. */
export function numberTokenIssues(
  text: string,
  lang: Lang,
  hash?: number,
  values?: NumberValues,
): ValidationIssue[] {
  if (!text.includes('#{=')) return [];
  const issues: ValidationIssue[] = [];
  const maths = numberMathRanges(text);
  let offset = 0;
  for (const line of text.split('\n')) {
    const targets = numberTargetRanges(line);
    for (const token of numberTokens(line)) {
      const from = offset + token.from,
        to = offset + token.to;
      let message: string | undefined;
      if (lang === 'en') message = 'Number tokens belong in translations.';
      else if (hash !== undefined && hash >= 1 && hash <= 3)
        message = 'Number tokens do not belong in global documents.';
      else if (token.id === undefined) message = 'Malformed number token; use #{=<id>}.';
      else if (
        /^\s*import\b/.test(line) ||
        numberBlockOpen.test(line.trim()) ||
        (/^\s*var\b/.test(line) && token.from < line.indexOf(' = ') + 3) ||
        /^\s*<\s.*>\s*$/.test(line) ||
        targets.some((range) => token.from >= range.from && token.from < range.to) ||
        maths.some((range) => from >= range.from && from < range.to)
      )
        message = 'Number tokens cannot go here.';
      else if (values && !values.has(token.id)) message = `Unknown number #{=${token.id}}.`;
      if (message) issues.push({ severity: 'error', message, from, to });
    }
    offset += line.length + 1;
  }
  return issues;
}

/** Shared fail-closed boundary for Worker saves and export; retired reference policy belongs to N2. */
export function validateNumberTooltip(tooltip: Tooltip): (ValidationIssue & { lang: Lang })[] {
  if (
    Object.values(tooltip.text).every(
      (entry) => entry?.numbers === undefined && !entry?.text.includes('#{='),
    )
  )
    return [];
  const issues: (ValidationIssue & { lang: Lang })[] = [];
  const english = tooltip.text.en;
  let values: NumberValues | undefined;
  try {
    if (english) {
      readNumberMap(english);
      values = numberValues(english);
    } else values = new Map();
  } catch (error) {
    issues.push({
      lang: 'en',
      severity: 'error',
      from: 0,
      to: english?.text.length ?? 0,
      message: String(error),
    });
  }
  for (const [lang, entry] of Object.entries(tooltip.text))
    issues.push(
      ...numberTokenIssues(entry.text, lang as Lang, tooltip.hash, values).map((issue) => ({
        ...issue,
        lang: lang as Lang,
      })),
    );
  return issues;
}
