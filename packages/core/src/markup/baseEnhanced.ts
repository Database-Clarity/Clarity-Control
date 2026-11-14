/** Semantic legacy type used by native markup preparation, never a UI label. */
export const enhancedMarkupType = 'Weapon Trait Enhanced';

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
export function scanBaseEnhanced(
  text: string,
  allowEmpty = false,
): {
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
    /** The length of a delimited variable `#{name}` at `at` (its `#` is at `at - 1`), or 0. */
    const braced = (at: number) =>
      text[at - 1] === '#' ? (/^\{[a-zA-Z0-9]+\}/.exec(text.slice(at, at + 64))?.[0].length ?? 0) : 0;
    const arm = (): string | null => {
      const begin = pos;
      while (pos < text.length && text[pos] !== '}' && !/[\r\n]/.test(text[pos])) {
        if (text.startsWith('{{', pos)) return null;
        if (text[pos] === '{') {
          const variable = braced(pos);
          if (variable) {
            pos += variable;
            continue;
          }
          if (text[pos - 1] !== '$') return null;
          // A math block ends at its first `}`; a `#{name}` inside it is part of the formula.
          let end = pos + 1;
          for (;;) {
            if (end >= text.length || /[\r\n]/.test(text[end])) return null;
            if (text[end] === '}') break;
            if (text[end] === '{') {
              const inner = braced(end);
              if (!inner) return null;
              end += inner;
            } else end++;
          }
          pos = end + 1;
        } else pos++;
      }
      const value = text.slice(begin, pos);
      return allowEmpty || value.trim() ? value : null;
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
