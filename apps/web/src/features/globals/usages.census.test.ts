import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  enhancedMarkupType,
  globalReferenceSpans,
  parseMarkup,
  type GlobalRecord,
  type Lang,
  type MarkupGlobals,
} from '@clarity/core';
import { withSandboxPicks, type EditorData } from '../../stores/data';
import { useGlobalIdentities } from '../../stores/globalIdentities';
import { importGlobals } from '../../services/tooltipImports';
import { definitionPath } from '../editor/definitionPath';
import {
  locateBlocks,
  locateVariables,
  referenceInLine,
  resolveReference,
  tooltipTextSources,
} from '../editor/references';
import { canonicalHash } from '../navigation/catalog';
import { buildGlobalUsageIndex } from './usages';

/**
 * Real-data census (local only): CLARITY_CENSUS_DIR holds bundle.json (editor-data-bundle),
 * items.json, aliases.json, categories.json, and sandboxConflicts.json (generator v2 templates).
 * (a) the usage index against the real parser, which renders each tooltip with every global
 * replaced by a marker, under every condition type; (b) every reference's go-to-definition.
 */
const dir = process.env.CLARITY_CENSUS_DIR;
const read = (name: string) => JSON.parse(readFileSync(join(dir!, name), 'utf8'));

function load() {
  const bundle = read('bundle.json');
  const base = {
    categories: read('categories.json'),
    items: read('items.json'),
    aliases: read('aliases.json'),
    bundle: { ...bundle, inactiveMoves: bundle.inactiveMoves ?? {} },
  } as EditorData;
  const data = withSandboxPicks(
    { ...base, generatorAliases: base.aliases },
    bundle.sandboxPointers,
    read('sandboxConflicts.json'),
  );
  // Entries as the catalogue holds them, from the published aggregates.
  const entries: GlobalRecord[] = [];
  for (const [hash, kind] of [
    [2, 'variables'],
    [3, 'titles'],
    [1, 'exports'],
  ] as const) {
    const text = (data.bundle.tooltips[hash]?.text.en?.text ?? '').replace(/\r/g, '');
    const found =
      kind === 'variables'
        ? locateVariables(text)
        : locateBlocks(text, kind === 'titles' ? 'title' : 'export');
    for (const located of found.values())
      entries.push({
        version: 1,
        id: `g_${kind}_${located.name.replace(/[^A-Za-z0-9_-]/g, '-')}`.padEnd(10, '_'),
        kind,
        name: located.name,
        revision: 'r',
        definitions: { en: { body: located.value } },
        nameHistory: [],
      } as unknown as GlobalRecord);
  }
  return { data, entries };
}

const letters = (index: number) =>
  index
    .toString(26)
    .split('')
    .map((digit) => String.fromCharCode(97 + parseInt(digit, 26)))
    .join('');

