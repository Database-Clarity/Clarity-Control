import { evaluateMarkupMath } from '@clarity/core/markup/arithmetic'

/**
 * Replaces each `${…}` with the value of the numeric expression at its start, rounded to 2 decimals.
 *
 * The held converter's doMath.ts ran that expression as JavaScript (a Function constructor); this uses core's
 * evaluateMarkupMath, which reads only numbers and + - * / (normal precedence) and never runs code.
 * Both give the same text for every math use in the data (see PROVENANCE.md, "Safe math"). They
 * differ only where JavaScript itself would misread the text: `${5--3}` (JavaScript: syntax error,
 * the whole file failed; here 8) and numbers with a leading zero such as `${010}` (JavaScript's old
 * octal: 8; here 10).
 */
export const doMath = (description: string) => evaluateMarkupMath(description)
