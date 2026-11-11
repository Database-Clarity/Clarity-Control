import {
  buildGlobalUsageIndex,
  languages,
  type GlobalUsage,
  type Lang,
  type Tooltip,
} from '@clarity/core';

export const globalTypes = [
  { kind: 'variables', hash: 2, label: 'Variables' },
  { kind: 'titles', hash: 3, label: 'Titles' },
  { kind: 'exports', hash: 1, label: 'Exports' },
] as const;
export type GlobalKind = (typeof globalTypes)[number]['kind'];
export interface GlobalDefinition {
  kind: GlobalKind;
  hash: number;
  name: string;
  definitions: Partial<Record<Lang, string>>;
  lines: Partial<Record<Lang, number>>;
}

// Preserve source offsets and line numbers while ignoring commented declarations.
export function uncomment(source: string): string {
  return source
    .replace(/\r/g, '')
    .replace(/\/\*[^]*?\*\/|^ *\/\/.*$| +\/\/.*$/gm, (comment) => comment.replace(/[^\n]/g, ' '));
}

export function globalDefinitions(tooltips: Readonly<Record<string, Tooltip>>): GlobalDefinition[] {
  const entries = new Map<string, GlobalDefinition>();
  for (const { kind, hash } of globalTypes) {
    for (const lang of languages) {
      const source = uncomment(tooltips[hash]?.text[lang]?.text ?? '');
      const pattern =
        kind === 'variables'
          ? /^var ([a-zA-Z0-9]+) = (.+)$/gm
          : new RegExp(
              `^${kind === 'titles' ? 'title' : 'export'} ([A-z0-9 ]+) \\(([^]*?)\\n\\)$`,
              'gm',
            );
      for (const match of source.matchAll(pattern)) {
        const name = match[1].trim();
        const key = `${kind}:${name}`;
        const entry = entries.get(key) ?? { kind, hash, name, definitions: {}, lines: {} };
        const body = kind === 'variables' ? match[2].trim() : match[2].replace(/^\n/, '');
        entry.definitions[lang] = kind === 'variables' && body === 'empty' ? '' : body;
        entry.lines[lang] = source.slice(0, match.index).split('\n').length;
        entries.set(key, entry);
      }
    }
  }
  return [...entries.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );
}

export function globalPath(entry: GlobalDefinition, search = ''): string {
  const lang = new URLSearchParams(search).get('lang');
  const params = new URLSearchParams();
  if (languages.includes(lang as Lang)) params.set('lang', lang!);
  params.set('global', entry.name);
  return `/t/${entry.hash}?${params}`;
}

// Values do not change authored-reference identity. Cache each source independently so typing
// in an aggregate never rescans the entire tooltip corpus.
const usageCache = new WeakMap<
  Tooltip,
  { signature: string; entries: Map<string, GlobalUsage[]> }
>();
export function globalUsageEntries(tooltips: Readonly<Record<string, Tooltip>>) {
  const definitions = globalDefinitions(tooltips);
  const signature = JSON.stringify(
    definitions.map(({ kind, name, definitions }) => [kind, name, Object.keys(definitions)]),
  );
  const entries = definitions.map((entry) => ({ ...entry, usages: [] as GlobalUsage[] }));
  for (const tooltip of Object.values(tooltips)) {
    let cached = usageCache.get(tooltip);
    if (cached?.signature !== signature) {
      const refs = new Map<string, GlobalUsage[]>();
      // Reuse the authored-reference index for variables and titles, retaining its precedence
      // and language rules. Only usages belonging to this source enter its cached result.
      for (const entry of buildGlobalUsageIndex({
        2: tooltips[2],
        3: tooltips[3],
        [tooltip.hash]: tooltip,
      })) {
        refs.set(
          `${entry.kind}:${entry.name}`,
          entry.usages.filter((usage) => usage.hash === tooltip.hash),
        );
      }
      for (const lang of languages) {
        const original = (tooltip.text[lang]?.text ?? '').replace(/\r/g, '').split('\n');
        uncomment(tooltip.text[lang]?.text ?? '')
          .split('\n')
          .forEach((source, index) => {
            const match = /^import (.+?) from (global|1)$/.exec(source.trim());
            if (!match) return;
            const key = `exports:${match[1]}`;
            const usages = refs.get(key) ?? [];
            usages.push({ hash: tooltip.hash, lang, line: index + 1, source: original[index] });
            refs.set(key, usages);
          });
      }
      cached = { signature, entries: refs };
      usageCache.set(tooltip, cached);
    }
    for (const entry of entries) {
      entry.usages.push(
        ...(cached.entries.get(`${entry.kind}:${entry.name}`) ?? []).filter(
          (usage) => entry.definitions[usage.lang] !== undefined,
        ),
      );
    }
  }
  return entries;
}

export function globalUsageCount(entries: readonly { usages: readonly GlobalUsage[] }[]): number {
  return new Set(entries.flatMap((entry) => entry.usages.map((usage) => usage.hash))).size;
}
