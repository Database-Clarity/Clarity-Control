// Usage: DRAFTING_APP_ROOT=<app checkout/export> node stage.mjs <evidence> <isolated repo>
// Reads the pinned app's real schemas/parser. Never commits or pushes.
import { readFile, writeFile, mkdir, readdir, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { assembleDrafts } from './assemble.mjs';
import { validateDraft } from './pipeline.mjs';

const [evidenceDirectory, outputDirectory] = process.argv.slice(2);
if (!evidenceDirectory || !outputDirectory) throw Error('Evidence and isolated repo required');
const evidence = await realpath(evidenceDirectory),
  output = await realpath(outputDirectory);
const root = fileURLToPath(new URL('../../', import.meta.url));
const appRoot = process.env.DRAFTING_APP_ROOT ?? root;
const read = async (name) => JSON.parse(await readFile(path.join(evidence, name), 'utf8'));
const git = (...args) => execFileSync('git', ['-C', output, ...args], { encoding: 'utf8' }).trim();
if (
  output === (await realpath(root)) ||
  git('branch', '--show-current') !== 'editor-drafts' ||
  !/^https:\/\/github\.com\/Database-Clarity\/Live-Clarity-Database(?:\.git)?$/.test(
    git('remote', 'get-url', 'origin'),
  )
)
  throw Error('Use an isolated editor-drafts repo with the expected origin');
// A pristine branch is required. Never replace an existing owner file or draft.
if ((await readdir(output)).some((name) => name !== '.git'))
  throw Error('Output must contain only .git');
const [snapshot, census, matching, reuse, identity, approvedValidation] = await Promise.all([
  read('snapshot.json'),
  read('all-items.json'),
  read('inputs.json'),
  read('reuse.json'),
  read('kit-identity.json'),
  read('approved.validation.json'),
]);
const sourceItems = new Map(matching.items.map((item) => [item.hash, item]));
if (
  sourceItems.size !== census.length ||
  census.some((item) => {
    const original = sourceItems.get(item.hash);
    return (
      !original ||
      JSON.stringify(original.source) !== JSON.stringify(item.source) ||
      original.sourceCommit !== item.sourceCommit ||
      original.name !== item.name ||
      original.category !== item.category
    );
  })
)
  throw Error('Enriched census differs from original matcher output');
const batches = [];
const postReviewExclusions = await read('post-review-exclusions.json');
const state = await read('state.json');
for (const id of [
  ...state.carryReviews.map((row) => row.id),
  ...state.batches.map((row) => `batch-${row.id}`),
]) {
  const carry = id.startsWith('carry-');
  const [input, bytes, critique] = await Promise.all([
    read(carry ? `${id}.input.json` : `${id}.json`),
    readFile(path.join(evidence, carry ? `${id}.drafts.json` : `out/${id}.json`)),
    read(`${id}.critique.json`),
  ]);
  const validation = carry
    ? {
        accepted: Object.fromEntries(
          input.items
            .filter((item) => approvedValidation.accepted[item.hash])
            .map((item) => [item.hash, approvedValidation.accepted[item.hash]]),
        ),
        errors: Object.fromEntries(
          input.items
            .filter((item) => approvedValidation.errors[item.hash])
            .map((item) => [item.hash, approvedValidation.errors[item.hash]]),
        ),
        excluded: [],
      }
    : await read(`${id.slice(-2)}.validation.json`);
  batches.push({
    input,
    bytes,
    critique,
    validation,
    postReviewExclusions: postReviewExclusions[id],
  });
}
const server = await createServer({
  root,
  configFile: false,
  resolve: { alias: { '@clarity/core': path.join(appRoot, 'packages/core/src/index.ts') } },
  server: { middlewareMode: true, hmr: false },
});
try {
  const load = (name) => server.ssrLoadModule(path.join(appRoot, name));
  const [core, loader, imports, catalog] = await Promise.all([
    load('packages/core/src/index.ts'),
    load('apps/web/src/services/editorDrafts.ts'),
    load('apps/web/src/services/tooltipImports.ts'),
    load('apps/web/src/features/navigation/catalog.ts'),
  ]);
  const editor = snapshot.editor,
    app = { ...core, ...imports };
  const knownHashes = new Set(
    [...Object.keys(editor.items), ...Object.keys(editor.bundle.tooltips)]
      .map(Number)
      .filter((hash) => catalog.canonicalHash(hash, editor) === hash),
  );
  for (const item of census) {
    if (
      item.baseExotic &&
      editor.bundle.tooltips[item.baseExotic.hash]?.text.en?.text !== item.baseExotic.english
    )
      throw Error(`Parent wording differs from pinned bundle: ${item.hash}`);
    for (const proof of item.fragmentImprovements ?? []) {
      if (proof.source) {
        if (proof.source.text !== proof.sourceText || loader.sourceChanged(proof, snapshot.source))
          throw Error(`Fragment fingerprint mismatch: ${item.hash}`);
      } else {
        const rows =
          snapshot.source.tabs
            .find((tab) => tab.name === proof.sourceTab)
            ?.rows.filter(
              (row) => row.name === proof.sourceRow && row.cell.plain === proof.sourceText,
            ) ?? [];
        if (rows.length !== 1) throw Error(`Fragment row mismatch: ${item.hash}`);
      }
    }
    if (editor.bundle.tooltips[item.hash]?.text.en?.text?.trim())
      throw Error(`Existing English: ${item.hash}`);
    if (
      item.sourceCommit !== snapshot.pins.compendium ||
      loader.sourceChanged(item, snapshot.source)
    )
      throw Error(`Source fingerprint mismatch: ${item.hash}`);
  }
  const result = assembleDrafts({
    census,
    batches,
    reuse,
    guideKitSha256: identity.guideKitSha256,
    styleGuide: 'v4.12',
    createdAt: new Date().toISOString(),
    model: 'gpt-6.1-sol',
    knownHashes,
    parseDraft: (value) => loader.editorDraftSchema.parse(value),
    parseIndex: (value) => loader.editorDraftIndexSchema.parse(value),
    validate: (item, english) => validateDraft(item, english, editor, app),
  });
  const files = new Map([
    ['index.json', result.index],
    ...result.drafts.map((d) => [`drafts/${d.hash}.json`, d]),
  ]);
  // Exercise the actual loader through its fetch boundary before writing files.
  loader.setEditorDraftFetch(
    async (name) =>
      new Response(JSON.stringify(files.get(name)), { status: files.has(name) ? 200 : 404 }),
  );
  const loadedIndex = await loader.editorDraftIndex();
  if (loadedIndex.size !== result.drafts.length) throw Error('Loader index mismatch');
  for (const draft of result.drafts) {
    const loaded = await loader.editorDraft(draft.hash);
    if (
      JSON.stringify(loaded) !== JSON.stringify(draft) ||
      loader.sourceChanged(loaded, snapshot.source)
    )
      throw Error(`Loader round trip failed: ${draft.hash}`);
  }
  loader.setEditorDraftFetch(undefined);
  await mkdir(path.join(output, 'drafts'));
  for (const [name, value] of files)
    await writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
  const actual = (await readdir(path.join(output, 'drafts'))).sort();
  const expected = result.drafts.map((d) => `${d.hash}.json`).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Index/file mismatch');
  const accepted = new Set(result.index.hashes),
    excluded = new Map(result.excluded.map((e) => [e.hash, e.reason]));
  const counts = Object.fromEntries(
    [...new Set(census.map((i) => i.group))].map((group) => {
      const rows = census.filter((i) => i.group === group);
      return [
        group,
        {
          eligible: rows.length,
          drafted: rows.length,
          critiquePassed: rows.filter((i) => accepted.has(i.hash)).length,
          excluded: rows.filter((i) => excluded.has(i.hash)).length,
        },
      ];
    }),
  );
  await writeFile(
    path.join(evidence, 'assembly.json'),
    JSON.stringify(
      {
        output,
        counts,
        retained: result.drafts.length,
        excluded: result.excluded,
        warnings: result.warnings,
        evidence: result.evidence,
        sourcePins: snapshot.pins,
        loaderRoundTrips: result.drafts.length,
        indexExact: true,
        pushed: false,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify(
      { output, counts, retained: result.drafts.length, excluded: result.excluded },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}
