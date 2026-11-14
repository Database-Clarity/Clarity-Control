import { languages, type Lang } from '../languages.js';
import { extractBlocks, extractVariables } from '../markup/syntax.js';
import type { Tooltip } from '../schemas.js';

export type GlobalKind = 'variables' | 'titles';
export interface GlobalUsage {
  hash: number;
  lang: Lang;
  line: number;
  source: string;
}
export interface GlobalEntry {
  kind: GlobalKind;
  name: string;
  definitions: Partial<Record<Lang, string>>;
  usages: GlobalUsage[];
}

function withoutComments(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/\/\*[^]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/^ *?\/\/.*$| +\/\/.*$/gm, (comment) => ' '.repeat(comment.length));
}

/** Authored references, including reusable exports; line numbers refer to the original source. */
export function buildGlobalUsageIndex(tooltips: Readonly<Record<string, Tooltip>>): GlobalEntry[] {
  const entries = new Map<string, GlobalEntry>();
  for (const [kind, hash] of [
    ['variables', 2],
    ['titles', 3],
  ] as const) {
    for (const lang of languages) {
      const source = withoutComments(tooltips[hash]?.text[lang]?.text ?? '');
      const definitions =
        kind === 'variables' ? extractVariables(source) : extractBlocks(source, 'title');
      for (const [name, value] of Object.entries(definitions)) {
        const key = `${kind}:${name}`;
        const entry = entries.get(key) ?? { kind, name, definitions: {}, usages: [] };
        entry.definitions[lang] = value;
        entries.set(key, entry);
      }
    }
  }
  for (const tooltip of Object.values(tooltips)) {
    for (const lang of languages) {
      const text = tooltip.text[lang]?.text;
      if (!text) continue;
      const original = text.replace(/\r/g, '').split('\n');
      withoutComments(text)
        .split('\n')
        .forEach((source, index) => {
          const references = [
            ...[...source.matchAll(/#\{([a-zA-Z0-9]+)\}|#([a-zA-Z0-9]+)/g)].map(
              (match) => `variables:${match[1] ?? match[2]}`,
            ),
            ...[...source.matchAll(/<title .+? \[([^\]]+)\] \/>/g)].map(
              (match) => `titles:${match[1]}`,
            ),
          ];
          for (const key of new Set(references)) {
            const entry = entries.get(key);
            if (entry?.definitions[lang] !== undefined) {
              entry.usages.push({
                hash: tooltip.hash,
                lang,
                line: index + 1,
                source: original[index],
              });
            }
          }
        });
    }
  }
  return [...entries.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );
}

export function globalTooltipCount(entries: readonly GlobalEntry[]): number {
  return new Set(entries.flatMap((entry) => entry.usages.map((usage) => usage.hash))).size;
}
