import {
  glyphWarnings,
  maskConflicts,
  validateText,
  type GlyphWarning,
  type Lang,
  type MarkupGlobals,
  type ValidationIssue,
} from '@clarity/core';

export interface DiagnosticInput {
  text: string;
  lang: Lang;
  globals: MarkupGlobals;
  requireEnglish: boolean;
  selfHash?: number;
}
export interface DiagnosticResult {
  issues: ValidationIssue[];
  glyphs: GlyphWarning[];
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
  };
}
