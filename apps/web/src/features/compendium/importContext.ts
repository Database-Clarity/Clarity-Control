import { resolveAlias, type Aliases, type Tooltip } from '@clarity/core';
// Bounded inspection only: show authored dependency context without expanding or
// modifying imports. Missing/cyclic sources remain visible for human review.
export function importContext(
  text: string,
  tooltips: Record<string, Tooltip>,
  aliases: Aliases,
): string[] {
  const result: string[] = [];
  const seen = new Set<number>();
  function visit(text: string, depth: number) {
    for (const match of text.matchAll(/^import\s+\S+\s+from\s+(\d+)\s*$/gm)) {
      if (result.length >= 40) return;
      let hash: number;
      try {
        hash = resolveAlias(Number(match[1]), aliases);
      } catch {
        result.push(`Import ${match[1]}: cyclic alias.`);
        continue;
      }
      if (seen.has(hash)) {
        result.push(`Import ${hash}: repeated or cyclic dependency.`);
        continue;
      }
      seen.add(hash);
      const source = tooltips[hash]?.text.en?.text;
      result.push(`Import ${hash}:\n${source ?? 'Missing English source.'}`);
      if (source && depth < 5) visit(source, depth + 1);
      else if (source && /^import /m.test(source))
        result.push('Further dependencies omitted; inspect in the tooltip editor.');
    }
  }
  visit(text, 0);
  return result;
}
