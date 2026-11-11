import type { MarkupDiagnostic } from './types.js';

export interface BaseEnhancedPair {
  from: number;
  to: number;
  base: string;
  enhanced: string;
}
export const baseEnhancedMessage =
  'Use {{base}{enhanced}} with two nonempty inline arms on one line; pairs cannot nest.';
export const baseEnhancedPublishMessage =
  'Base/enhanced markup needs the new converter; it can be pushed after cut-over';

/** Native syntax only: no generated declarations, reserved names, or persistence transform. */
export function scanBaseEnhanced(text: string): {
  pairs: BaseEnhancedPair[];
  issues: { from: number; to: number }[];
} {
  const pairs: BaseEnhancedPair[] = [];
  const issues: { from: number; to: number }[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const from = text.indexOf('{{', cursor);
    if (from < 0) break;
    let pos = from + 2;
    const arm = (): string | null => {
      const begin = pos;
      while (pos < text.length && text[pos] !== '}' && !/[\r\n]/.test(text[pos])) {
        if (text.startsWith('{{', pos)) return null;
        if (text[pos] === '{') {
          if (text[pos - 1] !== '$') return null;
          const end = text.indexOf('}', pos);
          if (end < 0 || /[{}\r\n]/.test(text.slice(pos + 1, end))) return null;
          pos = end + 1;
        } else pos++;
      }
      const value = text.slice(begin, pos);
      return value.trim() ? value : null;
    };
    const base = arm();
    if (base !== null && text.slice(pos, pos + 2) === '}{') {
      pos += 2;
      const enhanced = arm();
      if (enhanced !== null && text.slice(pos, pos + 2) === '}}') {
        cursor = pos + 2;
        pairs.push({ from, to: cursor, base, enhanced });
        continue;
      }
    }
    const end = text.indexOf('\n', from);
    cursor = end < 0 ? text.length : end + 1;
    issues.push({ from, to: end < 0 ? text.length : end });
  }
  return { pairs, issues };
}
export const baseEnhancedPairs = (text: string) => scanBaseEnhanced(text).pairs;
export const unfinishedBaseEnhanced = (text: string) => scanBaseEnhanced(text).issues;

/** Resolve native inline tokens after imports, conditions, variables, and arithmetic. */
export function resolveBaseEnhanced(
  text: string,
  enhanced: boolean,
  diagnostics: MarkupDiagnostic[],
  transform: (source: string) => string = (source) => source,
): string {
  if (!text.includes('{{')) return transform(text);
  const parsed = scanBaseEnhanced(text);
  if (parsed.issues.length) {
    diagnostics.push({ severity: 'error', message: baseEnhancedMessage });
  }
  let result = '';
  let at = 0;
  for (const pair of parsed.pairs) {
    result +=
      transform(text.slice(at, pair.from)) + transform(enhanced ? pair.enhanced : pair.base);
    at = pair.to;
  }
  return result + transform(text.slice(at));
}
