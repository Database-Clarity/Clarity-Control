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
        const name = (
          kind === 'variables'
            ? match[1]
            : match[1].replace(kind === 'titles' ? /title/gi : /export|hidden/gi, '')
        ).trim();
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

export function globalUsageEntries(tooltips: Readonly<Record<string, Tooltip>>) {
  const entries = globalDefinitions(tooltips).map((entry) => ({
    ...entry,
    usages: [] as GlobalUsage[],
  }));
  for (const indexed of buildGlobalUsageIndex(tooltips)) {
    const entry = entries.find(
      (entry) => entry.kind === indexed.kind && entry.name === indexed.name,
    );
    if (entry) entry.usages = indexed.usages;
  }
  const exports = new Map(
    entries.filter((entry) => entry.kind === 'exports').map((entry) => [entry.name, entry]),
  );
  if (exports.size)
    for (const tooltip of Object.values(tooltips)) {
      for (const lang of languages) {
        const text = tooltip.text[lang]?.text;
        if (!text) continue;
        const original = text.replace(/\r/g, '').split('\n');
        uncomment(text)
          .split('\n')
          .forEach((source, index) => {
            const match = /^import (.+?) from (global|1)$/.exec(source.trim());
            const entry = match && exports.get(match[1]);
            if (entry && entry.definitions[lang] !== undefined)
              entry.usages.push({
                hash: tooltip.hash,
                lang,
                line: index + 1,
                source: original[index],
              });
          });
      }
    }
  return entries;
}

const declarationSignature = (entries: readonly GlobalDefinition[]) =>
  JSON.stringify(
    entries.map(({ kind, name, definitions }) => [kind, name, Object.keys(definitions)]),
  );

/** Project draft references incrementally; aggregate value edits never rescan saved consumers. */
export function createGlobalUsageProjection(saved: Readonly<Record<string, Tooltip>>) {
  const baseline = globalUsageEntries(saved);
  const signature = declarationSignature(baseline);
  const sourceCache = new WeakMap<Tooltip, ReturnType<typeof globalUsageEntries>>();
  const results = new WeakMap<object, ReturnType<typeof globalUsageEntries>>();
  return (drafts: Readonly<Record<string, { next: Tooltip }>>) => {
    const cached = results.get(drafts);
    if (cached) return cached;
    const aggregates = {
      1: drafts[1]?.next ?? saved[1],
      2: drafts[2]?.next ?? saved[2],
      3: drafts[3]?.next ?? saved[3],
    };
    const definitions = globalDefinitions(aggregates);
    let projected: ReturnType<typeof globalUsageEntries>;
    if (declarationSignature(definitions) !== signature) {
      // Added/removed declarations or languages change which references qualify.
      projected = globalUsageEntries({
        ...saved,
        ...Object.fromEntries(Object.entries(drafts).map(([hash, draft]) => [hash, draft.next])),
      });
    } else {
      const changed = new Set(Object.keys(drafts).map(Number));
      const contributions = Object.values(drafts).map(({ next }) => {
        let refs = sourceCache.get(next);
        if (!refs) {
          refs = globalUsageEntries({
            1: saved[1],
            2: saved[2],
            3: saved[3],
            [next.hash]: next,
          }).map((entry) => ({
            ...entry,
            usages: entry.usages.filter((usage) => usage.hash === next.hash),
          }));
          sourceCache.set(next, refs);
        }
        return refs;
      });
      projected = definitions.map((entry) => ({
        ...entry,
        usages: [
          ...(
            baseline.find(
              (candidate) => candidate.kind === entry.kind && candidate.name === entry.name,
            )?.usages ?? []
          ).filter((usage) => !changed.has(usage.hash)),
          ...contributions.flatMap(
            (entries) =>
              entries.find(
                (candidate) => candidate.kind === entry.kind && candidate.name === entry.name,
              )?.usages ?? [],
          ),
        ].sort(
          (a, b) =>
            a.hash - b.hash ||
            languages.indexOf(a.lang) - languages.indexOf(b.lang) ||
            a.line - b.line,
        ),
      }));
    }
    results.set(drafts, projected);
    return projected;
  };
}

export function globalUsageCount(entries: readonly { usages: readonly GlobalUsage[] }[]): number {
  return new Set(entries.flatMap((entry) => entry.usages.map((usage) => usage.hash))).size;
}
