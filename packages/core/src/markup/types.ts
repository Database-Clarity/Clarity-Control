export interface MarkupGlobals {
  variables: string;
  titles: string;
  imports?: Readonly<Record<string, string>>;
  type?: string;
}

export interface MarkupSpan {
  text?: string;
  classNames?: (string | undefined)[];
  link?: string;
  title?: MarkupLine[];
}

export interface MarkupCell {
  cellContent: MarkupSpan[];
  colSpan?: number;
  rowSpan?: number;
  classNames?: (string | undefined)[];
}

export interface MarkupLine {
  classNames?: (string | undefined)[];
  linesContent?: MarkupSpan[];
  table?: { classNames?: (string | undefined)[]; rowContent?: MarkupCell[] }[];
  isFormula?: boolean;
}

export interface MarkupDiagnostic {
  message: string;
  severity: 'error' | 'warning';
}

export interface ParsedMarkup {
  lines: MarkupLine[];
  diagnostics: MarkupDiagnostic[];
}
