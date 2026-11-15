import {
  findRetiredMarkup,
  glyphWarnings,
  maskConflicts,
  validateText,
  type GlyphWarning,
  type Lang,
  type MarkupGlobals,
  type NumberMap,
  type RetiredOccurrence,
  type ValidationIssue,
} from '@clarity/core';
import { translationParity, type ParityGap } from './parity';
import { numberVariableIssues } from './numbers/diagnostics';
import type { GlossaryEntry } from '../../../../../packages/core/src/glossary/schema';
import { glossaryProse, glossaryTermUsed } from '../../../../../packages/core/src/glossary/prose';

// The transport sends matched entries once per check id, then only the id on each debounced key.
const glossaryChecks = new Map<string, readonly GlossaryEntry[]>();

export interface DiagnosticInput {
  text: string;
  lang: Lang;
  globals: MarkupGlobals;
  requireEnglish: boolean;
  selfHash?: number;
  /** The saved English while translating: parity is checked against it. Undefined for English. */
  sourceText?: string;
  sourceNumbers?: NumberMap;
  termCheck?: { id: string; entries?: readonly GlossaryEntry[] };
}
export interface DiagnosticResult {
  issues: ValidationIssue[];
  glyphs: GlyphWarning[];
  /** Retired markup with its fixes (the status bar's list); `issues` carries the same as warnings. */
  retired: RetiredOccurrence[];
  /** What the English has that the translation lacks (TR1); empty for English. */
  parity: ParityGap[];
  missingTerms?: string[];
}
export function computeDiagnostics(input: DiagnosticInput): DiagnosticResult {
  const missingTerms = computeMissingTerms(input);
  return {
    ...(input.termCheck ? { missingTerms } : {}),
    issues: [
      ...validateText(
        maskConflicts(input.text),
        input.lang,
        input.globals,
        input.requireEnglish,
        input.selfHash,
      ),
      ...numberVariableIssues(input.text, input.sourceText, input.sourceNumbers, input.lang),
    ],
    glyphs: glyphWarnings(input.text),
    retired: findRetiredMarkup(maskConflicts(input.text)),
    parity:
      input.sourceText === undefined
        ? []
        : translationParity(input.sourceText, maskConflicts(input.text)),
  };
}

export function computeMissingTerms(input: DiagnosticInput): string[] {
  const check = input.termCheck;
  if (check?.entries && !glossaryChecks.has(check.id)) {
    if (glossaryChecks.size >= 32) glossaryChecks.delete(glossaryChecks.keys().next().value!);
    glossaryChecks.set(check.id, check.entries);
  }
  const prose = check && input.text.trim() ? glossaryProse(maskConflicts(input.text)) : '';
  const missingTerms =
    !prose.trim() || !check
      ? []
      : (glossaryChecks.get(check.id) ?? [])
          .filter((entry) => !glossaryTermUsed(prose, entry))
          .map((entry) => entry.en);
  return missingTerms;
}
