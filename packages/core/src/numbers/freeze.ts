import type { Lang } from '../languages.js';
import { variableReferences } from '../markup/braces.js';
import { numberBlockOpen, numberProse, numberSlots } from '../markup/numberSlots.js';
import type { NumberMap, Tooltip } from '../schemas.js';

export interface NumberVariable {
  name: string;
  value: string;
  from: number;
  conditional: boolean;
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
    if (match)
      result.push({
        name: match[1],
        value: (visible ?? match)[2].trim(),
        from: offset + line.length - match[2].length,
        // The real preparer reads declarations before stripping comments. A hidden
        // declaration is therefore ambiguous, even though it has no prose value slot.
        conditional:
          !visible || blocks.some((block) => /^(enhanced|catalyst|exotic perk) /.test(block)),
      });
    if (numberBlockOpen.test(line.trim())) blocks.push(line.trim());
    else if (/^\)\s*$/.test(line.trim())) blocks.pop();
    offset += line.length + 1;
  }
  return result;
}

/** Dependencies include transitive locals; missing names are shared/imported, and stay references. */
export function formulaLocals(formula: string, text: string): Set<string> {
  const definitions = numberVariables(text);
  const result = new Set<string>();
  const visit = (source: string) => {
    for (const ref of variableReferences(source)) {
      const locals = definitions.filter((entry) => entry.name === ref.name);
      if (!locals.length || result.has(ref.name)) continue;
      result.add(ref.name);
      for (const local of locals) visit(local.value);
    }
  };
  visit(formula);
  return result;
}

export function freezeFormula(
  formula: string,
  english: string,
  ids: readonly number[],
  translations: Tooltip['text'],
): NumberMap['retired'][string] {
  const variables = numberVariables(english);
  const locals = formulaLocals(formula, english);
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
          if (definitions.length !== 1 || definitions[0].conditional) {
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
    const agrees = [...locals].every((name) => {
      const own = definitions.filter((variable) => variable.name === name);
      if (own.length !== 1 || own[0].conditional) return false;
      const original = variables.find((variable) => variable.name === name)!;
      const slot = slots.findIndex(
        (slot) => slot.from === original.from && slot.value === original.value,
      );
      return (
        own[0].value === values.get(name) || (slot >= 0 && own[0].value === `#{=${ids[slot]}}`)
      );
    });
    if (!agrees) fallback.push(lang as Lang);
  }
  return fallback.length ? { value: frozen, fallback: fallback.sort() } : frozen;
}
