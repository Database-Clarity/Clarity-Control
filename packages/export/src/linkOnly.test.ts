import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  exportLegacy,
  hasTooltipText,
  languages,
  validateTextWithReads,
  resolveAlias,
  type Aliases,
  type Tooltip,
} from '@clarity/core';
import { buildLegacy, legacyPresets, type LegacyInput } from './legacy.js';

it('209 link-only records change zero bytes in consumer and site inputs', async () => {
  const tooltips: Tooltip[] = process.env.LINK_ONLY_BUNDLE
    ? Object.values(JSON.parse(readFileSync(process.env.LINK_ONLY_BUNDLE, 'utf8')).tooltips)
    : [
        ...[1, 2, 3].map((hash) => ({ hash, text: {}, associated: [] })),
        {
          hash: 123,
          text: { en: { text: 'A tooltip', updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'test' } },
          associated: [],
        },
      ];
  const linked: Tooltip[] = Array.from({ length: 209 }, (_, i) => ({
    hash: 4000000000 + i,
    text: {},
    associated: [],
    compendium: {
      gid: '1662574278',
      rowKey: `Item ${i}`,
      snapshot: { plain: '', runs: [] },
      snapshotAt: '2026-01-01T00:00:00Z',
    },
  }));
  const aliases: Aliases = process.env.LINK_ONLY_ALIASES
    ? JSON.parse(readFileSync(process.env.LINK_ONLY_ALIASES, 'utf8'))
    : {};
  const baselineExport = process.env.LINK_ONLY_BASELINE
    ? ((await import(process.env.LINK_ONLY_BASELINE)).exportLegacy as typeof exportLegacy)
    : exportLegacy;
  const emptyTargets = new Set(
    tooltips.filter((t) => t.hash > 3 && !hasTooltipText(t)).map((t) => t.hash),
  );
  const importReferences: { hash: number; lang: string; target: number }[] = [];
  for (const lang of languages) {
    const imports = Object.fromEntries(tooltips.map((t) => [t.hash, t.text[lang]?.text ?? '']));
    for (const alias of Object.keys(aliases))
      imports[alias] = imports[resolveAlias(Number(alias), aliases)] ?? '';
    for (const tooltip of tooltips) {
      const text = tooltip.text[lang]?.text;
      if (text === undefined || !hasTooltipText(tooltip)) continue;
      const { reads } = validateTextWithReads(
        text,
        lang,
        { imports, variables: imports[2] ?? '', titles: imports[3] ?? '' },
        false,
        tooltip.hash,
        aliases,
      );
      for (const target of new Set(reads.imports.values()))
        if (emptyTargets.has(target)) importReferences.push({ hash: tooltip.hash, lang, target });
    }
  }
  if (process.env.LINK_ONLY_EVIDENCE && importReferences.length)
    writeFileSync(
      process.env.LINK_ONLY_EVIDENCE,
      JSON.stringify({ importsToEmpty: importReferences }, null, 2),
    );
  expect(
    importReferences,
    'real resolver reads of omitted records must be repaired before publishing',
  ).toEqual([]);
  const before = baselineExport(tooltips, 0, undefined, aliases);
  const after = exportLegacy([...tooltips, ...linked], 0, undefined, aliases);
  const empty = new Set(
    tooltips.filter((t) => t.hash > 3 && !hasTooltipText(t)).map((t) => t.hash),
  );
  const removed = Object.keys(before)
    .filter((hash) => !after[hash])
    .map(Number);
  for (const hash of removed) expect(empty.has(resolveAlias(hash, aliases))).toBe(true);
  expect(
    JSON.stringify(Object.fromEntries(Object.entries(before).filter(([hash]) => after[hash]))),
  ).toBe(JSON.stringify(after));
  const aliasRemovals = Object.entries(aliases).filter(([hash]) =>
    empty.has(resolveAlias(Number(hash), aliases)),
  );
  if (process.env.LINK_ONLY_EVIDENCE)
    writeFileSync(
      process.env.LINK_ONLY_EVIDENCE,
      JSON.stringify(
        {
          sourceCommit: process.env.LINK_ONLY_BUNDLE
            ? JSON.parse(readFileSync(process.env.LINK_ONLY_BUNDLE, 'utf8')).sourceCommit
            : null,
          empty: [...empty].sort((a, b) => a - b),
          removed: removed.sort((a, b) => a - b),
          aliasRemovals,
          remainingBytesIdentical: true,
          importsToEmpty: [],
        },
        null,
        2,
      ),
    );
  console.log(
    `Omitted ${empty.size} empty canonical records and ${aliasRemovals.length} aliases; ${removed.length} removed input entries; all retained bytes identical`,
  );
  // Site builds consume this same liveDescriptions input; no record or alias stub leaks.
  const input = (perks: typeof before) => ({ perks }) as LegacyInput;
  for (const preset of legacyPresets) {
    const baseline = buildLegacy(input(before), preset);
    const candidate = buildLegacy(input(after), preset);
    expect(Buffer.compare(baseline, candidate), preset).toBe(0);
    console.log(`${preset}: ${candidate.byteLength} bytes, diff 0`);
  }
  expect(
    exportLegacy(linked, 0, undefined, { 3000000000: { to: linked[0].hash, kind: 'frame' } }),
  ).toEqual({});
  const written = {
    ...linked[0],
    text: { en: { text: 'Now written', updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'test' } },
  };
  expect(hasTooltipText(written)).toBe(true);
  expect(exportLegacy([written], 0)[written.hash]).toBeDefined();
  expect(
    JSON.parse(
      Buffer.from(
        buildLegacy(
          input(
            exportLegacy(
              [...[1, 2, 3].map((hash) => ({ hash, text: {}, associated: [] })), written],
              0,
            ),
          ),
          'clarityV2',
        ),
      ).toString(),
    )[written.hash],
  ).toBeDefined();
  expect(hasTooltipText({ ...written, text: { en: { ...written.text.en, text: '  \n' } } })).toBe(
    false,
  );
  console.log(
    `Census: ${tooltips.length} saved + ${linked.length} simulated link-only files; intermediate diff 0`,
  );
}, 300000);

it('fails closed on direct, nested, and aliased imports or associations of omitted empty records', () => {
  const en = (text: string) => ({
    en: { text, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'test' },
  });
  const empty: Tooltip = { hash: 125, text: {}, associated: [] };
  const globals: Tooltip[] = [1, 2, 3].map((hash) => ({ hash, text: {}, associated: [] }));
  const source = (text: string): Tooltip => ({ hash: 123, text: en(text), associated: [] });
  const nested: Tooltip = {
    hash: 124,
    text: en('export hidden foo (\nimport main from 125\n)'),
    associated: [],
  };
  for (const [text, aliases] of [
    ['import main from 125', {}],
    ['import foo from 124', {}],
    ['import foo from 456', { 456: { to: 124, kind: 'frame' as const } }],
  ] as const) {
    expect(() =>
      exportLegacy([...globals, source(text), nested, empty], 0, undefined, aliases),
    ).toThrow('imports empty tooltip 125');
  }
  expect(() =>
    exportLegacy([...globals, { ...source('Written'), associated: [125] }, empty], 0),
  ).toThrow('associates an empty tooltip');
});
