import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'packages/core/package.json'));

/** Bundles the real variant code (and the core renderer it uses) so the audit judges with it. */
async function loadVariants() {
  const { outputFiles } = await build({
    stdin: {
      contents: `export * from './apps/web/src/features/tooltip/variants.ts'; export { languages, resolveAlias } from '@clarity/core';`,
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    nodePaths: [join(root, 'node_modules')],
  });
  const code = Buffer.from(outputFiles[0].text).toString('base64');
  return import(`data:text/javascript;base64,${code}`);
}

function parseBlock(text) {
  return /^import (main|secondary) from (\d+) *$/m.test(text.trim()) && text.trim().split('\n').length === 1;
}

/**
 * Read-only: classifies every variant per type and language by what is stored and whether it
 * renders like its base, and cross-checks each derived variant against the published converter
 * (the exporter's renderer). Nothing is written.
 */
export async function audit({ items, categories, aliases, bundle }) {
  const { variantForm, variantMatchesBase, enhancedVariants, languages, resolveAlias } = await loadVariants();
  const { descriptionConverter } = require('@icemourne/description-converter');
  const data = { items, categories, aliases, bundle };
  const legacyType = (hash) => categories.find((c) => c.id === items[hash]?.categoryId)?.legacyType;
  const canonical = (hash) => {
    const seen = new Set();
    while (!seen.has(hash)) {
      seen.add(hash);
      const target = resolveAlias(hash, aliases);
      if (target !== hash) { hash = target; continue; }
      const next = items[hash]?.baseHash;
      if (next === undefined) return hash;
      hash = next;
    }
    return hash;
  };
  // The converter's database: stored text only, every canonical tooltip, typed as the generator types it.
  const database = {};
  for (const [hash, tooltip] of Object.entries(bundle.tooltips)) {
    const editor = {};
    for (const [lang, entry] of Object.entries(tooltip.text)) editor[lang] = { main: entry.text, secondary: entry.text };
    database[hash] = { hash: Number(hash), name: '', type: legacyType(Number(hash)) ?? tooltip.custom?.categoryId ?? 'none', editor };
  }
  const exported = (descriptionString, language, hash) =>
    JSON.stringify(descriptionConverter({ descriptionString, editorType: 'main', language, hash, database }));

  const bases = new Set();
  const types = {};
  const overrides = [];
  const empties = [];
  const derivedExportDiffers = [];
  let variants = 0;
  for (const item of Object.values(items)) {
    if (resolveAlias(item.hash, aliases) !== item.hash) continue;
    const base = canonical(item.hash);
    if (base === item.hash) continue;
    variants++;
    bases.add(base);
    const type = item.categoryId;
    const row = (types[type] ??= { variants: 0, derived: 0, override: 0, languages: {} });
    row.variants++;
    const form = variantForm(base, item.hash, data);
    row[form]++;
    const stored = bundle.tooltips[item.hash];
    const baseTooltip = bundle.tooltips[base];
    if (!database[item.hash]) database[item.hash] = { hash: item.hash, name: '', type: legacyType(item.hash) ?? 'none', editor: {} };
    for (const lang of languages) {
      const own = stored?.text[lang]?.text;
      const inherited = baseTooltip?.text[lang]?.text;
      if (own === undefined && inherited === undefined) continue;
      const kind =
        own === undefined || own.trim() === ''
          ? inherited?.trim() ? 'emptyOverFilledBase' : 'emptyAndBaseEmpty'
          : own === inherited ? 'identical'
          : parseBlock(own) && own.includes(`from ${base}`) ? 'importBase'
          : variantMatchesBase(base, item.hash, lang, data) ? 'renderedLikeBase' : 'ownText';
      const counts = (row.languages[lang] ??= {});
      counts[kind] = (counts[kind] ?? 0) + 1;
      if (kind === 'emptyOverFilledBase' && empties.length < 40 && lang === 'en')
        empties.push({ hash: item.hash, name: item.name, base, type });
      if (form === 'derived') {
        // Independent export check: the converter on the stored text must equal the converter on the base text.
        const viaStored = exported(own ?? '', lang, item.hash);
        const viaBase = exported(inherited ?? '', lang, item.hash);
        if (viaStored !== viaBase) derivedExportDiffers.push({ hash: item.hash, base, lang, type });
      }
    }
    if (form === 'override') overrides.push({ hash: item.hash, name: item.name, base, type, baseName: items[base]?.name });
  }
  const finderMarks = [...bases].filter((base) => enhancedVariants(base, data).length > 0).length;
  return {
    sourceCommit: bundle.sourceCommit,
    variants,
    basesWithVariants: bases.size,
    finderMarks,
    types,
    derivedExportDiffers,
    overrides,
    emptyVariantsOverFilledBaseSample: empties,
  };
}

async function load(dir, name) {
  return JSON.parse(await readFile(join(dir, name), 'utf8'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/variant-forms/audit.mjs <dir with bundle.json items.json categories.json aliases.json>');
    process.exit(2);
  }
  const [bundle, items, categories, aliases] = await Promise.all(
    ['bundle.json', 'items.json', 'categories.json', 'aliases.json'].map((name) => load(dir, name)),
  );
  process.stdout.write(`${JSON.stringify(await audit({ bundle, items, categories, aliases }), null, 2)}\n`);
}
