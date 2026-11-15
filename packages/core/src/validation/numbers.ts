import type { Lang } from '../languages.js';
import { variableReferences } from '../markup/braces.js';
import { extractVariables } from '../markup/syntax.js';
import { markupCommentContext } from '../markup/prepare.js';
import { numberBlockOpen, numberMathRanges, numberTargetRanges } from '../markup/numberSlots.js';
import { numberTokens, numberValues, readNumberMap, type NumberValues } from '../numbers/map.js';
import type { NumberMap, Tooltip } from '../schemas.js';
import type { ValidationIssue } from './index.js';

export const gluedNumberMessage =
  'Make the whole number one variable or number token; do not glue digits to a reference.';
export const unbracedNumberMessage =
  'Use braces for this variable name. If the digits are part of a number, make the whole number one variable or number token.';

/** One structural rule for editor diagnostics, Worker writes, and carry defence. */
export function gluedNumberIssues(text: string): ValidationIssue[] {
  if (!text.includes('#') && !text.includes('${')) return [];
  const { text: prose, offsets } = markupCommentContext(text);
  const locals = extractVariables(prose);
  const variables = variableReferences(prose);
  const plainDigits = new Set(
    variables
      .filter((ref) => !ref.braced && /\d/.test(ref.name) && !Object.hasOwn(locals, ref.name))
      .map((ref) => ref.from),
  );
  // URL fragments and paths are identifiers, not authored numbers.
  const urls = [...prose.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi)].map((match) => ({
    from: match.index,
    to: match.index + match[0].length,
  }));
  const numeric = [...numberMathRanges(prose), ...numberTokens(prose)];
  const touches = (left: number, right: number) =>
    left === right || (left + 1 === right && /[.,]/.test(prose[left]));
  const joinedNumbers = new Set(
    numeric
      .filter(({ from, to }) =>
        numeric.some((other) => touches(other.to, from) || touches(to, other.from)),
      )
      .map(({ from }) => from),
  );
  const references = [...variables, ...numeric];
  return references
    .filter(({ from, to }) => !urls.some((url) => from >= url.from && to <= url.to))
    .filter(
      ({ from, to }) =>
        plainDigits.has(from) ||
        joinedNumbers.has(from) ||
        /\p{Nd}[.,]?$/u.test(prose.slice(Math.max(0, from - 3), from)) ||
        /^[.,]?\p{Nd}/u.test(prose.slice(to, to + 3)),
    )
    .map<ValidationIssue>(({ from, to }) => ({
      severity: 'error',
      code: 'glued-number',
      message: plainDigits.has(from) ? unbracedNumberMessage : gluedNumberMessage,
      from: offsets[from],
      to: offsets[to - 1] + 1,
    }));
}

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

/** Read/export validation; writes also pass their head to refuse new retired references. */
export function validateNumberTooltip(
  tooltip: Tooltip,
  head?: Tooltip | null,
): (ValidationIssue & { lang: Lang })[] {
  if (
    Object.values(tooltip.text).every(
      (entry) => entry?.numbers === undefined && !entry?.text.includes('#{='),
    )
  )
    return [];
  const issues: (ValidationIssue & { lang: Lang })[] = [];
  const english = tooltip.text.en;
  let values: NumberValues | undefined;
  let retired: NumberMap['retired'] = {};
  try {
    if (english) {
      retired = readNumberMap(english).retired;
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
  for (const [lang, entry] of Object.entries(tooltip.text)) {
    issues.push(
      ...numberTokenIssues(entry.text, lang as Lang, tooltip.hash, values).map((issue) => ({
        ...issue,
        lang: lang as Lang,
      })),
    );
    if (head !== undefined && lang !== 'en' && english && entry.text.includes('#{=')) {
      const previous = new Set(
        numberTokens(head?.text[lang as Lang]?.text ?? '').map(({ id }) => id),
      );
      for (const token of numberTokens(entry.text))
        if (token.id !== undefined && Object.hasOwn(retired, token.id) && !previous.has(token.id))
          issues.push({
            lang: lang as Lang,
            severity: 'error',
            from: token.from,
            to: token.to,
            message: `Number #{=${token.id}} was removed from English; reload`,
          });
    }
  }
  return issues;
}
