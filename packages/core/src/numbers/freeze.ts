import type { Lang } from '../languages.js';
import { variableReferences } from '../markup/braces.js';
import { markupImports } from '../markup/prepare.js';
import { numberBlockOpen, numberProse, numberSlots } from '../markup/numberSlots.js';
import type { NumberMap, Tooltip } from '../schemas.js';

export interface NumberVariable {
  name: string;
  value: string;
  from: number;
  ambiguous: boolean;
}
/** Keep duplicates and block placement: extractVariables deliberately discards both. */
export function numberVariables(text: string): NumberVariable[] {
  const result: NumberVariable[] = [];
  let offset = 0;
  const blocks: string[] = [];
  const prose = numberProse(text).split('\n');
  for (const [index, line] of text.replace(/\r/g, ' ').split('\n').entries()) {
    const match = /^var ([a-zA-Z0-9]+) = (.+)$/.exec(line);
    const visible = /^var ([a-zA-Z0-9]+) = (.+)$/.exec(prose[index]);
    if (match) {
      const value = (visible ?? match)[2];
      result.push({
        name: match[1],
        value: value.trim(),
        from: offset + line.length - match[2].length + value.length - value.trimStart().length,
        // The real preparer reads declarations before stripping comments. A hidden
        // declaration is therefore ambiguous, even though it has no prose value slot.
        ambiguous:
          !visible ||
          /\/\*|\/\//.test(match[2]) ||
          blocks.some((block) => /^(enhanced|catalyst|exotic perk) /.test(block)),
      });
    }
    if (numberBlockOpen.test(line.trim())) blocks.push(line.trim());
    else if (/^\)\s*$/.test(line.trim())) blocks.pop();
    offset += line.length + 1;
  }
  return result;
}

/** Include transitive local prefixes too: the legacy preparer can substitute d inside d5. */
export function formulaLocals(formula: string, text: string): Set<string> {
  const definitions = numberVariables(text);
  const result = new Set<string>();
  const visited = new Set<NumberVariable>();
  const visit = (source: string) => {
    for (const ref of variableReferences(source)) {
      for (const local of definitions.filter((entry) => ref.name.startsWith(entry.name))) {
        if (visited.has(local)) continue;
        visited.add(local);
        result.add(local.name);
        visit(local.value);
      }
    }
  };
  visit(formula);
  return result;
}

export function freezeFormula(
  formula: string,
  english: string,
  numbers: NumberMap,
  translations: Tooltip['text'],
): NumberMap['retired'][string] {
  const variables = numberVariables(english);
  const locals = formulaLocals(formula, english);
  const prefixAmbiguity = (source: string) => {
    const names = [
      ...numberVariables(source).map((variable) => variable.name),
      ...variableReferences(source).map((ref) => ref.name),
    ];
    return [...locals].some((name) =>
      names.some((other) => other !== name && (other.startsWith(name) || name.startsWith(other))),
    );
  };
  const retiredSources = Object.values(numbers.retired)
    .flatMap((value) => (value === null ? [] : [typeof value === 'string' ? value : value.value]))
    .join('\n');
  // Imported overrides and legacy prefix substitution make local ownership unproven.
  if (
    locals.size &&
    (markupImports(english).length || prefixAmbiguity(english + '\n' + retiredSources))
  )
    return null;
  const values = new Map<string, string>();
  const visiting = new Set<string>();
  let valid = true;
  const expand = (source: string): string => {
    let result = '',
      at = 0;
    for (const ref of variableReferences(source)) {
      result += source.slice(at, ref.from);
      if (!locals.has(ref.name)) result += source.slice(ref.from, ref.to);
      else {
        if (visiting.has(ref.name)) {
          valid = false;
          return '';
        }
        let value = values.get(ref.name);
        if (value === undefined) {
          const definitions = variables.filter((entry) => entry.name === ref.name);
          if (definitions.length !== 1 || definitions[0].ambiguous) {
            valid = false;
            return '';
          }
          visiting.add(ref.name);
          value = expand(definitions[0].value);
          visiting.delete(ref.name);
          // Nested formula variables do not resolve recursively in the consumer. Never
          // evaluate them here: that would freeze a different result (root, 2026-11-14).
          if (!/^[+-]?\d+(?:\.\d+)?$/.test(value)) {
            valid = false;
            return '';
          }
          values.set(ref.name, value);
        }
        result += value;
      }
      at = ref.to;
    }
    return result + source.slice(at);
  };
  const frozen = expand(formula);
  if (!valid) return null;
  const slots = numberSlots(english);
  const fallback: Lang[] = [];
  for (const [lang, entry] of Object.entries(translations)) {
    if (lang === 'en') continue;
    const definitions = numberVariables(entry.text);
    const agrees =
      !(locals.size && (markupImports(entry.text).length || prefixAmbiguity(entry.text))) &&
      [...locals].every((name) => {
        const own = definitions.filter((variable) => variable.name === name);
        if (own.length !== 1 || own[0].ambiguous) return false;
        const original = variables.find((variable) => variable.name === name)!;
        const slot = slots.findIndex(
          (slot) => slot.from === original.from && slot.value === original.value,
        );
        return (
          own[0].value === values.get(name) ||
          (slot >= 0 && own[0].value === `#{=${numbers.ids[slot]}}`)
        );
      });
    if (!agrees) fallback.push(lang as Lang);
  }
  return fallback.length ? { value: frozen, fallback: fallback.sort() } : frozen;
}
