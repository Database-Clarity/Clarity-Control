import {
  findRetiredMarkup,
  glyphWarnings,
  maskConflicts,
  validateText,
  type GlyphWarning,
  type Lang,
  type MarkupGlobals,
  type RetiredOccurrence,
  type ValidationIssue,
} from '@clarity/core';
import { translationParity, type ParityGap } from './parity';

export interface DiagnosticInput {
  text: string;
  lang: Lang;
  globals: MarkupGlobals;
  requireEnglish: boolean;
  selfHash?: number;
  /** The saved English while translating: parity is checked against it. Undefined for English. */
  sourceText?: string;
}
export interface DiagnosticResult {
  issues: ValidationIssue[];
  glyphs: GlyphWarning[];
  /** Retired markup with its fixes (the status bar's list); `issues` carries the same as warnings. */
  retired: RetiredOccurrence[];
  /** What the English has that the translation lacks (TR1); empty for English. */
  parity: ParityGap[];
}
export function computeDiagnostics(input: DiagnosticInput): DiagnosticResult {
  return {
    issues: validateText(
      maskConflicts(input.text),
      input.lang,
      input.globals,
      input.requireEnglish,
      input.selfHash,
    ),
    glyphs: glyphWarnings(input.text),
    retired: findRetiredMarkup(maskConflicts(input.text)),
    parity:
      input.sourceText === undefined
        ? []
        : translationParity(input.sourceText, maskConflicts(input.text)),
  };
}