describe.skipIf(!dir)('globals census on real data', () => {
  it('(a) usages equal what the resolver renders, (b) definitions open the right entry', async () => {
    const { data, entries } = load();
    const started = performance.now();
    const index = await buildGlobalUsageIndex(data, entries);
    const buildMs = performance.now() - started;
    const lang: Lang = 'en';
    // Marked globals: every declaration renders a unique marker where the resolver uses it.
    const markers = new Map<string, GlobalRecord>();
    const mark = (entry: GlobalRecord) => {
      const marker = `⦃${letters(markers.size)}⦄`;
      markers.set(marker, entry);
      return marker;
    };
    const body = (entry: GlobalRecord) => entry.definitions.en?.body ?? '';
    const marked = {
      variables: entries
        .filter((entry) => entry.kind === 'variables')
        .map((entry) => `var ${entry.name} = ${mark(entry)}`)
        .join('\n'),
      titles: entries
        .filter((entry) => entry.kind === 'titles')
        .map((entry) => `title ${entry.name} (\n${mark(entry)} ${body(entry)}\n)`)
        .join('\n\n'),
      exports: entries
        .filter((entry) => entry.kind === 'exports')
        .map((entry) => `export ${entry.name} (\n${mark(entry)} ${body(entry)}\n)`)
        .join('\n\n'),
    };
    const real = importGlobals(data, {}, lang);
    const imports = new Proxy<Record<string, string>>(
      {},
      {
        get: (_target, key) =>
          key === '1' || key === 'global' ? marked.exports : real.imports?.[key as string],
      },
    );
    const globals: MarkupGlobals = {
      variables: marked.variables,
      titles: marked.titles,
      imports,
    };
    const resolver = new Map<string, Set<number>>();
    for (const tooltip of Object.values(data.bundle.tooltips)) {
      const text = tooltip.text[lang]?.text;
      if (!text || (tooltip.hash >= 1 && tooltip.hash <= 3)) continue;
      const canonical = canonicalHash(tooltip.hash, data);
      for (const type of [
        undefined,
        enhancedMarkupType,
        'Weapon Catalyst Exotic',
        'Weapon Perk Exotic',
      ]) {
        const rendered = JSON.stringify(parseMarkup(text, { ...globals, type }).lines);
        for (const match of rendered.matchAll(/⦃[a-z]+⦄/g)) {
          const id = markers.get(match[0])!.id;
          if (!resolver.has(id)) resolver.set(id, new Set());
          resolver.get(id)!.add(canonical);
        }
      }
    }
    const summary = {
      buildMs: Math.round(buildMs),
      globals: entries.length,
      unused: [] as string[],
    };
    const mismatches: string[] = [];
    let total = 0;
    for (const entry of entries) {
      const found = new Set(index.of(entry.id).tooltips.map((use) => use.hash));
      const expected = resolver.get(entry.id) ?? new Set();
      total += found.size;
      if (!found.size) summary.unused.push(`${entry.kind}:${entry.name}`);
      const extra = [...found].filter((hash) => !expected.has(hash));
      const missing = [...expected].filter((hash) => !found.has(hash));
      if (extra.length || missing.length)
        mismatches.push(
          `${entry.kind}:${entry.name} index ${found.size} resolver ${expected.size} extra [${extra.join(',')}] missing [${missing.join(',')}]`,
        );
    }
    const spot = Object.fromEntries(
      entries.map((entry) => [
        `${entry.kind}:${entry.name}`,
        {
          tooltips: index
            .of(entry.id)
            .tooltips.map((use) => [use.hash, use.members, use.direct, use.via.join('; ')]),
          globals: index.of(entry.id).globals.length,
        },
      ]),
    );

    // (b) Every authored global reference, through the editor's own resolver and navigation.
    useGlobalIdentities.setState({
      identities: Object.fromEntries(
        entries.map((entry) => [
          entry.id,
          { kind: entry.kind, name: entry.name, definitions: { en: body(entry) } },
        ]),
      ),
      status: 'ready',
    });
    const ids = new Map(entries.map((entry) => [`${entry.kind}:${entry.name}`, entry.id]));
    const sources = tooltipTextSources(data.bundle.tooltips, {}, data.aliases);
    const wrong: string[] = [];
    let references = 0;
    const documents = [
      ...Object.values(data.bundle.tooltips)
        .filter((tooltip) => tooltip.hash > 3)
        .map((tooltip) => ({ id: String(tooltip.hash), text: tooltip.text[lang]?.text ?? '' })),
      ...entries.map((entry) => ({ id: entry.id, text: body(entry) })),
    ];
    for (const { id, text: raw } of documents) {
      const text = raw.replace(/\r/g, '');
      for (const kind of ['variables', 'titles', 'exports'] as const)
        for (const span of globalReferenceSpans(text, kind)) {
          const target = ids.get(`${kind}:${span.name}`);
          if (!target) continue;
          references++;
          const lineStart = text.lastIndexOf('\n', span.from - 1) + 1;
          const lineEnd = text.indexOf('\n', span.from);
          const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
          const ref = referenceInLine(line, span.from - lineStart);
          const resolved =
            ref && resolveReference(ref, { doc: text, lang, globals: real, sources });
          const path =
            resolved?.target?.type === 'tooltip' ? definitionPath(resolved.target, data, true) : '';
          if (path !== `/globals/${target}?lang=en`)
            wrong.push(
              `${id} ${kind}:${span.name} -> ${path || resolved?.status || 'no reference'}`,
            );
        }
    }
    // Written next to the data (the test output hides console logs of passing tests).
    writeFileSync(
      join(dir!, 'census.json'),
      JSON.stringify(
        { ...summary, tooltipUses: total, mismatches, references, wrongDefinitions: wrong, spot },
        null,
        1,
      ),
    );
    expect(wrong).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 600_000);
});
