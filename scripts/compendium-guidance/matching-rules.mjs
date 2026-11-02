import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
const root = fileURLToPath(new URL('../../', import.meta.url));
export function sourceRuleIds(code, name = 'source.ts') {
  const tree = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true);
  const bindings = new Map(),
    factories = new Map(),
    ids = new Set();
  const walk = (node, visit) => {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
  };
  walk(tree, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      bindings.set(node.name.text, node.initializer);
    if (ts.isFunctionDeclaration(node) && node.name) {
      const index = node.parameters.findIndex(
        (parameter) => parameter.name.getText(tree) === 'ruleId',
      );
      if (index >= 0) factories.set(node.name.text, index);
    }
  });
  function strings(node, seen = new Set()) {
    if (!node) return [];
    if (ts.isStringLiteralLike(node)) return node.text ? [node.text] : [];
    if (ts.isConditionalExpression(node))
      return [...strings(node.whenTrue, seen), ...strings(node.whenFalse, seen)];
    if (ts.isIdentifier(node) && bindings.has(node.text) && !seen.has(node.text))
      return strings(bindings.get(node.text), new Set([...seen, node.text]));
    if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node))
      return strings(node.expression, seen);
    return [];
  }
  const add = (expression) => strings(expression).forEach((id) => ids.add(id));
  walk(tree, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(tree).replaceAll(/['"]/g, '') === 'ruleId'
    )
      add(node.initializer);
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'ruleId')
      add(node.initializer);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(tree) === 'ruleId'
    )
      add(node.right);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      factories.has(node.expression.text)
    )
      add(node.arguments[factories.get(node.expression.text)]);
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'classifyScope')
      walk(node, (child) => {
        if (ts.isReturnStatement(child)) add(child.expression);
      });
  });
  return ids;
}
export async function codeRuleIds() {
  const ids = new Set();
  async function scan(dir) {
    for (const file of await readdir(dir, { withFileTypes: true })) {
      if (file.isDirectory()) {
        if (!['fixtures', '__tests__', '__snapshots__'].includes(file.name))
          await scan(path.join(dir, file.name));
      } else if (/\.tsx?$/.test(file.name) && !/\.test\./.test(file.name))
        for (const id of sourceRuleIds(
          await readFile(path.join(dir, file.name), 'utf8'),
          file.name,
        ))
          ids.add(id);
    }
  }
  const decisions = path.join(root, 'apps/web/src/features/compendium');
  function dataIds(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.ruleId === 'string') ids.add(value.ruleId);
    for (const entry of Object.values(value)) dataIds(entry);
  }
  for (const file of await readdir(decisions))
    if (/^owner-.*\.json$/.test(file))
      dataIds(JSON.parse(await readFile(path.join(decisions, file), 'utf8')));
  await scan(path.join(root, 'apps/web/src/features/compendium'));
  await scan(path.join(root, 'packages/core/src/compendium'));
  return ids;
}

const clean = (value) =>
  String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll(/\r?\n/g, ' / ');
