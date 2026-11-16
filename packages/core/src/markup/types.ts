export interface MarkupGlobals {
  variables: string;
  titles: string;
  imports?: Readonly<Record<string, string>>;
  type?: string;
  /** Decimal formatting after maths; omitted/en preserves the established bytes. */
  lang?: import('../languages.js').Lang;
  /** Optional save-validation observer; never changes variable resolution. */
  onVariable?: (name: string) => void;
  /** Opt-in translation preview input; imports have already resolved their own maps. */
  numberInput?: {
    values: ReadonlyMap<number, string | null>;
    english: string;
    lang: import('../languages.js').Lang;
    fallback: boolean;
    issue?: string;
    hasImportedNumbers?(hash: string): boolean;
  };
}

export interface MarkupSpan {
  /** Optional identity of a number in this document's English source. */
  slots?: readonly { id: number; from: number; to: number }[];
  /** Source references only; never inferred from the digits a variable produces. */
  variables?: readonly { name: string; from: number; to: number }[];
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
