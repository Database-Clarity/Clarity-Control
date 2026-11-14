/**
 * The term matcher (TR2 official names now; the glossary, TR9, adds entries from its own source).
 * Matches English terms in the English text a translator reads: whole words (Unicode letters and
 * digits), longest term first, the words of a term joined by one space or hyphen, case-insensitive
 * unless the entry asks for case. The last word also matches the regular English endings (-s,
 * -es, -ed, -d, -ing, e-drop, y to ies/ied, a doubled final consonant), so "Jolt" marks "Jolts"
 * and "Jolted". Runs in the diagnostics worker (requestTermMatches); pure, so tests run it here.
 */
export interface TermEntry {
  /** The English term as the game writes it. */
  en: string;
  /** Other English spellings that mean the same term. */
  also?: readonly string[];
  /** Match only with the same capitals as `en` (item names; keywords match any case). */
  matchCase?: boolean;
}

export interface TermMatch {
  from: number;
  to: number;
  /** Index into the entry list the matcher was compiled from. */
  entry: number;
}

interface Pattern {
  entry: number;
  tokens: string[];
  lower: string[];
  last: Set<string>;
  matchCase: boolean;
}
export type CompiledTerms = Map<string, Pattern[]>;

const vowel = /[aeiou]/;
const wordPattern = /[\p{L}\p{N}]+/gu;

/** The forms of a term's last word: Jolt → jolts, jolted, jolting; Stun → stunned. */
export function englishEndings(word: string): Set<string> {
  const w = word.toLowerCase();
  const out = new Set([w, `${w}s`, `${w}es`, `${w}ed`, `${w}ing`]);
  if (w.endsWith('e')) {
    out.add(`${w}d`);
    out.add(`${w.slice(0, -1)}ing`);
  }
  if (w.endsWith('y') && w.length > 2 && !vowel.test(w.at(-2)!)) {
    out.add(`${w.slice(0, -1)}ies`);
    out.add(`${w.slice(0, -1)}ied`);
  }
  if (w.length >= 3 && /^[a-z]+$/.test(w)) {
    const [a, b, c] = w.slice(-3);
    if (!vowel.test(a!) && vowel.test(b!) && !vowel.test(c!) && !'wxy'.includes(c!)) {
      out.add(`${w}${c}ed`);
      out.add(`${w}${c}ing`);
    }
  }
  return out;
}

const words = (text: string) => [...text.matchAll(wordPattern)].map((match) => match[0]);

export function compileTerms(entries: readonly TermEntry[]): CompiledTerms {
  const byFirst: CompiledTerms = new Map();
  entries.forEach((entry, index) => {
    for (const form of [entry.en, ...(entry.also ?? [])]) {
      const tokens = words(form);
      if (!tokens.length) continue;
      const lower = tokens.map((token) => token.toLowerCase());
      const pattern: Pattern = {
        entry: index,
        tokens,
        lower,
        last: englishEndings(tokens.at(-1)!),
        matchCase: entry.matchCase === true,
      };
      // One-word terms are indexed under every form of the word; longer ones under the first.
      for (const first of tokens.length === 1 ? pattern.last : [lower[0]!]) {
        let list = byFirst.get(first);
        if (!list) byFirst.set(first, (list = []));
        list.push(pattern);
      }
    }
  });
  for (const list of byFirst.values()) list.sort((a, b) => b.tokens.length - a.tokens.length);
  return byFirst;
}

/** Every term in `text`, left to right, never overlapping. */
export function matchTerms(text: string, compiled: CompiledTerms): TermMatch[] {
  const tokens = [...text.matchAll(wordPattern)].map((match) => ({
    text: match[0],
    lower: match[0].toLowerCase(),
    from: match.index,
    to: match.index + match[0].length,
  }));
  const found: TermMatch[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const candidates = compiled.get(tokens[i]!.lower);
    if (!candidates) continue;
    for (const pattern of candidates) {
      const n = pattern.tokens.length;
      if (i + n > tokens.length) continue;
      let ok = true;
      for (let k = 0; k < n && ok; k++) {
        const token = tokens[i + k]!;
        const last = k === n - 1;
        if (last ? !pattern.last.has(token.lower) : token.lower !== pattern.lower[k]) ok = false;
        else if (pattern.matchCase && !token.text.startsWith(pattern.tokens[k]!)) ok = false;
        else if (k > 0 && !/^[ -]$/.test(text.slice(tokens[i + k - 1]!.to, token.from))) ok = false;
      }
      if (!ok) continue;
      found.push({ from: tokens[i]!.from, to: tokens[i + n - 1]!.to, entry: pattern.entry });
      i += n - 1;
      break;
    }
  }
  return found;
}
