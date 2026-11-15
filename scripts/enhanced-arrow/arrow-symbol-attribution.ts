// Read-only attribution. Reuse LINK-SAVE-3's recording proxy around the REAL
// validator/resolver; never infer dependencies from an import regexp or copied resolver.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import {
  exportLegacy,
  isLegacyAliasStub,
  languages,
  resolveAlias,
  tooltipSchema,
  validateTextWithReads,
  type Lang,
  type LegacyExportEntry,
  type MarkupGlobals,
} from '../../packages/core/src/index.js';
import { prepareMarkup } from '../../packages/core/src/markup/prepare.js';
import { readInputs, readTooltipFiles } from './exportAll.js';
import { sha256 } from '../mult-write/rewrite.js';
import type { Plan } from './plan.js';

const { values } = parseArgs({
  options: {
    data: { type: 'string' },
    inputs: { type: 'string' },
    plan: { type: 'string' },
    evidence: { type: 'string' },
  },
});
if (!values.data || !values.inputs || !values.plan || !values.evidence)
  throw new Error('Need --data, --inputs, --plan, and --evidence');
const evidence = resolve(values.evidence);
const planBytes = readFileSync(values.plan, 'utf8');
const plan = JSON.parse(planBytes) as Plan;
const classification = JSON.parse(readFileSync(join(evidence, 'classification.json'), 'utf8')) as {
  planSha256: string;
  beforeSha256: string;
  afterSha256: string;
  arrowFormOnly: boolean;
};
if (classification.planSha256 !== sha256(planBytes) || !classification.arrowFormOnly)
  throw new Error('Classification is not arrow-only on this plan');
const beforeBytes = readFileSync(join(evidence, 'clarityV2-before.json'), 'utf8');
const afterBytes = readFileSync(join(evidence, 'clarityV2-after.json'), 'utf8');
if (
  sha256(beforeBytes) !== classification.beforeSha256 ||
  sha256(afterBytes) !== classification.afterSha256
)
  throw new Error('Classified output bytes changed');
const beforeOutput = JSON.parse(beforeBytes) as Record<string, unknown>;
const afterOutput = JSON.parse(afterBytes) as Record<string, unknown>;
const changedOutputs = [...new Set([...Object.keys(beforeOutput), ...Object.keys(afterOutput)])]
  .filter((hash) => !isDeepStrictEqual(beforeOutput[hash], afterOutput[hash]))
  .sort();
const files = readTooltipFiles(resolve(values.data));
const afterFiles = { ...files };
for (const change of plan.changes) {
  if (files[change.path] !== change.before) throw new Error(`Not the before-image: ${change.path}`);
  afterFiles[change.path] = change.after;
}
const inputs = readInputs(resolve(values.inputs));
const exported = (all: Record<string, string>) =>
  exportLegacy(
    Object.values(all).map((bytes) => tooltipSchema.parse(JSON.parse(bytes))),
    Date.parse('2026-11-14T00:00:00Z'),
    inputs.facts,
    inputs.aliases,
  );
const before = exported(files);
const after = exported(afterFiles);
const rewritten = new Set(plan.changes.map(({ hash }) => hash));
const canonical = (entries: Record<string, LegacyExportEntry>, hash: string) => {
  const source = resolveAlias(Number(hash), inputs.aliases);
  const entry = entries[source];
  if (!entry || isLegacyAliasStub(entry)) throw new Error(`No canonical input for ${hash}`);
  return { source, entry };
};
const catalog = (entries: Record<string, LegacyExportEntry>, lang: Lang) =>
  Object.fromEntries(
    Object.keys(entries).map((hash) => [
      hash,
      canonical(entries, hash).entry.editor[lang]?.main ?? '',
    ]),
  );
