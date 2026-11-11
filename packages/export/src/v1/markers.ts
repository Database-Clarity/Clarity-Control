// Vocabulary check (spec section 5): a file's marker sets are its entry key paths with the value
// type at each path, its class names (per path, so span- and line-level classes differ), and the
// configured string markers (replacement tokens) it uses. Link, title, and formula presence are key
// paths. A build that adds, removes, or retypes any member is breaking; text content and new
// entries are not (entries, languages, and array positions are wildcards).
import { converterSettings } from '../converter/index.js';
import type { ExportFile } from './config.js';
import { isLegacyFile } from './vocabulary.js';

const typeOf = (value: unknown) =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

/**
 * Marker set of one output file (parsed JSON), sorted. `tokens` are the strings a text output may
 * contain by configuration (prefixes, suffixes, link and title patterns, arrow replacement).
 */
export function markerSet(file: unknown, tokens: readonly string[] = []): string[] {
  const markers = new Set<string>();
  const used = new Set<string>();
  const wanted = [...new Set(tokens.filter((token) => token.length > 0))];
  // Paths whose keys are data (hashes, languages, text indices), not vocabulary.
  const v1 = isV1(file);
  const visit = (value: unknown, path: string, parentKey: string) => {
    markers.add(`${path}:${typeOf(value)}`);
    if (typeof value === 'string') {
      for (const token of wanted) if (!used.has(token) && value.includes(token)) used.add(token);
      if (parentKey === 'classNames') markers.add(`class ${path}=${value}`);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, `${path}[]`, parentKey);
      return;
    }
    if (value && typeof value === 'object') {
      const wildcard = isDataKeyed(path, v1);
      for (const [key, child] of Object.entries(value))
        visit(child, `${path}.${wildcard ? '*' : key}`, key);
    }
  };
  visit(file, '$', '');
  for (const token of used) markers.add(`token ${JSON.stringify(token)}`);
  return [...markers].sort();
}

const isV1 = (file: unknown) =>
  !!file && typeof file === 'object' && 'texts' in file && 'items' in file;

function isDataKeyed(path: string, v1: boolean) {
  if (v1) return path === '$.items' || path === '$.texts[]';
  // Legacy: { "<hash>": { ..., descriptions: { "<lang>": ... } } }
  return path === '$' || path === '$.*.descriptions';
}

export type MarkerChange = { added: string[]; removed: string[] };

/** Members added or removed relative to the baseline; undefined when nothing changed. */
export function markerChange(
  baseline: readonly string[],
  current: readonly string[],
): MarkerChange | undefined {
  const before = new Set(baseline);
  const after = new Set(current);
  const added = current.filter((marker) => !before.has(marker));
  const removed = baseline.filter((marker) => !after.has(marker));
  return added.length || removed.length ? { added, removed } : undefined;
}

/**
 * The configured string markers of a file: what its settings may insert into text (legacy string
 * presets: class prefixes and suffixes, title and link patterns, the arrow replacement; styles:
 * replace texts and inline title or link patterns).
 */
export function outputTokens(file: ExportFile): string[] {
  if (isLegacyFile(file)) {
    const settings = converterSettings[file.preset];
    const options = settings?.toStringConverterOptions;
    return [
      ...Object.values(options?.classNames ?? {}).flatMap((pair) => pair ?? []),
      ...(options?.title ?? []),
      ...(options?.link ?? []),
      ...(settings?.enhancedArrowReplacement ? [settings.enhancedArrowReplacement] : []),
    ];
  }
  const { symbols, titles, links } = file.format;
  return [
    ...Object.values(symbols).flatMap((rule) =>
      rule?.mode === 'replace' ? [rule.before, rule.after] : [],
    ),
    ...(titles.mode === 'inline' ? titles.pattern : []),
    ...(links.mode === 'replace' ? links.pattern : []),
  ];
}
