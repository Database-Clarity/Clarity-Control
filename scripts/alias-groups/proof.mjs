// Read-only consumer proof: DATA PLAN_DIRECTORY OUT_DIRECTORY.
// The installed publisher's exact legacy functions are exposed in an audit copy
// with only its command-line entry point removed. Never invokes publishing.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, snapshot, frozen, validator, git } from './cli.mjs';

const [data, planDir, out] = process.argv.slice(2);
if (!out) throw new Error('Expected DATA PLAN_DIRECTORY OUT_DIRECTORY');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const plan = read(join(planDir, 'plan.json'));
frozen(data, plan.input.head);
mkdirSync(out, { recursive: true });
const save = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + '\n');
const pin = JSON.parse(git(data, ['show', `${plan.input.head}:.publisher/PIN`]));
const runtime = git(data, ['show', `${plan.input.head}:.publisher/publisher.mjs`]);
if (digest(runtime) !== pin.sha256) throw new Error('Installed publisher PIN mismatch');
const footer = 'main().catch((e) => {\n  console.error(String(e));\n  process.exitCode = 1;\n});';
if (!runtime.trimEnd().endsWith(footer)) throw new Error('Unknown installed runtime entry point');
const instrumented =
  runtime.slice(0, runtime.lastIndexOf(footer)) +
  'export {exportWithInactiveMoves,buildLegacy,legacyPresets,composeAliases,publishableHash};\n';
const auditPath = resolve(out, 'installed-engine.mjs');
writeFileSync(auditPath, instrumented);
const installed = await import(pathToFileURL(auditPath));
const engine = await validator();
const before = snapshot(data, plan.input.head),
  after = { ...before };
for (const c of plan.changes) {
  if ((before[c.path] ?? null) !== c.before) throw new Error('Stale plan preimage');
  if (c.after === null) delete after[c.path];
  else after[c.path] = c.after;
}
const facts = plan.input.facts;
const identical = read('packages/export/test/fixtures/legacy-identical.json').editorData;
const catalog = Object.fromEntries(
  Object.entries(facts.items).map(([h, i]) => [
    h,
    {
      name: i.name,
      type: facts.categories.find((c) => c.id === i.categoryId)?.legacyType ?? i.categoryId,
      ...(i.itemHash === undefined ? {} : { itemHash: i.itemHash, itemName: i.itemName }),
    },
  ]),
);
function view(files) {
  const docs = Object.entries(files)
    .filter(([p]) => /^tooltips\/\d+\.json$/.test(p))
    .map(([, v]) => JSON.parse(v));
  const config = files['config/alias-groups.json']
    ? JSON.parse(files['config/alias-groups.json'])
    : undefined;
  const picks = files['config/sandbox-pointers.json']
    ? JSON.parse(files['config/sandbox-pointers.json'])
    : undefined;
  const { aliases, issues } = installed.composeAliases(
    facts.aliases,
    config,
    facts.items,
    facts.sandboxConflicts,
    picks,
  );
  if (issues.length) throw new Error(`Alias composition issues: ${JSON.stringify(issues)}`);
  const localCatalog = { ...catalog };
  for (const t of docs)
    if (t.custom) localCatalog[t.hash] = { name: t.custom.name, type: t.custom.categoryId };
  const moves = files['config/inactive.json'] ? JSON.parse(files['config/inactive.json']) : {};
  const perks = installed.exportWithInactiveMoves(
    docs.filter((t) => !aliases[t.hash] && (localCatalog[t.hash] || t.hash <= 3)),
    Date.parse(plan.input.at),
    localCatalog,
    aliases,
    moves,
  );
  return { docs, aliases, input: { perks } };
}
const A = view(before),
  B = view(after);
const diff = (a, b) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort()
    .filter((h) => JSON.stringify(a[h]) !== JSON.stringify(b[h]))
    .map((hash) => ({ hash, before: a[hash] ?? null, after: b[hash] ?? null }));
const outputs = {},
  changed = {};
let lost = 0;
for (const preset of installed.legacyPresets) {
  const bytes = [A, B].map((v) =>
    Buffer.from(installed.buildLegacy(v.input, preset, { identical })).toString('utf8'),
  );
  const rows = bytes.map((b) => JSON.parse(b));
  changed[preset] = diff(...rows);
  const missing = Object.keys(rows[0]).filter((h) => !Object.hasOwn(rows[1], h));
  lost += missing.length;
  outputs[preset] = {
    engine: 'installed publisher',
    before: digest(bytes[0]),
    after: digest(bytes[1]),
    changed: changed[preset].length,
    lost: missing,
  };
  bytes.forEach((b, i) => writeFileSync(join(out, `${preset}-${i ? 'after' : 'before'}.json`), b));
}
for (const style of engine.styles) {
  const file = engine.newStyleFile('adoption', style, {
    ...engine.defaultData(),
    categories: facts.categories.map((c) => c.id),
    sandboxPerks: facts.categories.map((c) => c.id),
    languages: engine.languages,
    keys: ['name', 'references', 'edited'],
    frameAliases: true,
  });
  const plans = [A, B].map((v) => engine.compile(v.input, file, { catalog: facts, identical }));
  changed[`v1-${style}`] = diff(plans[0].expanded, plans[1].expanded);
  outputs[`v1-${style}`] = {
    engine: 'editor format v1 engine (not installed in publisher)',
    before: digest(plans[0].bytes),
    after: digest(plans[1].bytes),
    changed: changed[`v1-${style}`].length,
  };
  plans.forEach((p, i) =>
    writeFileSync(join(out, `v1-${style}-${i ? 'after' : 'before'}.json`), p.bytes),
  );
}
const pushed = before['live/pushed.json']
  ? JSON.parse(before['live/pushed.json'])
  : read(join(data, 'live/pushed.json'));
async function review(v) {
  return Object.fromEntries(
    await Promise.all(
      v.docs.map(async (t) => {
        if (engine.resolveAlias(t.hash, v.aliases) !== t.hash) return [t.hash, 'alias'];
        if (!Object.values(t.text).some((e) => e.text.trim())) return [t.hash, 'textless'];
        const hash = await installed.publishableHash(t, v.aliases);
        const bare = await installed.publishableHash(t, {});
        return [
          t.hash,
          hash === pushed[t.hash]
            ? 'clean'
            : pushed[t.hash] === undefined
              ? 'new'
              : bare === pushed[t.hash]
                ? 'markerOnly'
                : 'pending',
        ];
      }),
    ),
  );
}
save('changed-rows.json', changed);
save('review-changes.json', diff(await review(A), await review(B)));
save('proof.json', {
  dataHead: plan.input.head,
  installedPin: pin,
  outputs,
  lost,
  installedRuntimeSha256: digest(runtime),
  instrumentationSha256: digest(instrumented),
  limitation:
    'Publisher has no format v1 compiler; v1 proof uses the editor engine. G2 install remains gated.',
});
console.log(JSON.stringify({ outputs, lost }));
if (lost) throw new Error(`STOP: ${lost} legacy rows lost`);