export async function decisionDocumentation() {
  const read = async (file) => JSON.parse(await readFile(path.join(root, file), 'utf8'));
  const triage = await read('apps/web/src/features/compendium/owner-triage.json');
  const reviewed = await read('apps/web/src/features/compendium/owner-reviewed.json');
  const exceptions = await read('apps/web/src/features/compendium/owner-exceptions.json');
  const pass3 = await read('packages/core/src/compendium/reviewed-rules.json');
  const nodes = await read('packages/core/src/compendium/reviewed-nodes.json');
  const config = await readFile(path.join(root, 'packages/core/src/compendium/config.ts'), 'utf8');
  const manifest = await readFile(path.join(root, 'apps/web/src/features/compendium/manifestRule.ts'), 'utf8');
  function declaredStrings(code, name) {
    const tree = ts.createSourceFile('registry.ts', code, ts.ScriptTarget.Latest, true);
    let result = [];
    function visit(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) {
        function collect(child) {
          if (ts.isStringLiteralLike(child)) result.push(child.text);
          else ts.forEachChild(child, collect);
        }
        if (node.initializer) collect(node.initializer);
      } else ts.forEachChild(node, visit);
    }
    visit(tree);
    return result;
  }
  const aliases = ['exoticSourceNames', 'catalystWeapons'].flatMap((name) => {
    const values = declaredStrings(config, name);
    return Array.from({ length: values.length / 2 }, (_, i) =>
      `| ${clean(values[i * 2])} | ${clean(values[i * 2 + 1])} | ${name}; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |`);
  });
  return [
    '<!-- BEGIN GENERATED OWNER DECISIONS -->',
    '## Maintainer decisions and exceptions (generated)',
    '',
    'Source: finalized `owner-triage.json` (2026-11-02), not superseded chronological proposals. The original 27 guided negatives are preserved. Run `node scripts/compendium-guidance/matching-rules.mjs` after changing authoritative data.',
    '',
    '### Final triage — every member',
    '',
    '| Hash | Item | Original category | Decision / group | Date/source |',
    '|---|---|---|---|---|',
    ...triage.members.map(
      (record) =>
        `| ${record.hash} | ${clean(record.name)} | ${record.categoryId} | ${record.disposition}; ${record.ruleId}; group ${record.group} | 2026-11-02, finalized triage |`,
    ),
    '',
    '### Earlier explicit parent/exclusion exceptions',
    '',
    '| Hash | Item | Decision | Date/source |',
    '|---|---|---|---|',
    ...Object.entries(exceptions.exoticStats).map(
      ([hash, name]) =>
        `| ${hash} | ${name} | Parent exotic link retained; stat-only tooltip exclusion; exact hash/name/category exception, never a general parent-only promotion | ${exceptions.date}, ROOT decision 3 |`,
    ),
    ...Object.entries(exceptions.absentArtifacts).map(
      ([hash, name]) =>
        `| ${hash} | ${name} | Excluded only while no current parent/named source; reason: not in a current artifact | ${exceptions.date}, ROOT decision 1 |`,
    ),
    '',
    '### Tentative no-equivalent decisions',
    '',
    'Only the original named decision-7 set (superseded Coils investigations removed) and explicit finalized triage negatives remain below. A changed full-sheet or entry fingerprint reopens them; no absence/blank-text inference.',
    '',
    '| Hash | Item | Rule ID | Date/source |',
    '|---|---|---|---|',
    ...reviewed.noEquivalent.map(
      (record) =>
        `| ${record.hash} | ${clean(record.name)} | owner-tentative-no-equivalent | 2026-11-02, ${record.bucket === 'explicit-finalized-triage' ? 'finalized triage' : 'ROOT decision 7, explicitly named item'} |`,
    ),
    '',
    '### Individually reviewed item/group-specific source rules',
    '',
    '| Hash | Item | Source/group definition | Decision/evidence | Date/source |',
    '|---|---|---|---|---|',
    ...Object.values(reviewed.verified).map(
      (record) =>
        `| ${record.hash} | ${record.name} | gid ${record.gid}; ${record.rows.map((row) => `${clean(row.name)} (observed r${row.rowIndex}c${row.anchor.col})`).join('; ')} | ${record.ruleId}: ${clean(record.meaning)}; complete styled row-set evidence, relocation allowed, new/changed members withheld | ${reviewed.reviewedAt}, ROOT pass3/follow-up cell review |`,
    ),
    '',
    '### Original guided no-equivalent population (unchanged)',
    '',
    ...triage.legacyNoEquivalent.map(
      (record) =>
        `- ${record.hash}: ${clean(record.name)} — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.`,
    ),
    '',
    '### Guided reference snapshot',
    '',
    `Frozen baseline: ${triage.guidedBaseline}. Runtime references additionally require current membership, baseline and entry/source evidence. A stale/skipped/note-only reference does not approve a mapping.`,
    '',
    '| Hash | Item/category | Decision/source | Note | Date |',
    '|---|---|---|---|---|',
    ...triage.guidedReferences.map(
      (record) =>
        `| ${record.hash} | ${clean(record.name)} / ${record.categoryId} | ${record.decision}${record.link ? `; gid ${record.link.gid}, ${clean(record.link.rowKey)}, ${clean(record.link.section)}; cells ${JSON.stringify(record.link.cells ?? [])}; parts ${clean(JSON.stringify(record.link.parts ?? []))}` : ''} | ${clean(record.note)} | ${record.date} |`,
    ),
    ...triage.guidedComments.map(
      (record) =>
        `\nCategory ${record.categoryId}, frozen ${record.memberCount} members: ${clean(record.comment)}`,
    ),
    '',
    '### Inherited narrow source-name conventions (generated from code)',
    '',
    'Every mapping below is an existing candidate-name convention, not a new semantic approval. Category/source confirmation and parent identity gates still apply. Regression coverage lives in core link/resolve/config suites and frozen catalyst/refit examples; wrong categories, shared generic perks and unsupported parents remain counterexamples.',
    '',
    '| Item/group | Candidate source name | Runtime rule family | Date/source |',
    '|---|---|---|---|',
    ...aliases,
    '',
    '### Inherited stat-description exceptions (generated from code)',
    '',
    'manifest-weapon-stat uses the following exact descriptive lead-in group, plus stat-only bullets and manifest/socket evidence. A matching lead-in alone never excludes an effect. Source: 2026-11-01, manifestRule.ts (7908a26), earlier owner-guided stat-scope implementation. Independent conditional/effect-bearing attachment counterexamples are listed in the main rule table; unknown lead-ins reject.',
    '',
    ...declaredStrings(manifest, 'statLeadIns').map((text) => `- ${clean(text)}`),
    '',
    '### Core pass3 reviewed source registry',
    '',
    'These are guarded template/import-closure rules, not generic parent-card approval. The registry hashes, rule values and dependency sets below are generated directly from the data consumed by core.',
    '',
    '| Hash | Item/category | Source rule | Destination/dependencies | Date/source |',
    '|---|---|---|---|---|',
    ...Object.entries(pass3).map(
      ([hash, record]) =>
        `| ${hash} | ${clean(nodes[hash]?.name)} / ${nodes[hash]?.category} | ${record.rule} | gid ${record.gid}, ${clean(record.rowKey)}, ${clean(record.section)}; cells ${JSON.stringify(record.cells ?? [])}; closure ${record.dependencies.join(', ')} | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |`,
    ),
    '',
    '## Withheld and unresolved investigations',
    '',
    `- Seven attachment sources: ${triage.unresolved.join(', ')}. First six need tooltips, Remote Detonation is tentative. Base/enhanced counterpart identities inherit only that same named attachment-family decision. No parent/interaction-only source substitution.`,
    '- Elemental Siphon 3619040076: Harsh Refraction and Counter Energy are distinct mechanics. Artifact/plug mapping remains unresolved; never combine solely by name.',
    '- Movement: the 53 group 6–8 members above remain optional, retained and unresolved for history/source investigation. Six sampled revisions in compendium-movement-history.json, compendium-hunter-jump-history.json and compendium-blink-history.json recovered no text; this is not proof none existed.',
    '- The Fundamentals 2620589274/3081173348, Ergo Sum Catalyst 1497627200 and general Caster Frame 183772609 retain their unresolved owner references; only frame-specific coverage can resolve sword frames.',
    '- Source changes, unsupported names, conflicting category/identity evidence, missing manifest facts, partial dependencies and ambiguous candidates retain explicit owner-review reasons rather than guessed equivalence.',
    '- Deferred to separate work: manifest-removal archive and lost-tooltip checker/recovery. Root verified 153/159 cleared texts were never human-edited manifest copies; Ricochet Rounds contained the real sharper-angle addition. Concussion, Proximity and Remote Detonation history was manifest paraphrase. No archival, resurrection or history rewriting is performed by this matcher.',
    '',
    '<!-- END GENERATED OWNER DECISIONS -->',
  ].join('\n');
}
export async function expectedMatchingDocument(current) {
  current = current.replaceAll('\r\n', '\n');
  const marker = '<!-- BEGIN GENERATED OWNER DECISIONS -->';
  return current.split(marker)[0].trimEnd() + '\n\n' + (await decisionDocumentation()) + '\n';
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--list')) console.log([...(await codeRuleIds())].sort().join('\n'));
  else {
    const file = path.join(root, 'apps/web/src/features/compendium/MATCHING-RULES.md');
    await writeFile(file, await expectedMatchingDocument(await readFile(file, 'utf8')));
  }
}
