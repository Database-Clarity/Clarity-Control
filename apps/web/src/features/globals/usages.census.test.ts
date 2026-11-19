import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  enhancedMarkupType,
  globalReferenceSpans,
  languages,
  parseMarkup,
  type GlobalKind,
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
 * (a) the usage index against a removal oracle: a tooltip uses a global when deleting that one
 * declaration from the published aggregate changes what the real parser renders, in any
 * language and condition type (independent of the index's markers); (b) every authored
 * reference's go-to-definition through the editor's resolver.
 */
const dir = process.env.CLARITY_CENSUS_DIR;
const read = (name: string) => JSON.parse(readFileSync(join(dir!, name), 'utf8'));
const aggregates = [
  [2, 'variables'],
  [3, 'titles'],
  [1, 'exports'],
] as const;
const locate = (text: string, kind: GlobalKind) =>
  kind === 'variables'
    ? locateVariables(text)
    : locateBlocks(text, kind === 'titles' ? 'title' : 'export');

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
  // Entries as the catalogue holds them, from the published aggregates, in every language.
  const entries = new Map<string, GlobalRecord>();
  for (const [hash, kind] of aggregates)
    for (const lang of languages) {
      const text = (data.bundle.tooltips[hash]?.text[lang]?.text ?? '').replace(/\r/g, '');
      for (const located of locate(text, kind).values()) {
        const key = `${kind}:${located.name}`;
        const entry =
          entries.get(key) ??
          ({
            version: 1,
            id: `g_${kind}_${located.name.replace(/[^A-Za-z0-9_-]/g, '-')}`,
            kind,
            name: located.name,
            revision: 'r',
            definitions: {},
            nameHistory: [],
          } as unknown as GlobalRecord);
        (entry.definitions as Record<string, { body: string }>)[lang] = { body: located.value };
        entries.set(key, entry);
      }
    }
  return { data, entries: [...entries.values()] };
}

const conditionTypes = [
  undefined,
  enhancedMarkupType,
  'Weapon Catalyst Exotic',
  'Weapon Perk Exotic',
];

describe.skipIf(!dir)('globals census on real data', () => {
  it('(a) usages equal the removal oracle, (b) definitions open the right entry', async () => {
    const { data, entries } = load();
    const started = performance.now();
    const index = await buildGlobalUsageIndex(data, entries);
    const buildMs = performance.now() - started;
    const docs = Object.values(data.bundle.tooltips)
      .filter((tooltip) => tooltip.hash > 3)
      .flatMap((tooltip) =>
        languages
          .filter((lang) => tooltip.text[lang]?.text)
          .map((lang) => ({ hash: tooltip.hash, lang, text: tooltip.text[lang]!.text })),
      );
    const docLanguages = [...new Set(docs.map((doc) => doc.lang))];
    const real = new Map(docLanguages.map((lang) => [lang, importGlobals(data, {}, lang)]));
    const render = (text: string, globals: MarkupGlobals) =>
      conditionTypes.map((type) => JSON.stringify(parseMarkup(text, { ...globals, type }).lines));
    const baseline = docs.map((doc) => render(doc.text, real.get(doc.lang)!));
    /** The real globals of `lang` without one declaration. */
    const without = (entry: GlobalRecord, lang: Lang): MarkupGlobals => {
      const globals = real.get(lang)!;
      const hash = aggregates.find(([, kind]) => kind === entry.kind)![0];
      const text = (globals.imports?.[String(hash)] ?? '').replace(/\r/g, '');
      const raw = locate(text, entry.kind).get(entry.name)?.raw;
      const removed = raw === undefined ? text : text.replace(raw, '');
      if (entry.kind === 'variables') return { ...globals, variables: removed };
      if (entry.kind === 'titles') return { ...globals, titles: removed };
      const imports = new Proxy<Record<string, string>>(
        {},
        {
          get: (_target, key) =>
            key === '1' || key === 'global' ? removed : globals.imports?.[key as string],
        },
      );
      return { ...globals, imports };
    };
    const mismatches: string[] = [];
    const unused: string[] = [];
    let total = 0;
    for (const entry of entries) {
      const expected = new Set<number>();
      const changed = new Map(docLanguages.map((lang) => [lang, without(entry, lang)]));
      docs.forEach((doc, at) => {
        const after = render(doc.text, changed.get(doc.lang)!);
        if (after.some((value, type) => value !== baseline[at][type]))
          expected.add(canonicalHash(doc.hash, data));
      });
      const found = new Set(index.of(entry.id).tooltips.map((use) => use.hash));
      total += found.size;
      if (!found.size) unused.push(`${entry.kind}:${entry.name}`);
      const extra = [...found].filter((hash) => !expected.has(hash));
      const missing = [...expected].filter((hash) => !found.has(hash));
      if (extra.length || missing.length)
        mismatches.push(
          `${entry.kind}:${entry.name} index ${found.size} oracle ${expected.size} extra [${extra.join(',')}] missing [${missing.join(',')}]`,
        );
    }
    const spot = Object.fromEntries(
      entries.map((entry) => [
        `${entry.kind}:${entry.name}`,
        {
          tooltips: index
            .of(entry.id)
            .tooltips.map((use) => [
              use.hash,
              use.members,
              use.direct,
              use.via.join('; '),
              `${use.open.variant}:${use.open.lang}:${use.open.line ?? ''}`,
            ]),
          globals: index.of(entry.id).globals.length,
        },
      ]),
    );

    // (b) Every authored global reference, through the editor's own resolver and navigation.
    useGlobalIdentities.setState({
      identities: Object.fromEntries(
        entries.map((entry) => [entry.id, { kind: entry.kind, name: entry.name, definitions: {} }]),
      ),
      status: 'ready',
    });
    const ids = new Map(entries.map((entry) => [`${entry.kind}:${entry.name}`, entry.id]));
    const sources = tooltipTextSources(data.bundle.tooltips, {}, data.aliases);
    const wrong: string[] = [];
    let references = 0;
    const documents = [
      ...docs.map((doc) => ({ id: String(doc.hash), lang: doc.lang, text: doc.text })),
      ...entries.flatMap((entry) =>
        Object.entries(entry.definitions).map(([lang, definition]) => ({
          id: entry.id,
          lang: lang as Lang,
          text: definition!.body,
        })),
      ),
    ];
    for (const { id, lang, text: raw } of documents) {
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
            ref &&
            resolveReference(ref, {
              doc: text,
              lang,
              globals: real.get(lang) ?? importGlobals(data, {}, lang),
              sources,
            });
          const path =
            resolved?.target?.type === 'tooltip' ? definitionPath(resolved.target, data, true) : '';
          if (!path.startsWith(`/globals/${target}?`))
            wrong.push(
              `${id}/${lang} ${kind}:${span.name} -> ${path || resolved?.status || 'none'}`,
            );
        }
    }
    // Written next to the data (the test output hides console logs of passing tests).
    writeFileSync(
      join(dir!, 'census.json'),
      JSON.stringify(
        {
          buildMs: Math.round(buildMs),
          globals: entries.length,
          languages: docLanguages,
          documents: docs.length,
          unused,
          tooltipUses: total,
          mismatches,
          references,
          wrongDefinitions: wrong,
          spot,
        },
        null,
        1,
      ),
    );
    expect(wrong).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 600_000);
});
