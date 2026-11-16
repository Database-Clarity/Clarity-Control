import { numberTokens, type Lang, type NumberMap, type ValidationIssue } from '@clarity/core';
import {
  isStructureLine,
  numberSource,
  scopedLines,
  sourceDeclarations,
  type StructureLine,
} from './model';

export interface MissingNumberVariable {
  id: number;
  name: string;
  from: number;
  to: number;
}
export function missingNumberVariables(
  text: string,
  sourceText: string | undefined,
  numbers: NumberMap | undefined,
  lang: Lang,
): MissingNumberVariable[] {
  if (lang === 'en' || sourceText === undefined || !text.includes('#{=')) return [];
  const source = numberSource(sourceText, numbers, lang);
  const lines: StructureLine[] = [];
  let at = 0;
  for (const line of text.split('\n')) {
    if (isStructureLine(line)) lines.push({ from: at, to: at + line.length, text: line });
    at += line.length + 1;
  }
  const scoped = scopedLines(lines),
    declarations = sourceDeclarations(source);
  return numberTokens(text).flatMap((token) => {
    const slot = token.id === undefined ? undefined : source.byId.get(token.id);
    if (!slot || !slot.variables.length) return [];
    return declarations
      .filter(
        (declaration) =>
          slot.variables.includes(declaration.name) &&
          !scoped.some(
            (line) =>
              line.scope === declaration.scope &&
              line.text.startsWith(`var ${declaration.name} = `),
          ),
      )
      .map((declaration) => ({
        id: slot.id,
        name: declaration.name,
        from: token.from,
        to: token.to,
      }));
  });
}
export function numberVariableIssues(
  text: string,
  sourceText: string | undefined,
  numbers: NumberMap | undefined,
  lang: Lang,
): ValidationIssue[] {
  return missingNumberVariables(text, sourceText, numbers, lang).map(({ name, from, to }) => ({
    severity: 'warning',
    message: `This formula needs the English variable ${name}. Open Numbers to add it.`,
    from,
    to,
  }));
}
