import { expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { publishDependencies } from './publishDependencies';
const t = (hash: number, text: string): Tooltip => ({
  hash,
  text: { en: { text, updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'alice' } },
  associated: [],
});
it('observes exact, nested, alias, and cyclic imports through the real resolver', () => {
  const tooltips = Object.fromEntries(
    [
      t(1209885908, 'import main from 2152442764'),
      t(2152442764, 'import main from 300'),
      t(300, 'Resolved'),
      t(400, 'import main from 500'),
      t(500, 'import main from 400'),
    ].map((t) => [t.hash, t]),
  );
  const pending = new Set(Object.values(tooltips).map((t) => t.hash));
  const deps = publishDependencies(tooltips, {}, pending, Object.values(tooltips));
  expect(deps.get(1209885908)).toContain(2152442764);
  expect(deps.get(1209885908)).toContain(300);
  expect(deps.get(400)).toContain(500);
  const alias = t(600, 'import main from 700');
  expect(
    publishDependencies({ ...tooltips, 600: alias }, { 700: { to: 300, kind: 'name' } }, pending, [
      alias,
    ]).get(600),
  ).toContain(300);
});
it('orders pending global libraries and observes imports inside a global title', () => {
  const consumer = t(100, '<title Info [Tip] />');
  const titles = t(3, 'title Tip (\nimport main from 200\n)');
  const target = t(200, 'Resolved');
  const deps = publishDependencies(
    { 100: consumer, 3: titles, 200: target },
    {},
    new Set([3, 200]),
    [consumer],
  );
  expect(deps.get(100)).toContain(3);
  expect(deps.get(100)).toContain(200);
});