const catalogs = {
  before: Object.fromEntries(languages.map((lang) => [lang, catalog(before, lang)])),
  after: Object.fromEntries(languages.map((lang) => [lang, catalog(after, lang)])),
};
const globalsFor = (
  side: 'before' | 'after',
  lang: Lang,
  type: string | undefined,
): MarkupGlobals => {
  const imports = catalogs[side][lang]!;
  return { variables: imports[2] ?? '', titles: imports[3] ?? '', imports, type, lang };
};
const outputs = changedOutputs.map((hash) => {
  const reads = (['before', 'after'] as const).flatMap((side) => {
    const entries = side === 'before' ? before : after;
    const { source, entry } = canonical(entries, hash);
    return languages.flatMap((lang) => {
      const text = entry.editor[lang]?.main;
      if (text === undefined) return [];
      const type = entries[hash]?.type ?? entry.type;
      const globals = globalsFor(side, lang, type);
      const { reads: observed } = validateTextWithReads(
        text,
        lang,
        globals,
        false,
        source,
        inputs.aliases,
      );
      const imports = [...observed.imports].map(([key, sourceHash]) => ({ key, sourceHash }));
      const sources = [...new Set([source, ...observed.imports.values(), 2, 3])].filter((id) =>
        rewritten.has(id),
      );
      return [
        {
          side,
          lang,
          type,
          rootSource: source,
          imports,
          variableReads: [...observed.variables],
          rewrittenSources: sources,
        },
      ];
    });
  });
  return {
    hash,
    rewrittenSources: [...new Set(reads.flatMap((row) => row.rewrittenSources))].sort(
      (a, b) => a - b,
    ),
    reads,
  };
});
const outputSet = new Set(changedOutputs);
const withoutDirectChange = plan.changes
  .filter(({ hash }) => !outputSet.has(String(hash)))
  .map((change) => {
    const hash = String(change.hash);
    const old = canonical(before, hash).entry;
    const next = canonical(after, hash).entry;
    const globalsBefore = globalsFor('before', 'en', old.type);
    const globalsAfter = globalsFor('after', 'en', next.type);
    const blocksBefore: string[] = [];
    const blocksAfter: string[] = [];
    const a = prepareMarkup(old.editor.en!.main, globalsBefore, [], (name, block) => {
      if (name === 'enhanced') blocksBefore.push(block);
    });
    const b = prepareMarkup(next.editor.en!.main, globalsAfter, [], (name, block) => {
      if (name === 'enhanced') blocksAfter.push(block);
    });
    const arrows = (text: string) => text.split('🠚').length - 1;
    const allArrowsInEnhancedBlocks =
      blocksBefore.reduce((n, block) => n + arrows(block), 0) === arrows(old.editor.en!.main);
    const blocksOnlyArrowChanges = isDeepStrictEqual(
      blocksBefore.map((block) => block.replaceAll('🠚', '<arrow/>')),
      blocksAfter,
    );
    const ownPreparedTextIdentical = a.text === b.text;
    const importers = outputs
      .filter((output) => output.rewrittenSources.includes(change.hash))
      .map((output) => output.hash);
    const explained =
      old.type !== 'Weapon Trait Enhanced' &&
      allArrowsInEnhancedBlocks &&
      blocksOnlyArrowChanges &&
      ownPreparedTextIdentical &&
      importers.length > 0;
    return {
      hash,
      type: old.type,
      reason: explained
        ? 'All rewritten arrows are inside enhanced condition blocks, removed from this base-type output by the real prepareMarkup; enhanced importers below emit the changed symbol.'
        : 'UNEXPLAINED',
      allArrowsInEnhancedBlocks,
      blocksOnlyArrowChanges,
      ownPreparedTextIdentical,
      changedOutputHashes: importers,
      conditionBlocksBefore: blocksBefore,
      conditionBlocksAfter: blocksAfter,
      explained,
    };
  });
const unexplainedOutputs = outputs
  .filter((row) => !row.rewrittenSources.length)
  .map(({ hash }) => hash);
const unexplainedSources = withoutDirectChange
  .filter((row) => !row.explained)
  .map(({ hash }) => hash);
const result = {
  planSha256: sha256(planBytes),
  resolver:
    'validateTextWithReads (LINK-SAVE-3 recording proxy) + real prepareMarkup condition callback',
  outputs,
  withoutDirectChange,
  unexplainedOutputs,
  unexplainedSources,
  allExplained: !unexplainedOutputs.length && !unexplainedSources.length,
};
writeFileSync(join(evidence, 'attribution.json'), `${JSON.stringify(result, null, 1)}\n`, {
  flag: 'wx',
});
console.log(
  JSON.stringify(
    {
      planSha256: result.planSha256,
      changedOutputs: outputs.length,
      sourcesWithoutDirectChange: withoutDirectChange.length,
      unexplainedOutputs,
      unexplainedSources,
      allExplained: result.allExplained,
    },
    null,
    1,
  ),
);
if (!result.allExplained) process.exitCode = 1;
