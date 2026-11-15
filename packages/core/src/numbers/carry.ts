import {
  markupConditions,
  markupImports,
  prepareMarkup,
  removeMarkupComments,
} from '../markup/prepare.js';
import { variableReferencePattern, variableReferences } from '../markup/braces.js';
import type { LangText, Tooltip } from '../schemas.js';
import { formulaLocals, numberVariables } from './freeze.js';
import { alignSlots } from './identity.js';
import { numberTokens, readNumberMap } from './map.js';
import type { Lang } from '../languages.js';
import { gluedNumberIssues } from '../validation/numbers.js';
import { numberMathRanges, numberProse } from '../markup/numberSlots.js';

/** Old slot indices, including formula results affected through local variables. */
export function changedNumberSlots(before: string, after: string): Set<number> {
  const alignment = alignSlots(before, after);
  const changed = new Set(alignment.changed);
  const definitions = numberVariables(before);
  const names = new Set(
    definitions
      .filter((variable) =>
        alignment.before.some(
          (slot, i) =>
            changed.has(i) &&
            slot.from >= variable.from &&
            slot.to <= variable.from + variable.value.length,
        ),
      )
      .map((variable) => variable.name),
  );
  alignment.before.forEach((slot, i) => {
    if (slot.kind === 'M' && [...formulaLocals(slot.value, before)].some((name) => names.has(name)))
      changed.add(i);
  });
  return changed;
}

function numericLiterals(source: string): string[] {
  const normalized = source.normalize('NFKC');
  // Compare unsigned values: a hyphen may be a range, and translated wording may
  // express the sign. Ambiguous decimal/grouping readings may prevent carry.
  const readings = [
    normalized,
    normalized.replace(/(\d),(?=\d)/g, '$1.'),
    normalized.replace(/(?<=\d)[. ]+(?=\d{3}(?!\d))/g, ''),
  ];
  return readings.flatMap((text) =>
    [...text.matchAll(/(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g)].map((match) =>
      String(Number(match[0].replaceAll(',', ''))),
    ),
  );
}
function renderVariants(source: string): string[] {
  // Use the real preparer, including condition blocks, declarations, and nested-math behaviour.
  // Probe each supported variant: a literal copy of any old rendering prevents carry.
  return [undefined, ...markupConditions.map(([, type]) => type)].map(
    (type) => prepareMarkup(source, { variables: '', titles: '', type }, []).text,
  );
}

/** Coverage is positive proof; merely lacking an old literal is insufficient. */
export function canCarryNumbers(before: LangText, after: LangText, translation: LangText): boolean {
  if (translation.sourceUpdatedAt !== before.updatedAt) return false;
  if ([before.text, after.text, translation.text].some((text) => gluedNumberIssues(text).length))
    return false;
  const alignment = alignSlots(before.text, after.text);
  if (alignment.kind === 'text') return false;
  const oldMap = readNumberMap(before),
    newMap = readNumberMap(after);
  if (oldMap.ids.length !== newMap.ids.length || oldMap.ids.some((id, i) => id !== newMap.ids[i]))
    return false;
  const changed = changedNumberSlots(before.text, after.text);
  const prose = numberProse(translation.text);
  const maths = numberMathRanges(prose);
  if (changed.size && maths.length) {
    const definitions = numberVariables(translation.text);
    const names = new Set(definitions.map((local) => local.name));
    if (
      maths.some(({ from, to }) => {
        const source = prose.slice(from, to);
        const locals = formulaLocals(source, translation.text);
        if (locals.size && markupImports(translation.text).length) return true;
        return [
          source,
          ...definitions.filter((local) => locals.has(local.name)).map((local) => local.value),
        ].some((value) => variableReferences(value).some((ref) => !names.has(ref.name)));
      })
    )
      return false;
  }
  const tokens = new Set(numberTokens(translation.text).map((token) => token.id));
  if ([...changed].some((index) => !tokens.has(oldMap.ids[index]))) return false;
  const oldValues = new Set<string>();
  for (const index of changed) {
    const slot = alignment.before[index];
    numericLiterals(slot.value).forEach((value) => oldValues.add(value));
    if (slot.kind === 'M') {
      const definitions = numberVariables(before.text);
      const names = new Set(definitions.map((local) => local.name));
      const locals = formulaLocals(slot.value, before.text);
      if (locals.size && markupImports(before.text).length) return false;
      const sources = [
        slot.value,
        ...definitions.filter((local) => locals.has(local.name)).map((local) => local.value),
      ];
      // Without globals, the preparer may consume an unresolved formula's numeric
      // prefix. Source references must prove that its old result is locally known.
      if (sources.some((source) => variableReferences(source).some((ref) => !names.has(ref.name))))
        return false;
      renderVariants(slot.value + '\n' + before.text)
        .map((text) => text.split('\n')[0])
        .flatMap(numericLiterals)
        .forEach((value) => oldValues.add(value));
    }
  }
  let literalText = removeMarkupComments(translation.text).replace(/#\{=[^}\n]*(?:}|$)/gm, ' ');
  const localNames = new Set(
    markupImports(literalText).length
      ? []
      : numberVariables(literalText).map((local) => local.name),
  );
  literalText = literalText.replace(variableReferencePattern, (reference, braced, legacy) =>
    localNames.has(braced ?? legacy) ? reference : '\uE000',
  );
  const scans = [
    literalText,
    ...renderVariants(literalText),
    // Local-only maths uses the real declaration/comment order too.
    ...(maths.length ? renderVariants(translation.text.replace(/#\{=[^}\n]*(?:}|$)/gm, ' ')) : []),
  ].map((text) => text.normalize('NFKC'));
  // Unknown external values may contribute digits; a visible join cannot prove carry.
  if (scans.some((text) => /\uE000[\d\uE000]|\d\uE000/.test(text))) return false;
  if (scans.flatMap(numericLiterals).some((value) => oldValues.has(value))) return false;
  return true;
}

/** Worker seam: head -> merged, after reconciliation. Never changes translated words/authors. */
export function carryNumberTranslations(
  before: Tooltip,
  merged: Tooltip,
): { tooltip: Tooltip; carried: Lang[] } {
  const old = before.text.en,
    english = merged.text.en;
  if (!old || !english || alignSlots(old.text, english.text).kind !== 'value')
    return { tooltip: merged, carried: [] };
  const text = { ...merged.text };
  const carried: Lang[] = [];
  for (const [lang, translation] of Object.entries(text)) {
    if (lang === 'en' || !canCarryNumbers(old, english, translation)) continue;
    text[lang as Lang] = {
      ...translation,
      sourceUpdatedAt: english.updatedAt,
      updatedAt: english.updatedAt,
    };
    carried.push(lang as Lang);
  }
  return { tooltip: { ...merged, text }, carried: carried.sort() };
}
