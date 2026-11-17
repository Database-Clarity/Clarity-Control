import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makePlan, git, main, digest } from './cli.mjs';

const at = '2026-11-17T12:00:00.000Z';
function fixture() {
  mkdirSync('.agents/groups-adopt/tests', { recursive: true });
  const data = mkdtempSync(resolve('.agents/groups-adopt/tests/repo-'));
  git(data, ['init', '-b', 'editor-data']);
  git(data, ['config', 'core.autocrlf', 'false']);
  git(data, ['config', 'user.name', 'Offline test']);
  git(data, ['config', 'user.email', 'offline@example.invalid']);
  const put = (path, value) => {
    mkdirSync(join(data, path, '..'), { recursive: true });
    writeFileSync(
      join(data, path),
      typeof value === 'string' ? value : JSON.stringify(value) + '\n',
    );
  };
  put('config/permissions.json', { users: { 1: { login: 'alice', role: 'maintainer' } } });
  put('.publisher/PIN', { capabilities: ['aliasGroups'] });
  const tooltip = (hash) => ({
    hash,
    text: { en: { text: 'Café', updatedAt: at, updatedBy: 'alice' } },
    associated: [],
  });
  put('tooltips/42.json', JSON.stringify(tooltip(42), null, 4).replaceAll('\n', '\r\n') + '\r\n');
  put('tooltips/43.json', tooltip(43));
  git(data, ['add', '.']);
  git(data, ['commit', '-m', 'Fixture']);
  const input = {
    head: git(data, ['rev-parse', 'HEAD']).trim(),
    generatorHead: 'a'.repeat(40),
    at,
    actor: { id: 1, login: 'alice' },
    groups: [{ canonical: 43, members: [42, 43] }],
    facts: {
      items: Object.fromEntries(
        [42, 43].map((hash) => [
          hash,
          {
            hash,
            name: 'Perk',
            categoryId: 'weapon-trait',
            plugCategoryHash: 20,
            inGameDescription: 'Same',
          },
        ]),
      ),
      aliases: {},
      sandboxConflicts: {},
      categories: [{ id: 'weapon-trait' }],
    },
  };
  return { data, input, put };
}
test('explicit canonical, exact archives, staged diff, backup, and byte restore', async () => {
  const { data, input } = fixture();
  const out = join(data, '..', `plan-${Date.now()}`);
  const plan = await makePlan(data, input, out);
  const config = JSON.parse(plan.changes.find((c) => c.path === 'config/alias-groups.json').after);
  assert.deepEqual(config.groups['43'].members, [42, 43]);
  const original = readFileSync(join(data, 'tooltips/42.json'), 'utf8');
  assert.equal(plan.changes.find((c) => c.path.endsWith('/43/42.json')).after, original);
  const bytes = JSON.stringify(plan, null, 2) + '\n';
  writeFileSync(join(out, 'plan.json'), bytes);
  await main(['apply', '--data', data, '--plan', out, '--sha', digest(bytes)]);
  await main(['verify', '--data', data, '--plan', out, '--sha', digest(bytes)]);
  git(data, ['apply', '--reverse', '--index', '--binary', '-'], { input: plan.patch });
  assert.equal(git(data, ['status', '--porcelain']), '');
  assert.equal(readFileSync(join(data, 'tooltips/42.json'), 'utf8'), original);
});
test('rejects stale head, dirty clone, implicit canonical, overlap, and unauthorized actor', async () => {
  for (const change of [
    (f) => {
      f.input.head = '0'.repeat(40);
    },
    (f) => {
      f.put('untracked', 'dirty');
    },
    (f) => {
      delete f.input.groups[0].canonical;
    },
    (f) => {
      f.input.groups.push(f.input.groups[0]);
    },
    (f) => {
      f.input.actor.id = 2;
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(makePlan(f.data, f.input, join(f.data, '..', `negative-${Date.now()}`)));
  }
});
test('rejects missing locales and new resolver cycles even with conflict acknowledgement', async () => {
  for (const text of [
    { de: { text: 'Deutsch', updatedAt: at, updatedBy: 'alice' } },
    { en: { text: 'import main from 43', updatedAt: at, updatedBy: 'alice' } },
  ]) {
    const f = fixture();
    f.input.groups[0].acknowledgeConflicts = true;
    f.put('tooltips/42.json', { hash: 42, text, associated: [] });
    git(f.data, ['add', '.']);
    git(f.data, ['commit', '-m', 'Adversarial tooltip']);
    f.input.head = git(f.data, ['rev-parse', 'HEAD']).trim();
    if (text.en) f.input.groups[0].canonical = 42;
    await assert.rejects(makePlan(f.data, f.input, join(f.data, '..', `cycle-${Date.now()}`)));
  }
});
test('refuses tampered plan digest before staging', async () => {
  const f = fixture();
  const out = join(f.data, '..', `tamper-${Date.now()}`);
  const plan = await makePlan(f.data, f.input, out);
  writeFileSync(join(out, 'plan.json'), JSON.stringify(plan));
  await assert.rejects(main(['apply', '--data', f.data, '--plan', out, '--sha', '0'.repeat(64)]));
  assert.equal(git(f.data, ['status', '--porcelain']), '');
});
