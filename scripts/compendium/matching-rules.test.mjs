import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  codeRuleIds,
  sourceRuleIds,
  expectedMatchingDocument,
} from '../compendium-guidance/matching-rules.mjs';
it('documents every runtime ruleId and keeps generated maintainer decisions synchronized', async () => {
  const doc = await readFile(
    new URL('../../apps/web/src/features/compendium/MATCHING-RULES.md', import.meta.url),
    'utf8',
  );
  const ids = new Set([...doc.matchAll(/<!-- ruleId: ([a-z0-9-]+) -->/g)].map((match) => match[1]));
  const runtime = await codeRuleIds();
  expect(
    [...runtime].filter((id) => !ids.has(id)),
    'Undocumented runtime ruleIds',
  ).toEqual([]);
  expect(
    [...ids].filter((id) => !runtime.has(id)),
    'Document IDs must be real code ruleIds',
  ).toEqual([]);
  expect(doc.replaceAll('\r\n', '\n')).toBe(await expectedMatchingDocument(doc));
});
it('finds new literal, aliased, conditional and factory-supplied rule IDs', () => {
  const code = `const id = 'alias-rule'; const x = { ruleId: id }; let ruleId = 'initial-rule'; ruleId = 'assigned-rule';
    function make(category, ruleId) {} make('category', 'factory-rule');
    const y = { ruleId: ok ? 'true-rule' : 'false-rule' };`;
  expect([...sourceRuleIds(code)].sort()).toEqual([
    'alias-rule',
    'assigned-rule',
    'factory-rule',
    'false-rule',
    'initial-rule',
    'true-rule',
  ]);
});
